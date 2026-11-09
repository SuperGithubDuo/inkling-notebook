/**
 * Webcam input source: camera → MediaPipe → HandFrameProcessor → StrokeEngine.
 *
 * Processing loop:
 *  - Driven by requestVideoFrameCallback when available, so inference runs
 *    exactly once per new camera frame (no wasted inference on repeated
 *    frames). Fallback: requestAnimationFrame + a `currentTime` check.
 *  - If inference is slower than the camera, frames are skipped naturally:
 *    the callback always gets the latest frame.
 *  - It never touches React. The UI polls `diagnostics` and `overlay` at its
 *    own pace; strokes reach the renderer through engine events.
 *
 * The tracker is created once and reused across camera start/stop cycles;
 * `dispose()` releases it.
 */
import { Emitter } from '../core/emitter'
import { regionFromCorners, type WritingRegion } from '../strokes/coordinates'
import type { StrokeEngine } from '../strokes/strokeEngine'
import type { NormPoint } from '../strokes/types'
import { CameraError, cameraErrorFrom, openCamera, type CameraHandle } from '../tracking/camera'
import { HandTracker, TrackerError } from '../tracking/handTracker'
import type { Landmark } from '../tracking/landmarks'
import { HandFrameProcessor, type ProcessorConfig } from './handFrameProcessor'
import type { GestureState } from '../gestures/gestureState'
import { TraceRecorder } from '../replay/trace'

export type CameraState = 'off' | 'starting' | 'on' | 'error'
export type TrackerState = 'idle' | 'loading' | 'ready' | 'error'

export interface WebcamStatus {
  camera: CameraState
  tracker: TrackerState
  error: string | null
  delegate: 'GPU' | 'CPU' | null
  modelSource: 'local' | 'cache' | 'remote' | null
}

export interface WebcamDiagnostics {
  fps: number
  inferenceMs: number
  handDetected: boolean
  gesture: GestureState
  /** Smoothed pinch ratio. */
  pinchRatio: number | null
  /** Pinched ratio while writing (release is measured relative to this). */
  pinchBaseline: number | null
  /** Measured noise (std) of the pinch ratio; release thresholds scale up with it. */
  pinchNoise: number
  /** Share of the 3D (world-landmark) pinch ratio in the measurement driving the pen, 0–1. */
  weight3D: number | null
  /** How well this hand orientation can be tracked (from world landmarks). */
  quality: 'good' | 'reduced' | 'poor' | null
  /** Mean interval between processed camera frames (ms). */
  frameIntervalMs: number
  /** Age of the frame when processing finished: capture → pen update (ms; needs requestVideoFrameCallback). */
  frameAgeMs: number | null
  /** Frames the browser delivered that were never processed (inference too slow). */
  droppedFrames: number
  frames: number
  /** v0.1.5 stroke protection counters and measured tracking residual (palm widths). */
  guard: { dropped: number; released: number; bridged: number; splits: number; suspends: number; suppressed: number; noise: number }
}

export interface WebcamOverlay {
  landmarks: Landmark[] | null
  viewPoint: NormPoint | null
  /** Effective writing region in view space. */
  region: WritingRegion | null
  mirror: boolean
}

export type CalibrationStep = { step: 1 | 2; corner: 'top-left' | 'bottom-right' } | { step: 'done'; region: WritingRegion } | { step: 'cancelled' }

interface WebcamEvents {
  status: WebcamStatus
  calibration: CalibrationStep
}

interface FrameMeta {
  mediaTime: number
  presentedFrames?: number
  /** When the camera captured the frame (performance.now clock), if the browser reports it. */
  captureTime?: number
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (h: number) => void
}

export class WebcamInput {
  readonly events = new Emitter<WebcamEvents>()
  readonly processor: HandFrameProcessor
  readonly diagnostics: WebcamDiagnostics = { fps: 0, inferenceMs: 0, handDetected: false, gesture: 'no-hand', pinchRatio: null, pinchBaseline: null, pinchNoise: 0, weight3D: null, quality: null, frameIntervalMs: 0, frameAgeMs: null, droppedFrames: 0, frames: 0, guard: { dropped: 0, released: 0, bridged: 0, splits: 0, suspends: 0, suppressed: 0, noise: 0 } }
  /** Landmark-only trace recorder for the replay harness (never video). */
  readonly recorder = new TraceRecorder()
  readonly overlay: WebcamOverlay = { landmarks: null, viewPoint: null, region: null, mirror: true }

