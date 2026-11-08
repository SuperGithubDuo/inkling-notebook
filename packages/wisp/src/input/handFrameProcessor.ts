/**
 * Turns one hand-tracking result into stroke-engine input:
 *   landmarks ─► pen point (camera space) ─► page position (mapping)
 *             └► pinch ratio ─► GestureStateMachine ─► engine.input / engine.end
 *
 * Pure with respect to the browser: no camera, no MediaPipe, no DOM. That is
 * what lets the webcam path be tested with synthetic landmarks.
 */
import { GestureStateMachine, type GestureAction, type GestureConfig, type GestureState } from '../gestures/gestureState'
import { pinchThresholds } from '../gestures/pinchDetector'
import type { PenPoint } from '../core/settings'
import { applySensitivity, cameraToPage, defaultRegion, type WritingRegion } from '../strokes/coordinates'
import type { StrokeEngine } from '../strokes/strokeEngine'
import type { NormPoint } from '../strokes/types'
import { DEFAULT_DEPTH_WEIGHT, LM, handPose, pinchRatio, pinchRatio3D, validLandmarks, type HandPose, type Landmark } from '../tracking/landmarks'

export interface ProcessorConfig {
  mirror: boolean
  writingSensitivity: number
  /** 0.5–2: how easily a pinch starts a stroke. */
  pinchSensitivity: number
  /** 0.5–2: how small/slow a finger opening lifts the pen. */
  releaseSensitivity: number
  penPoint: PenPoint
  /**
   * Which pinch distance drives pen-down / pen-up (v0.1.3):
   *  'auto' (default) – orientation-weighted blend: the 2D ratio while the
   *                    fingers lie across the image (where the camera sees the
   *                    gap directly), shifting to the 3D ratio as the fingers
   *                    tip toward the camera or the palm turns edge-on (where
   *                    the 2D ratio is foreshortened). See blendWeight3D.
   *  '3d'            – always the world-landmark ratio (normalized by the 3D palm size).
   *  '2d'            – image landmarks only (v0.1–v0.1.2 behaviour).
   * Frames without usable world landmarks always use 2D.
   */
  pinchMetric?: 'auto' | '3d' | '2d'
  /** Weight of landmark depth (z) in the pinch distance; default DEFAULT_DEPTH_WEIGHT. */
  depthWeight?: number
  /** Calibrated region (view space) or null for the automatic default. */
  region: WritingRegion | null
  /** Logical page aspect ratio (width / height). */
  pageAspect: number
}

export interface FrameInput {
  t: number
  landmarks: Landmark[] | null
  /** MediaPipe world landmarks (metres, hand-centred, camera-aligned axes), if available. */
  world?: Landmark[] | null
  confidence: number
  videoAspect: number
}

export interface FrameOutput {
  gesture: GestureState
  /** Smoothed pinch ratio (as used by the gesture logic). */
  pinchRatio: number | null
  /** Unsmoothed pinch ratio this frame (the one the gesture logic used). */
  rawRatio: number | null
  /** Both measurements, for diagnostics and traces. */
  ratio2D: number | null
  ratio3D: number | null
  /** Hand orientation and tracking quality from world landmarks (null without them). */
  pose: HandPose | null
  /** View-space pen point (for calibration and overlays), null if no hand. */
  viewPoint: NormPoint | null
  /** Raw page-space pen point (before smoothing), null if no hand. */
  pagePoint: NormPoint | null
  actions: GestureAction[]
}

/**
 * The virtual pen tip in camera space.
 *
 * 'midpoint' (default since v0.1.1): halfway between the thumb tip and the
 * index tip — the contact point where a pen would be held. While pinched the
 * two tips touch, so this IS the pen point; it is also steadier than either
 * tip alone because their independent jitter partly averages out.
 *
 * We filter this midpoint (one filter, in the stroke engine), rather than
 * filtering each tip separately and averaging. The two are nearly the same
 * for a linear filter, but One Euro adapts to speed: as the fingers close,
 * each tip moves fast toward the other while the midpoint barely moves, so
 * per-tip filters would loosen exactly when we want them tight.
 */
export function penPointOf(lm: readonly Landmark[], mode: PenPoint): NormPoint {
  const i = lm[LM.INDEX_TIP]!
  if (mode === 'index') return { x: i.x, y: i.y }
  const t = lm[LM.THUMB_TIP]!
  return { x: (i.x + t.x) / 2, y: (i.y + t.y) / 2 }
}

