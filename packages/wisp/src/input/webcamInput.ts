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
import { HandFrameProcessor, effectiveRegion, type ProcessorConfig } from './handFrameProcessor'
import type { GestureState } from '../gestures/gestureState'

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
  pinchRatio: number | null
  frames: number
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

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
  cancelVideoFrameCallback?: (h: number) => void
}

export class WebcamInput {
  readonly events = new Emitter<WebcamEvents>()
  readonly processor: HandFrameProcessor
  readonly diagnostics: WebcamDiagnostics = { fps: 0, inferenceMs: 0, handDetected: false, gesture: 'no-hand', pinchRatio: null, frames: 0 }
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
  private calib: { corners: NormPoint[]; resolve: (r: WritingRegion | null) => void } | null = null
  private disposed = false

  constructor(
    private readonly video: HTMLVideoElement,
    engine: StrokeEngine,
    cfg: ProcessorConfig
  ) {
    this.processor = new HandFrameProcessor(engine, cfg)
    this.overlay.mirror = cfg.mirror
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

  /** Starts camera and tracking. Safe to call repeatedly; concurrent calls collapse. */
  async start(): Promise<void> {
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
      const tick = (): void => {
        if (this.loopKind !== 'rvfc') return
        this.onFrame()
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
  }

  private onFrame(): void {
    const tracker = this.tracker
    const cam = this.camera
    if (!tracker || !cam || this.video.readyState < 2) return
    const t = performance.now()
    let result
    try {
      result = tracker.detect(this.video, t)
    } catch (err) {
      // A single failed inference (e.g. GPU context hiccup) counts as "no hand".
      console.warn('[wisp] inference failed', err)
      result = { landmarks: null, confidence: 0, handedness: null, inferenceMs: 0 }
    }
    const videoAspect = (this.video.videoWidth || cam.width) / (this.video.videoHeight || cam.height)
    const out = this.processor.process({ t, landmarks: result.landmarks, confidence: result.confidence, videoAspect })

    // Diagnostics (cheap, read by the UI on its own timer).
    this.frameTimes.push(t)
    while (this.frameTimes.length && t - this.frameTimes[0]! > 1000) this.frameTimes.shift()
    const d = this.diagnostics
    d.fps = this.frameTimes.length
    d.inferenceMs = d.frames === 0 ? result.inferenceMs : d.inferenceMs * 0.9 + result.inferenceMs * 0.1
    d.handDetected = result.landmarks !== null
    d.gesture = out.gesture
    d.pinchRatio = out.pinchRatio
    d.frames++
    this.overlay.landmarks = result.landmarks
    this.overlay.viewPoint = out.viewPoint
    this.overlay.region = effectiveRegion(this.processor.config, videoAspect)

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