  private _status: WebcamStatus = { camera: 'off', tracker: 'idle', error: null, delegate: null, modelSource: null }
  private tracker: HandTracker | null = null
  private trackerPromise: Promise<HandTracker> | null = null
  private camera: CameraHandle | null = null
  private loopHandle: number | null = null
  private loopKind: 'rvfc' | 'raf' | null = null
  private lastVideoTime = -1
  private generation = 0
  private abort: AbortController | null = null
  private frameTimes: number[] = []
  private lastPresented = -1
  private lastFrameT = 0
  private calib: { corners: NormPoint[]; resolve: (r: WritingRegion | null) => void } | null = null
  private disposed = false

  /** Latest filtered pen point (for trace diagnostics). */
  private lastCursor: { x: number; y: number; down: boolean } | null = null
  private readonly unsubs: Array<() => void> = []

  constructor(
    private readonly video: HTMLVideoElement,
    engine: StrokeEngine,
    cfg: ProcessorConfig
  ) {
    this.processor = new HandFrameProcessor(engine, cfg)
    this.overlay.mirror = cfg.mirror
    // Trace diagnostics: these listeners only record while a trace is being recorded.
    this.unsubs.push(
      engine.onCursor((c) => (this.lastCursor = c)),
      engine.events.on('cursorHidden', () => (this.lastCursor = null)),
      engine.onStrokeStart((e) => this.recorder.addEvent({ t: e.stroke.startedAt, type: 'pen-down' })),
      engine.onStrokeEnd((e) => {
        this.recorder.addEvent({ t: e.stroke.endedAt, type: e.reason === 'discontinuity' ? 'split' : 'pen-up', reason: e.reason })
        this.recorder.addStroke(e.stroke)
      })
    )
  }

  get status(): WebcamStatus {
    return this._status
  }

  get running(): boolean {
    return this._status.camera === 'on' || this._status.camera === 'starting'
  }

  configure(cfg: Partial<ProcessorConfig>): void {
    this.processor.configure(cfg)
    this.overlay.mirror = this.processor.config.mirror
  }

  /** Flags a tracking error that just happened in the trace being recorded (weak label for wisp-motion). */
  markGlitch(): void {
    this.recorder.mark(this.lastFrameT || performance.now())
  }

  /** Measure the hand again for the automatic writing area ("Fit writing area"). */
  refit(): void {
    this.processor.refit()
  }

  /** Starts camera and tracking. Safe to call repeatedly; concurrent calls collapse. */
  async start(): Promise<void> {
    // A new camera session: the hand may be at a different distance, so measure it again.
    this.processor.refit()
    if (this.disposed || this.running) return
    const gen = ++this.generation
    this.abort = new AbortController()
    this.setStatus({ camera: 'starting', error: null })
    try {
      // Camera and model load in parallel; whichever fails first reports.
      const trackerP = this.ensureTracker()
      trackerP.catch(() => {}) // handled below; avoids an unhandled rejection if the camera fails first
      const camera = await openCamera(this.video, this.abort.signal)
      if (gen !== this.generation) {
        camera.stop()
        return
      }
      this.camera = camera
      camera.onEnded(() => this.handleDisconnect())
      await trackerP
      if (gen !== this.generation) return
      this.setStatus({ camera: 'on' })
      this.startLoop()
    } catch (err) {
      if (gen !== this.generation) return
      this.camera?.stop()
      this.camera = null
      if (err instanceof CameraError && err.code === 'aborted') {
        this.setStatus({ camera: 'off' })
        return
      }
      const message = err instanceof CameraError || err instanceof TrackerError ? err.message : cameraErrorFrom(err).message
      this.setStatus({ camera: 'error', error: message })
    }
  }

  /** Stops the camera and loop, ending any active stroke. Keeps the model loaded. */
  stop(): void {
    this.generation++
    this.abort?.abort()
    this.abort = null
    this.stopLoop()
    this.cancelCalibration()
    this.processor.reset(performance.now())
    this.camera?.stop()
    this.camera = null
    this.overlay.landmarks = null
    this.overlay.viewPoint = null
    this.diagnostics.handDetected = false
    this.diagnostics.fps = 0
    this.diagnostics.gesture = 'no-hand'
    this.frameTimes = []
    // Any earlier error message stays visible until the next start().
    this.setStatus({ camera: 'off' })
  }

