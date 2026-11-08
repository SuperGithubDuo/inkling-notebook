/**
 * Gesture state machine: turns per-frame hand observations into pen-down /
 * pen-up decisions, with debouncing and accidental-gesture suppression.
 *
 *            pinch (needs open→closed transition, hand stable)
 *   hover ───────────────────────────────► pinch-pending ──(enterFrames)──► writing
 *     ▲  ◄──────── bounce (opened again) ─────────┘                          │  ▲
 *     │                                                         open         │  │ closed again
 *     └───────────────(exitFrames)─────────────── release-pending ◄──────────┘──┘
 *
 *   writing ── hand missing ──► lost ──(> lostGraceMs)──► no-hand (stroke ended)
 *                                └── hand back, still pinched ──► writing
 *
 * Debounce without losing ink: samples seen while pending are buffered and
 * released once the transition is decided. A confirmed pinch backdates the
 * stroke to the first pinched frame; a confirmed release drops the frames
 * where the fingers were already separating (they usually add a hook).
 */
import { PinchDetector, type PinchThresholds, DEFAULT_PINCH } from './pinchDetector'

export type GestureState = 'no-hand' | 'hover' | 'pinch-pending' | 'writing' | 'release-pending' | 'lost'

export interface HandObservation {
  /** Page-normalized cursor position (index fingertip after mapping). */
  x: number
  y: number
  /** Thumb–index ÷ palm ratio, null if not measurable this frame. */
  pinchRatio: number | null
  /** 0–1 */
  confidence: number
}

export interface GestureFrame {
  t: number
  hand: HandObservation | null
}

export interface GestureSample {
  x: number
  y: number
  t: number
  confidence: number
  down: boolean
}

export type GestureAction =
  | { type: 'sample'; sample: GestureSample }
  | { type: 'end'; reason: 'released' | 'lost' }
  | { type: 'state'; from: GestureState; to: GestureState }
  | { type: 'tracking-lost' }

export interface GestureConfig {
  thresholds: PinchThresholds
  /** Consecutive pinched frames needed to start writing. */
  enterFrames: number
  /** Consecutive open frames needed to stop writing. */
  exitFrames: number
  /** A hand must be visible this many frames before a pinch may start. */
  minHandFrames: number
  /** Below this confidence a frame counts as "no hand". */
  minConfidence: number
  /** How long a writing hand may vanish before the stroke is ended. */
  lostGraceMs: number
}

export const DEFAULT_GESTURE: GestureConfig = {
  thresholds: DEFAULT_PINCH,
  enterFrames: 2,
  exitFrames: 2,
  minHandFrames: 3,
  minConfidence: 0.5,
  lostGraceMs: 160
}

export class GestureStateMachine {
  private cfg: GestureConfig
  private readonly pinch: PinchDetector
  private s: GestureState = 'no-hand'
  private handFrames = 0
  /** Saw the hand open since it appeared: a pinch must be a real close, not a hand entering already pinched. */
  private sawOpen = false
  private pending: GestureSample[] = []
  private lastSeenT = 0