export function effectiveRegion(cfg: ProcessorConfig, videoAspect: number): WritingRegion {
  const base = cfg.region ?? defaultRegion(videoAspect, cfg.pageAspect, 0.7)
  return applySensitivity(base, cfg.writingSensitivity)
}

/**
 * How much to trust the 3D pinch ratio, 0–1, from the hand orientation.
 * 0 while the fingers lie across the image and the palm faces the camera;
 * rises to 1 as the fingers point toward the camera (along 0.4 → 0.8) or the
 * palm turns edge-on (edgeOn 0.6 → 0.95). Smooth, so the ratio never jumps.
 */
export function blendWeight3D(pose: HandPose | null): number {
  if (!pose) return 0
  const ramp = (v: number, a: number, b: number) => Math.min(1, Math.max(0, (v - a) / (b - a)))
  return Math.max(ramp(pose.along, 0.4, 0.8), ramp(pose.edgeOn, 0.6, 0.95))
}

export class HandFrameProcessor {
  readonly gestures: GestureStateMachine
  /** Weight given to the 3D pinch ratio on the last frame (diagnostics). */
  weight3D = 0
  /** When false, gestures are tracked but nothing reaches the engine (used during calibration). */
  forward = true

  constructor(
    private readonly engine: StrokeEngine,
    private cfg: ProcessorConfig,
    gesture: Partial<GestureConfig> = {}
  ) {
    this.gestures = new GestureStateMachine({ ...gesture, thresholds: pinchThresholds(cfg.pinchSensitivity, cfg.releaseSensitivity, gesture.thresholds) })
  }

  configure(cfg: Partial<ProcessorConfig>): void {
    this.cfg = { ...this.cfg, ...cfg }
    this.gestures.configure({ thresholds: pinchThresholds(this.cfg.pinchSensitivity, this.cfg.releaseSensitivity) })
  }

  get config(): ProcessorConfig {
    return this.cfg
  }

  process(f: FrameInput): FrameOutput {
    let ratio: number | null = null
    let ratio2D: number | null = null
    let ratio3D: number | null = null
    let pose: HandPose | null = null
    let viewPoint: NormPoint | null = null
    let hand = null
    if (validLandmarks(f.landmarks)) {
      ratio2D = pinchRatio(f.landmarks, f.videoAspect, this.cfg.depthWeight ?? DEFAULT_DEPTH_WEIGHT)
      ratio3D = pinchRatio3D(f.world)
      pose = handPose(f.world)
      const metric = this.cfg.pinchMetric ?? 'auto'
      const w3 = ratio3D === null || ratio2D === null || metric === '2d' ? 0 : metric === '3d' ? 1 : blendWeight3D(pose)
      this.weight3D = w3
      ratio = ratio2D === null ? ratio3D : w3 === 0 ? ratio2D : w3 * ratio3D! + (1 - w3) * ratio2D
      const cam = penPointOf(f.landmarks, this.cfg.penPoint)
      viewPoint = { x: this.cfg.mirror ? 1 - cam.x : cam.x, y: cam.y }
      const page = cameraToPage(cam, { mirror: this.cfg.mirror, region: effectiveRegion(this.cfg, f.videoAspect) })
      if (page) hand = { x: page.x, y: page.y, pinchRatio: ratio, confidence: f.confidence }
    }
    const actions = this.gestures.update({ t: f.t, hand })
    if (this.forward) this.apply(actions, f.t)
    return { gesture: this.gestures.state, pinchRatio: this.gestures.ratio ?? ratio, rawRatio: ratio, ratio2D, ratio3D, pose, viewPoint, pagePoint: hand ? { x: hand.x, y: hand.y } : null, actions }
  }

  /** Ends any active stroke (camera stopped, mode switched). */
  reset(t: number): void {
    this.apply(this.gestures.reset(), t)
    this.engine.hideCursor(t)
  }

  private apply(actions: GestureAction[], t: number): void {
    for (const a of actions) {
      switch (a.type) {
        case 'sample':
          this.engine.input({ x: a.sample.x, y: a.sample.y, t: a.sample.t, confidence: a.sample.confidence, source: 'webcam' }, a.sample.down)
          break
        case 'end':
          this.engine.end(a.reason, a.trimAfter)
          break
        case 'state':
          this.engine.events.emit('gestureChange', { from: a.from, to: a.to, t })
          break
        case 'tracking-lost': {
          this.engine.hideCursor(t)
          const endedStroke = actions.some((x) => x.type === 'end' && x.reason === 'lost')
          this.engine.events.emit('trackingLost', { t, endedStroke })
          break
        }
      }
    }
  }
}