  dispose(): void {
    this.stop()
    this.disposed = true
    this.unsubs.splice(0).forEach((u) => u())
    this.tracker?.close()
    this.tracker = null
    this.events.clear()
  }

  /**
   * Two-pinch calibration: pinch at the top-left, then the bottom-right of
   * the area you want to write in. Resolves with the region (view space) or
   * null if cancelled. No ink is drawn while calibrating.
   */
  calibrate(): Promise<WritingRegion | null> {
    this.cancelCalibration()
    this.processor.reset(performance.now())
    this.processor.forward = false
    return new Promise((resolve) => {
      this.calib = { corners: [], resolve }
      this.events.emit('calibration', { step: 1, corner: 'top-left' })
    })
  }

  cancelCalibration(): void {
    if (!this.calib) return
    const c = this.calib
    this.calib = null
    this.processor.forward = true
    c.resolve(null)
    this.events.emit('calibration', { step: 'cancelled' })
  }

  private async ensureTracker(): Promise<HandTracker> {
    if (this.tracker) return this.tracker
    if (!this.trackerPromise) {
      this.setStatus({ tracker: 'loading' })
      this.trackerPromise = HandTracker.create()
        .then((t) => {
          if (this.disposed) {
            t.close()
            throw new TrackerError('init', 'disposed')
          }
          this.tracker = t
          this.setStatus({ tracker: 'ready', delegate: t.delegate, modelSource: t.modelSource })
          return t
        })
        .catch((err) => {
          this.trackerPromise = null // allow retry
          this.setStatus({ tracker: 'error' })
          throw err
        })
    }
    return this.trackerPromise
  }