  constructor(cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE, ...cfg }
    this.pinch = new PinchDetector(this.cfg.thresholds)
  }

  get state(): GestureState {
    return this.s
  }

  get isWriting(): boolean {
    return this.s === 'writing' || this.s === 'release-pending' || this.s === 'lost'
  }

  configure(cfg: Partial<GestureConfig>): void {
    this.cfg = { ...this.cfg, ...cfg }
    this.pinch.setThresholds(this.cfg.thresholds)
  }

  /** Processes one video frame and returns the resulting actions, in order. */
  update(frame: GestureFrame): GestureAction[] {
    const out: GestureAction[] = []
    const hand = frame.hand
    const valid =
      hand !== null &&
      Number.isFinite(hand.x) &&
      Number.isFinite(hand.y) &&
      Number.isFinite(hand.confidence) &&
      hand.confidence >= this.cfg.minConfidence

    if (!valid) {
      this.onMissing(frame.t, out)
      return out
    }
    this.lastSeenT = frame.t
    this.handFrames++
    const pinched = this.pinch.update(hand.pinchRatio)
    const sample: GestureSample = { x: hand.x, y: hand.y, t: frame.t, confidence: hand.confidence, down: false }

    switch (this.s) {
      case 'no-hand':
        this.go('hover', out)
        this.hover(sample, pinched, out)
        break
      case 'hover':
        this.hover(sample, pinched, out)
        break
      case 'pinch-pending':
        if (pinched) {
          this.pending.push(sample)
          if (this.pending.length >= this.cfg.enterFrames) {
            this.flush(true, out)
            this.go('writing', out)
          }
        } else {
          // Bounce: it was noise. Release the buffered frames as cursor moves.
          this.flush(false, out)
          this.go('hover', out)
          this.sawOpen = true
          out.push({ type: 'sample', sample })
        }
        break
      case 'writing':
        if (pinched) out.push({ type: 'sample', sample: { ...sample, down: true } })
        else this.startRelease(sample, out)
        break
      case 'release-pending':
        if (!pinched) {
          this.pending.push(sample)
          if (this.pending.length >= this.cfg.exitFrames) {
            out.push({ type: 'end', reason: 'released' })
            this.flush(false, out)
            this.go('hover', out)
            this.sawOpen = true
          }
        } else {
          this.flush(true, out)
          this.go('writing', out)
          out.push({ type: 'sample', sample: { ...sample, down: true } })
        }
        break
      case 'lost':
        if (pinched) {
          this.go('writing', out)
          out.push({ type: 'sample', sample: { ...sample, down: true } })
        } else {
          out.push({ type: 'end', reason: 'released' })
          this.go('hover', out)
          this.sawOpen = true
          out.push({ type: 'sample', sample })
        }
        break
    }
    return out
  }

  /** Forces the pen up (e.g. webcam switched off). */
  reset(): GestureAction[] {
    const out: GestureAction[] = []
    if (this.isWriting) out.push({ type: 'end', reason: 'lost' })
    this.pending = []
    this.pinch.reset()
    this.handFrames = 0
    this.sawOpen = false
    if (this.s !== 'no-hand') this.go('no-hand', out)
    return out
  }

  private hover(sample: GestureSample, pinched: boolean, out: GestureAction[]): void {
    if (!pinched) {
      this.sawOpen = true
      out.push({ type: 'sample', sample })
      return
    }
    if (this.sawOpen && this.handFrames >= this.cfg.minHandFrames) {
      this.go('pinch-pending', out)
      this.pending = [sample]
      if (this.pending.length >= this.cfg.enterFrames) {
        this.flush(true, out)
        this.go('writing', out)
      }
      return
    }
    // Pinched, but not allowed to write yet: just move the cursor.
    out.push({ type: 'sample', sample })
  }

  private startRelease(sample: GestureSample, out: GestureAction[]): void {
    this.go('release-pending', out)
    this.pending = [sample]
    if (this.pending.length >= this.cfg.exitFrames) {
      out.push({ type: 'end', reason: 'released' })
      this.flush(false, out)
      this.go('hover', out)
      this.sawOpen = true
    }
  }

  private onMissing(t: number, out: GestureAction[]): void {
    this.handFrames = 0
    switch (this.s) {
      case 'no-hand':
        return
      case 'writing':
        this.go('lost', out)
        return
      case 'lost':
        if (t - this.lastSeenT > this.cfg.lostGraceMs) {
          out.push({ type: 'end', reason: 'lost' })
          this.toNoHand(out)
        }
        return
      case 'release-pending':
        // The pinch was opening when the hand vanished: end the stroke without the opening frames.
        this.pending = []
        out.push({ type: 'end', reason: 'released' })
        this.toNoHand(out)
        return
      case 'pinch-pending':
      case 'hover':
        this.pending = []
        this.toNoHand(out)
        return
    }
  }

  private toNoHand(out: GestureAction[]): void {
    this.pinch.reset()
    this.sawOpen = false
    this.go('no-hand', out)
    out.push({ type: 'tracking-lost' })
  }

  private flush(down: boolean, out: GestureAction[]): void {
    for (const s of this.pending) out.push({ type: 'sample', sample: { ...s, down } })
    this.pending = []
  }

  private go(to: GestureState, out: GestureAction[]): void {
    if (to === this.s) return
    out.push({ type: 'state', from: this.s, to })
    this.s = to
  }
}

export { DEFAULT_PINCH }
