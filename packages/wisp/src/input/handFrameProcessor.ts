/**
 * Turns one hand-tracking result into stroke-engine input:
 *   landmarks ─► pen point (camera space) ─► page position (mapping)
 *             └► pinch ratio ─► GestureStateMachine ─► engine.input / engine.end
 *
 * Pure with respect to the browser: no camera, no MediaPipe, no DOM. That is
 * what lets the webcam path be tested with synthetic landmarks.
 */
import { GestureStateMachine, type GestureAction, type GestureState } from '../gestures/gestureState'
import { pinchThresholds } from '../gestures/pinchDetector'
import type { PenPoint } from '../core/settings'
import { applySensitivity, cameraToPage, defaultRegion, type WritingRegion } from '../strokes/coordinates'
import type { StrokeEngine } from '../strokes/strokeEngine'
import type { NormPoint } from '../strokes/types'
import { LM, pinchRatio, validLandmarks, type Landmark } from '../tracking/landmarks'

export interface ProcessorConfig {
  mirror: boolean
  writingSensitivity: number
  pinchSensitivity: number
  penPoint: PenPoint
  /** Calibrated region (view space) or null for the automatic default. */
  region: WritingRegion | null
  /** Logical page aspect ratio (width / height). */
  pageAspect: number
}

export interface FrameInput {
  t: number
  landmarks: Landmark[] | null
  confidence: number
  videoAspect: number
}

export interface FrameOutput {
  gesture: GestureState
  pinchRatio: number | null
  /** View-space pen point (for calibration and overlays), null if no hand. */
  viewPoint: NormPoint | null
  actions: GestureAction[]
}

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

export class HandFrameProcessor {
  readonly gestures: GestureStateMachine
  /** When false, gestures are tracked but nothing reaches the engine (used during calibration). */
  forward = true

  constructor(
    private readonly engine: StrokeEngine,
    private cfg: ProcessorConfig
  ) {
    this.gestures = new GestureStateMachine({ thresholds: pinchThresholds(cfg.pinchSensitivity) })
  }

  configure(cfg: Partial<ProcessorConfig>): void {
    this.cfg = { ...this.cfg, ...cfg }
    this.gestures.configure({ thresholds: pinchThresholds(this.cfg.pinchSensitivity) })
  }

  get config(): ProcessorConfig {
    return this.cfg
  }

  process(f: FrameInput): FrameOutput {
    let ratio: number | null = null
    let viewPoint: NormPoint | null = null
    let hand = null
    if (validLandmarks(f.landmarks)) {
      ratio = pinchRatio(f.landmarks, f.videoAspect)
      const cam = penPointOf(f.landmarks, this.cfg.penPoint)
      viewPoint = { x: this.cfg.mirror ? 1 - cam.x : cam.x, y: cam.y }
      const page = cameraToPage(cam, { mirror: this.cfg.mirror, region: effectiveRegion(this.cfg, f.videoAspect) })
      if (page) hand = { x: page.x, y: page.y, pinchRatio: ratio, confidence: f.confidence }
    }
    const actions = this.gestures.update({ t: f.t, hand })
    if (this.forward) this.apply(actions, f.t)
    return { gesture: this.gestures.state, pinchRatio: ratio, viewPoint, actions }
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
        case 'end': {
          this.engine.end(a.reason)
          break
        }
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
