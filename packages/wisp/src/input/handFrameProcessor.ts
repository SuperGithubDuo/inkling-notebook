/**
 * Turns one hand-tracking result into stroke-engine input:
 *   landmarks ─► pen point (camera space) ─► page position (mapping)
 *             └► pinch ratio ─► GestureStateMachine ─► [ContinuityGuard] ─► engine.input / engine.end
 *
 * Pure with respect to the browser: no camera, no MediaPipe, no DOM. That is
 * what lets the webcam path be tested with synthetic landmarks.
 *
 * v0.1.5 "Smart Ink" (default; `smartInk: false` runs the exact v0.1.4 path):
 *  - The page MAPPING is frozen from the moment a pinch begins until the pen
 *    lifts. Pen positions are mapped when they are applied, with that frozen
 *    mapping, so every point of a stroke — including the frames buffered
 *    while the pinch settled — uses one coordinate frame. (v0.1.4 locked the
 *    measured hand extent at the first pen-down, AFTER that frame had been
 *    mapped with the prior extent: the first stroke of a session jumped.)
 *  - Settings that change the mapping (calibration, writing size, mirroring,
 *    pen point, Writing Assist) take effect at the next pen-up.
 *  - A calibrated writing area keeps the page's aspect ratio, so horizontal
 *    and vertical hand movement have the same gain.
 *  - Writing Assist's gain is frozen with the mapping from pinch start (v0.1.4
 *    froze it only from the first inked frame).
 *  - Every inked frame passes the continuity guard (strokes/continuity.ts):
 *    nothing is connected across tracking glitches, jumps or gaps.
 */
import { GestureStateMachine, type GestureAction, type GestureConfig, type GestureSample, type GestureState } from '../gestures/gestureState'
import { pinchThresholds } from '../gestures/pinchDetector'
import type { PenPoint } from '../core/settings'
import { applySensitivity, cameraToPage, defaultRegion, type WritingRegion } from '../strokes/coordinates'
import { ExtentTracker, PRIOR_EXTENT, ScaleTracker, fitAspect, handImageScale, measureExtent, safeRegion, zoomAboutCentre, type HandExtent } from '../strokes/writingPlane'
import { ContinuityGuard, type ContinuityConfig, type GuardVerdict, type MotionFrame } from '../strokes/continuity'
import type { StrokeEngine } from '../strokes/strokeEngine'
import type { NormPoint } from '../strokes/types'
import { DEFAULT_DEPTH_WEIGHT, LM, handPose, palmSize, pinchRatio, pinchRatio3D, validLandmarks, type HandPose, type Landmark } from '../tracking/landmarks'

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
   *  'auto'           – orientation-weighted blend: the 2D ratio while the
   *                    fingers lie across the image (where the camera sees the
   *                    gap directly), shifting to the 3D ratio as the fingers
   *                    tip toward the camera or the palm turns edge-on (where
   *                    the 2D ratio is foreshortened). See blendWeight3D.
   *  '3d'            – always the world-landmark ratio (normalized by the 3D palm size).
   *  '2d' (default)  – image landmarks only (v0.1.2 behaviour, confirmed on a real webcam).
   * Frames without usable world landmarks always use 2D.
   */
  pinchMetric?: 'auto' | '3d' | '2d'
  /** Weight of landmark depth (z) in the pinch distance; default DEFAULT_DEPTH_WEIGHT. */
  depthWeight?: number
  /** Calibrated region (view space) or null for the automatic default. */
  region: WritingRegion | null
  /**
   * Automatic default region (v0.1.4):
   *  'hand' (default) – fitted inside the area the pen can reach with the palm
   *                     still in the camera frame, measured from your hand and
   *                     then locked (fixes unreachable page edges);
   *  'centred'        – v0.1–v0.1.3: 70 % of the frame, centred.
   */
  regionFit?: 'hand' | 'centred'
  /**
   * Keep writing size steady (Writing Assist, v0.1.4): zoom the region about
   * the camera centre as the hand moves nearer or farther, so the same hand
   * movement always makes the same page movement. Needs world landmarks.
   */
  keepScale?: boolean
  /** Logical page aspect ratio (width / height). */
  pageAspect: number
  /**
   * v0.1.5 Smart Ink pipeline (default true): frozen per-stroke mapping,
   * aspect-true calibration, word-level Writing Assist gain and (with
   * `strokeProtection`) the continuity guard. false = exactly v0.1.4.
   */
  smartInk?: boolean
  /** Continuity guard (default true; needs smartInk). */
  strokeProtection?: boolean
  /** Continuity guard tuning (replay / research). */
  continuity?: Partial<ContinuityConfig>
}