  private startLoop(): void {
    this.stopLoop()
    const v = this.video as FrameVideo
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.loopKind = 'rvfc'
      const tick = (_now: number, meta: FrameMeta): void => {
        if (this.loopKind !== 'rvfc') return
        if (meta.presentedFrames !== undefined) {
          if (this.lastPresented >= 0 && meta.presentedFrames > this.lastPresented + 1) this.diagnostics.droppedFrames += meta.presentedFrames - this.lastPresented - 1
          this.lastPresented = meta.presentedFrames
        }
        this.onFrame(meta.captureTime)
        this.loopHandle = v.requestVideoFrameCallback!(tick)
      }
      this.loopHandle = v.requestVideoFrameCallback(tick)
    } else {
      this.loopKind = 'raf'
      const tick = (): void => {
        if (this.loopKind !== 'raf') return
        if (this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime
          this.onFrame()
        }
        this.loopHandle = requestAnimationFrame(tick)
      }
      this.loopHandle = requestAnimationFrame(tick)
    }
  }

  private stopLoop(): void {
    const v = this.video as FrameVideo
    if (this.loopHandle !== null) {
      if (this.loopKind === 'rvfc') v.cancelVideoFrameCallback?.(this.loopHandle)
      else cancelAnimationFrame(this.loopHandle)
    }
    this.loopHandle = null
    this.loopKind = null
    this.lastVideoTime = -1
    this.lastPresented = -1
  }

  /**
   * One camera frame. `captureTime` (from requestVideoFrameCallback, when the
   * browser provides it) is when the camera took the picture; using it as the
   * sample time keeps stroke timing faithful to the hand's motion even when
   * processing is delayed by a variable amount (v0.1.3). Otherwise: now.
   */
  private onFrame(captureTime?: number): void {
    const tracker = this.tracker
    const cam = this.camera
    if (!tracker || !cam || this.video.readyState < 2) return
    const now = performance.now()
    const t = captureTime !== undefined && captureTime > 0 && captureTime <= now && now - captureTime < 500 && captureTime > this.lastFrameT ? captureTime : Math.max(now, this.lastFrameT + 0.1)
    let result
    try {
      result = tracker.detect(this.video, t)
    } catch (err) {
      // A single failed inference (e.g. GPU context hiccup) counts as "no hand".
      console.warn('[wisp] inference failed', err)
      result = { landmarks: null, world: null, confidence: 0, handedness: null, inferenceMs: 0 }
    }
    const videoAspect = (this.video.videoWidth || cam.width) / (this.video.videoHeight || cam.height)
    const out = this.processor.process({ t, landmarks: result.landmarks, world: result.world, confidence: result.confidence, videoAspect, handedness: result.handedness })
    const done = performance.now()

    // Diagnostics (cheap, read by the UI on its own timer).
    const interval = this.lastFrameT > 0 ? t - this.lastFrameT : 0
    this.lastFrameT = t
    this.frameTimes.push(t)
    while (this.frameTimes.length && t - this.frameTimes[0]! > 1000) this.frameTimes.shift()
    const d = this.diagnostics
    d.fps = this.frameTimes.length
    if (interval > 0 && interval < 1000) d.frameIntervalMs = d.frameIntervalMs === 0 ? interval : d.frameIntervalMs * 0.9 + interval * 0.1
    const age = captureTime !== undefined && t === captureTime ? done - captureTime : null
    d.frameAgeMs = age === null ? null : d.frameAgeMs === null ? age : d.frameAgeMs * 0.9 + age * 0.1
    d.weight3D = result.landmarks ? this.processor.weight3D : null
    d.quality = out.pose?.quality ?? null
    d.inferenceMs = d.frames === 0 ? result.inferenceMs : d.inferenceMs * 0.9 + result.inferenceMs * 0.1
    d.handDetected = result.landmarks !== null
    d.gesture = out.gesture
    d.pinchRatio = out.pinchRatio
    d.pinchBaseline = this.processor.gestures.writingBaseline
    d.pinchNoise = this.processor.gestures.ratioNoise
    d.frames++
    const gs = this.processor.guard.stats
    d.guard = { dropped: gs.dropped, released: gs.released, bridged: gs.bridged, splits: gs.splits, suspends: gs.suspends, suppressed: gs.suppressed, noise: this.processor.guard.noise }
    if (this.recorder.recording) {
      const g = this.processor.gestures
      const c = this.lastCursor
      this.recorder.add(t, result.landmarks, result.confidence, videoAspect, {
        r2: out.ratio2D,
        r3: out.ratio3D,
        n: out.pose ? out.pose.normal : null,
        q: out.pose?.quality,
        dt: interval,
        inf: result.inferenceMs,
        age: age ?? undefined,
        mid: out.pagePoint ? [out.pagePoint.x, out.pagePoint.y] : null,
        cur: c ? [c.x, c.y] : null,
        down: c?.down ? 1 : 0,
        r: out.rawRatio,
        rs: out.pinchRatio,
        b: g.writingBaseline,
        v: g.openingVelocity,
        s: out.gesture,
        g: out.guard
      }, result.world, result.handedness)
    }
    this.overlay.landmarks = result.landmarks
    this.overlay.viewPoint = out.viewPoint
    this.overlay.region = this.processor.region(videoAspect)

    if (this.calib) this.calibrationFrame(out.actions, out.viewPoint)
  }

  private calibrationFrame(actions: ReturnType<HandFrameProcessor['process']>['actions'], viewPoint: NormPoint | null): void {
    const confirmed = actions.some((a) => a.type === 'state' && a.to === 'writing')
    if (!confirmed || !viewPoint || !this.calib) return
    this.calib.corners.push(viewPoint)
    if (this.calib.corners.length === 1) {
      this.events.emit('calibration', { step: 2, corner: 'bottom-right' })
      return
    }
    const [a, b] = this.calib.corners as [NormPoint, NormPoint]
    const region = regionFromCorners(a, b)
    if (!region) {
      // Too small: start over.
      this.calib.corners = []
      this.events.emit('calibration', { step: 1, corner: 'top-left' })
      return
    }
    const c = this.calib
    this.calib = null
    this.processor.reset(performance.now())
    this.processor.forward = true
    c.resolve(region)
    this.events.emit('calibration', { step: 'done', region })
  }

  private handleDisconnect(): void {
    this.stop()
    this.setStatus({ camera: 'error', error: new CameraError('disconnected').message })
  }

  private setStatus(patch: Partial<WebcamStatus>): void {
    this._status = { ...this._status, ...patch }
    this.events.emit('status', this._status)
  }
}