export interface FrameInput {
  t: number
  landmarks: Landmark[] | null
  /** MediaPipe world landmarks (metres, hand-centred, camera-aligned axes), if available. */
  world?: Landmark[] | null
  confidence: number
  videoAspect: number
  /** Tracker handedness label ("Left" / "Right"), if available (v0.1.5: identity check). */
  handedness?: string | null
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
  /** v0.1.5: what the continuity guard did with this frame's inked sample (null if none). */
  guard: GuardVerdict | null
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

/**
 * The writing region (view space). `aspectTrue` (v0.1.5): a calibrated region
 * is reduced to the largest rectangle with the page's aspect ratio inside it,
 * so x and y have the same gain (v0.1.4 stretched the page over whatever
 * rectangle the two calibration pinches made: letters came out too tall or
 * too wide).
 */
export function effectiveRegion(cfg: ProcessorConfig, videoAspect: number, extent: HandExtent = PRIOR_EXTENT, scaleFactor = 1, aspectTrue = false): WritingRegion {
  const base = cfg.region
    ? aspectTrue
      ? fitAspect(cfg.region, videoAspect, cfg.pageAspect)
      : cfg.region
    : (cfg.regionFit ?? 'hand') === 'centred'
      ? defaultRegion(videoAspect, cfg.pageAspect, 0.7)
      : safeRegion(extent, videoAspect, cfg.pageAspect)
  const r = applySensitivity(base, cfg.writingSensitivity)
  return cfg.keepScale ? zoomAboutCentre(r, scaleFactor) : r
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

const PALM_IDX = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const

/** Kinematic description of one frame for the continuity guard (view space, frame-width units). */
export function motionFrame(t: number, lm: readonly Landmark[], pen: NormPoint, mirror: boolean, videoAspect: number, pose: HandPose | null, hand: string | null | undefined): MotionFrame {
  const ar = videoAspect > 0 ? videoAspect : 1
  const iso = (p: { x: number; y: number }): NormPoint => ({ x: mirror ? 1 - p.x : p.x, y: p.y / ar })
  let px = 0, py = 0
  for (const i of PALM_IDX) {
    const q = iso(lm[i]!)
    px += q.x / PALM_IDX.length
    py += q.y / PALM_IDX.length
  }
  return { t, q: iso(pen), palm: { x: px, y: py }, size: palmSize(lm, ar), normal: pose?.normal ?? null, hand: hand ?? null }
}

/** Gesture states during which the mapping is frozen (a pinch has begun). */
const ENGAGED: ReadonlySet<GestureState> = new Set(['pinch-pending', 'writing', 'lost'])

interface FrameRecord {
  cam: NormPoint
  motion: MotionFrame
}

interface Mapping {
  mirror: boolean
  region: WritingRegion
  penPoint: PenPoint
}

export class HandFrameProcessor {
  readonly gestures: GestureStateMachine
  /** Weight given to the 3D pinch ratio on the last frame (diagnostics). */
  weight3D = 0
  /** When false, gestures are tracked but nothing reaches the engine (used during calibration). */
  forward = true
  /** The user's hand extent around the pen (locks after ~20 hover frames, or at the first stroke). */
  readonly extent = new ExtentTracker()
  /** The hand's image scale, for Keep writing size steady. */
  readonly scale = new ScaleTracker()
  /** v0.1.5: stroke continuity protection. */
  guard: ContinuityGuard<GestureSample>

  /** Mapping in force while a pinch/stroke is in progress (v0.1.5). */
  private frozen: Mapping | null = null
  private engaged = false
  private records = new Map<number, FrameRecord>()
  private lastVerdict: GuardVerdict | null = null

  constructor(
    private readonly engine: StrokeEngine,
    private cfg: ProcessorConfig,
    gesture: Partial<GestureConfig> = {}
  ) {
    this.gestures = new GestureStateMachine({ ...gesture, thresholds: pinchThresholds(cfg.pinchSensitivity, cfg.releaseSensitivity, gesture.thresholds) })
    this.guard = new ContinuityGuard(cfg.continuity)
  }

  private get smart(): boolean {
    return this.cfg.smartInk !== false
  }

  configure(cfg: Partial<ProcessorConfig>): void {
    const regionChanged = cfg.region !== undefined && cfg.region !== this.cfg.region
    const scaleTurnedOn = cfg.keepScale === true && !this.cfg.keepScale
    const continuityChanged = cfg.continuity !== undefined && cfg.continuity !== this.cfg.continuity
    const pipelineChanged = cfg.smartInk !== undefined && (cfg.smartInk !== false) !== this.smart
    // Switching pipelines (A/B) ends any stroke here and drops Smart Ink state, so a
    // stroke is never drawn half by one pipeline and half by the other, and the
    // v0.1.4 path never inherits a frozen mapping.
    if (pipelineChanged) {
      this.engine.breakContinuity()
      this.guard.reset()
      this.frozen = null
      this.engaged = false
    }
    this.cfg = { ...this.cfg, ...cfg }
    // A new calibration, or turning the steady size on, defines the reference distance.
    if (regionChanged || scaleTurnedOn) this.setScaleReference()
    if (continuityChanged) this.guard = new ContinuityGuard(this.cfg.continuity)
    this.gestures.configure({ thresholds: pinchThresholds(this.cfg.pinchSensitivity, this.cfg.releaseSensitivity) })
  }

  get config(): ProcessorConfig {
    return this.cfg
  }

  /** Writing Assist gain in use for new strokes (diagnostics). */
  get scaleFactor(): number {
    return this.scale.factor
  }

  /** The region in use right now (view space): the frozen one while a stroke is in progress. */
  region(videoAspect: number): WritingRegion {
    return this.frozen?.region ?? this.liveRegion(videoAspect)
  }

  private liveRegion(videoAspect: number): WritingRegion {
    if (!this.smart) return effectiveRegion(this.cfg, videoAspect, this.extent.extent, this.scale.factor)
    return effectiveRegion(this.cfg, videoAspect, this.extent.provisional, this.scale.factor, true)
  }

  private setScaleReference(): void {
    this.scale.setReference()
  }

  /** Forget the measured hand and scale (camera restarted, "Fit writing area"). */
  refit(): void {
    this.extent.reset()
    this.scale.reset()
  }

  process(f: FrameInput): FrameOutput {
    return this.smart ? this.processSmart(f) : this.processLegacy(f)
  }

  /** Ends any active stroke (camera stopped, mode switched). */
  reset(t: number): void {
    this.apply(this.gestures.reset(), t)
    this.engine.hideCursor(t)
    this.guard.reset()
    this.frozen = null
    this.engaged = false
  }

  /** Pinch ratio and pose for a frame (shared by both paths). */
  private measure(f: FrameInput): { ratio: number | null; ratio2D: number | null; ratio3D: number | null; pose: HandPose | null } {
    if (!validLandmarks(f.landmarks)) return { ratio: null, ratio2D: null, ratio3D: null, pose: null }
    const ratio2D = pinchRatio(f.landmarks, f.videoAspect, this.cfg.depthWeight ?? DEFAULT_DEPTH_WEIGHT)
    const ratio3D = pinchRatio3D(f.world)
    const pose = handPose(f.world)
    const metric = this.cfg.pinchMetric ?? '2d'
    const w3 = ratio3D === null || ratio2D === null || metric === '2d' ? 0 : metric === '3d' ? 1 : blendWeight3D(pose)
    this.weight3D = w3
    const ratio = ratio2D === null ? ratio3D : w3 === 0 ? ratio2D : w3 * ratio3D! + (1 - w3) * ratio2D
    return { ratio, ratio2D, ratio3D, pose }
  }

  // ── v0.1.4 path (smartInk: false), unchanged ─────────────────────────────

  private processLegacy(f: FrameInput): FrameOutput {
    const { ratio, ratio2D, ratio3D, pose } = this.measure(f)
    let viewPoint: NormPoint | null = null
    let hand = null
    if (validLandmarks(f.landmarks)) {
      const cam = penPointOf(f.landmarks, this.cfg.penPoint)
      viewPoint = { x: this.cfg.mirror ? 1 - cam.x : cam.x, y: cam.y }
      const writing = this.gestures.isWriting
      // Learn the hand's extent and scale while the pen is up (never mid-stroke).
      if (!writing && !this.cfg.region && (this.cfg.regionFit ?? 'hand') === 'hand' && !this.extent.locked) {
        const midpoint = penPointOf(f.landmarks, 'midpoint')
        if (this.extent.add(measureExtent(f.landmarks, midpoint, this.cfg.mirror))) this.scale.setReference()
      }
      if (this.cfg.keepScale) {
        this.scale.add(f.t, handImageScale(f.landmarks, f.world, f.videoAspect), writing, pose?.normal ?? null)
        if (this.scale.reference === null && this.scale.scale !== null && (this.extent.locked || this.cfg.region || this.cfg.regionFit === 'centred')) this.scale.setReference()
      }
      const page = cameraToPage(cam, { mirror: this.cfg.mirror, region: this.region(f.videoAspect) })
      if (page) hand = { x: page.x, y: page.y, pinchRatio: ratio, confidence: f.confidence }
    }
    const actions = this.gestures.update({ t: f.t, hand })
    // The mapping must not change once writing has started: lock the extent at
    // the first pen-down with whatever has been measured so far.
    if (this.gestures.isWriting && !this.extent.locked) this.extent.lockNow()
    if (this.forward) this.applyLegacy(actions, f.t)
    return { gesture: this.gestures.state, pinchRatio: this.gestures.ratio ?? ratio, rawRatio: ratio, ratio2D, ratio3D, pose, viewPoint, pagePoint: hand ? { x: hand.x, y: hand.y } : null, actions, guard: null }
  }

  private applyLegacy(actions: GestureAction[], t: number): void {
    for (const a of actions) {
      switch (a.type) {
        case 'sample':
          this.engine.input({ x: a.sample.x, y: a.sample.y, t: a.sample.t, confidence: a.sample.confidence, source: 'webcam' }, a.sample.down)
          break
        case 'end':
          this.engine.end(a.reason, a.trimAfter)
          break
        default:
          this.applyCommon(a, actions, t)
      }
    }
  }

  // ── v0.1.5 Smart Ink path ────────────────────────────────────────────────

  private processSmart(f: FrameInput): FrameOutput {
    const { ratio, ratio2D, ratio3D, pose } = this.measure(f)
    const mapping = (): Mapping => this.frozen ?? { mirror: this.cfg.mirror, region: this.liveRegion(f.videoAspect), penPoint: this.cfg.penPoint }
    let viewPoint: NormPoint | null = null
    let hand = null
    if (validLandmarks(f.landmarks)) {
      const m0 = mapping()
      const cam = penPointOf(f.landmarks, m0.penPoint)
      viewPoint = { x: m0.mirror ? 1 - cam.x : cam.x, y: cam.y }
      // Measure the hand and its scale only while no pinch is in progress.
      if (!this.engaged && !this.cfg.region && (this.cfg.regionFit ?? 'hand') === 'hand' && !this.extent.locked) {
        const midpoint = penPointOf(f.landmarks, 'midpoint')
        if (this.extent.add(measureExtent(f.landmarks, midpoint, this.cfg.mirror))) this.setScaleReference()
      }
      if (this.cfg.keepScale) {
        this.scale.add(f.t, handImageScale(f.landmarks, f.world, f.videoAspect), this.engaged, pose?.normal ?? null)
        if (this.scale.reference === null && this.scale.scale !== null && (this.extent.locked || this.cfg.region || this.cfg.regionFit === 'centred')) this.setScaleReference()
      }
      this.records.set(f.t, { cam, motion: motionFrame(f.t, f.landmarks, cam, m0.mirror, f.videoAspect, pose, f.handedness) })
      const page = cameraToPage(cam, { mirror: m0.mirror, region: this.region(f.videoAspect) })
      if (page) hand = { x: page.x, y: page.y, pinchRatio: ratio, confidence: f.confidence }
    }
    const actions = this.gestures.update({ t: f.t, hand })
    const engagedNow = ENGAGED.has(this.gestures.state)
    if (engagedNow && !this.frozen) {
      // A pinch has begun: lock the hand extent (to exactly what the cursor showed) and freeze the mapping.
      if (!this.cfg.region && (this.cfg.regionFit ?? 'hand') === 'hand' && !this.extent.locked) this.extent.lockNow()
      this.frozen = { mirror: this.cfg.mirror, region: this.liveRegion(f.videoAspect), penPoint: this.cfg.penPoint }
    }
    this.lastVerdict = null
    if (this.forward) this.applySmart(actions, f.t, f.videoAspect)
    if (!engagedNow) this.frozen = null
    this.engaged = engagedNow
    // Frames are only needed until the gesture has emitted them (≤ a few hundred ms).
    for (const k of this.records.keys()) {
      if (k < f.t - 2000) this.records.delete(k)
      else break
    }
    let pagePoint: NormPoint | null = null
    const rec = this.records.get(f.t)
    if (rec && hand) pagePoint = cameraToPage(rec.cam, mapping())
    return { gesture: this.gestures.state, pinchRatio: this.gestures.ratio ?? ratio, rawRatio: ratio, ratio2D, ratio3D, pose, viewPoint, pagePoint: pagePoint ? { x: pagePoint.x, y: pagePoint.y } : null, actions, guard: this.lastVerdict }
  }

  private applySmart(actions: GestureAction[], t: number, videoAspect: number): void {
    const protect = this.cfg.strokeProtection !== false
    for (const a of actions) {
      switch (a.type) {
        case 'sample': {
          const rec = this.records.get(a.sample.t)
          const m = this.frozen ?? { mirror: this.cfg.mirror, region: this.liveRegion(videoAspect), penPoint: this.cfg.penPoint }
          const page = rec ? cameraToPage(rec.cam, m) : null
          const s: GestureSample = page ? { ...a.sample, x: page.x, y: page.y } : a.sample
          const input = (q: GestureSample, down: boolean) => this.engine.input({ x: q.x, y: q.y, t: q.t, confidence: q.confidence, source: 'webcam' }, down)
          if (!s.down) {
            if (rec && protect) this.guard.observe(rec.motion)
            input(s, false)
            break
          }
          if (!rec || !protect) {
            input(s, true)
            break
          }
          for (const op of this.guard.ink(rec.motion, s)) {
            if (op.op === 'ink') input(op.item, true)
            else this.engine.breakContinuity()
          }
          this.lastVerdict = this.guard.lastVerdict
          break
        }
        case 'end':
          for (const op of this.guard.penUp()) if (op.op === 'ink') this.engine.input({ x: op.item.x, y: op.item.y, t: op.item.t, confidence: op.item.confidence, source: 'webcam' }, true)
          this.engine.end(a.reason, a.trimAfter)
          break
        default:
          if (a.type === 'tracking-lost') this.guard.reset()
          this.applyCommon(a, actions, t)
      }
    }
  }

  private applyCommon(a: GestureAction, actions: GestureAction[], t: number): void {
    switch (a.type) {
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

  private apply(actions: GestureAction[], t: number): void {
    if (this.smart) this.applySmart(actions, t, 16 / 9)
    else this.applyLegacy(actions, t)
  }
}
