/**
 * Gesture state machine (v0.1.1): turns per-frame hand observations into
 * pen-down / pen-up decisions, designed around the whole writing cycle:
 *
 *   hover ──pinch closes──► pinch-pending ──closing has settled──► writing
 *     ▲            (stroke starts where the fingers stopped moving together)  │
 *     │                                                                       │
 *     └────────── fingers start to open (relative rise or fast opening) ◄─────┘
 *                 → pen lifts in the SAME frame; ink drawn after the opening
 *                   began is trimmed off the end of the stroke
 *
 *   writing ── hand missing ──► lost ──(> lostGraceMs)──► no-hand (stroke ended)
 *
 * Start is conservative, release is fast (asymmetric):
 *
 *  - START. A pinch needs `enterFrames` frames below `enter`, and ink only
 *    begins once the fingers have stopped closing (closing speed below
 *    `settleVelocity`, or after `maxSettleFrames`). While fingers close, the
 *    pen point moves with them; drawing during that motion is the start hook.
 *
 *  - RELEASE. No multi-frame debounce. The baseline is the writer's own
 *    pinched ratio while writing. The pen lifts the first frame the ratio
 *    rises `releaseRise` above it, or opens faster than `openVelocity` after
 *    rising `releaseMinRise`, or crosses `releaseAbs`. Then the stroke is
 *    trimmed back to the opening onset (the last frame still near the
 *    baseline, at most `maxTrimMs` earlier), which removes release tails.
 *
 *  - FLICKER. After a release, a new pinch needs the ratio to fall
 *    `rearmDrop` below its peak since the release, so noise around the
 *    release point can't toggle the pen down and up again.
 *
 *  - ACCIDENTS. A hand that appears already pinched can't write until it has
 *    been seen open; a hand must be visible `minHandFrames` frames first.
 */
import { DEFAULT_PINCH, PinchSignal, type PinchThresholds } from './pinchDetector'

export type GestureState = 'no-hand' | 'hover' | 'pinch-pending' | 'writing' | 'lost'

export interface HandObservation {
  /** Page-normalized pen position (raw, unsmoothed). */
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

export type EndReason = 'released' | 'lost'

export type GestureAction =
  | { type: 'sample'; sample: GestureSample }
  /** `trimAfter`: drop stroke points recorded after this time (release onset). */
  | { type: 'end'; reason: EndReason; trimAfter?: number }
  | { type: 'state'; from: GestureState; to: GestureState }
  | { type: 'tracking-lost' }

export interface GestureConfig {
  thresholds: PinchThresholds
  /** Pinched frames needed before a stroke may start. */
  enterFrames: number
  /** Closing speed (ratio/s) below which the pinch counts as settled. */
  settleVelocity: number
  /** Start anyway after this many pinched frames, even if still closing. */
  maxSettleFrames: number
  /** A hand must be visible this many frames before a pinch may start. */
  minHandFrames: number
  /** Below this confidence a frame counts as "no hand". */
  minConfidence: number
  /** How long a writing hand may vanish before the stroke is ended. */
  lostGraceMs: number
  /** Release onset: last frame within this rise of the baseline. */
  onsetRise: number
  /** Never trim more than this much ink from a stroke end. */
  maxTrimMs: number
  /** While the pinch is steady, the baseline follows the ratio at this rate per frame (EMA weight). */
  baselineFollow: number
  /**
   * Noise-adaptive release: the release thresholds are raised to at least
   * `noiseK` × the measured noise of the pinch ratio while writing, so a
   * noisy camera doesn't break strokes, while a clean one keeps the fast,
   * small-opening release. The estimate starts at `initialNoise` and is kept
   * across strokes (it describes the camera and lighting, not one stroke).
   */
  noiseK: number
  initialNoise: number
}

export const DEFAULT_GESTURE: GestureConfig = {
  thresholds: DEFAULT_PINCH,
  enterFrames: 2,
  settleVelocity: 2.0,
  maxSettleFrames: 5,
  minHandFrames: 3,
  minConfidence: 0.5,
  lostGraceMs: 160,
  onsetRise: 0.035,
  maxTrimMs: 200,
  baselineFollow: 0.05,
  noiseK: 4,
  initialNoise: 0.035
}

interface Pending {
  sample: GestureSample
  /** Smoothed ratio. */
  ratio: number
  /** Unsmoothed ratio. */
  raw: number
  /** Unsmoothed closing/opening slope (ratio/s). */
  rawVelocity: number
}

export class GestureStateMachine {
  private cfg: GestureConfig
  private readonly signal = new PinchSignal()
  private s: GestureState = 'no-hand'
  private handFrames = 0
  /** Seen clearly open since the hand appeared (or since the last release). */
  private sawOpen = false
  /** Highest ratio since the last release / hand appearance (for re-arming). */
  private openPeak = 0
  private pending: Pending[] = []
  private baseline = 0
  /** Number of samples behind the baseline estimate (its uncertainty shrinks as 1/√n). */
  private baselineN = 0
  private history: Array<{ t: number; r: number }> = []
  private lastSeenT = 0
  /** Running variance of the RAW ratio (from frame-to-frame differences) while writing. */
  private noiseVar: number
  private prevRaw: number | null = null
  private noiseSamples = 0

  constructor(cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE, ...cfg }
    this.noiseVar = this.cfg.initialNoise ** 2
  }

  /** Measured standard deviation of the raw pinch ratio while writing (diagnostics). */
  get ratioNoise(): number {
    return Math.sqrt(this.noiseVar)
  }

  get state(): GestureState {
    return this.s
  }

  get isWriting(): boolean {
    return this.s === 'writing' || this.s === 'lost'
  }

  /** Smoothed pinch ratio (for diagnostics). */
  get ratio(): number | null {
    return this.signal.value
  }

  get writingBaseline(): number | null {
    return this.isWriting ? this.baseline : null
  }

  get config(): GestureConfig {
    return this.cfg
  }

  configure(cfg: Partial<GestureConfig>): void {
    this.cfg = { ...this.cfg, ...cfg }
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
    const r = this.signal.update(frame.t, hand.pinchRatio)
    const v = this.signal.velocity
    const rv = this.signal.rawVelocity
    const sample: GestureSample = { x: hand.x, y: hand.y, t: frame.t, confidence: hand.confidence, down: false }
    const th = this.cfg.thresholds

    if (this.s === 'no-hand') {
      this.go('hover', out)
      this.openPeak = r ?? 0
    }

    switch (this.s) {
      case 'hover': {
        if (r === null) {
          out.push({ type: 'sample', sample })
          break
        }
        this.openPeak = Math.max(this.openPeak, r)
        if (r > th.enter + 0.05) this.sawOpen = true
        const canStart = this.sawOpen && this.handFrames >= this.cfg.minHandFrames && r < th.enter && r < this.openPeak - th.rearmDrop
        if (canStart) {
          this.go('pinch-pending', out)
          this.pending = [{ sample, ratio: r, raw: this.signal.raw ?? r, rawVelocity: rv }]
          this.tryStart(out)
        } else {
          out.push({ type: 'sample', sample })
        }
        break
      }
      case 'pinch-pending': {
        if (r === null || r >= th.enter + 0.03) {
          // Bounce: the pinch didn't hold. Release buffered frames as cursor moves.
          this.flushPending(this.pending.length, out)
          this.go('hover', out)
          out.push({ type: 'sample', sample })
          break
        }
        this.pending.push({ sample, ratio: r, raw: this.signal.raw ?? r, rawVelocity: rv })
        this.tryStart(out)
        break
      }
      case 'lost':
      case 'writing': {
        if (this.s === 'lost') this.go('writing', out)
        if (r === null) {
          out.push({ type: 'sample', sample: { ...sample, down: true } })
          break
        }
        const rise = r - this.baseline
        // Raise each threshold only as far as the measured noise requires (noiseK σ).
        // σr: raw-ratio noise; σs: smoothed-ratio noise; a 2-frame slope's noise ≈ σs·√2 / 67 ms.
        // Early in a stroke the baseline rests on few samples; its own uncertainty
        // (σr/√n) is added so a still-rough baseline can't make noise look like an opening.
        const sigmaR = this.ratioNoise
        const sigmaB = sigmaR / Math.sqrt(Math.max(1, this.baselineN))
        const sigmaS = Math.hypot(this.signal.smoothedNoise(sigmaR), sigmaB)
        const K = this.cfg.noiseK
        const k = Math.max(1, (K * sigmaS) / th.releaseRise)
        const riseNeed = th.releaseRise * k
        // Unsmoothed check for big, fast openings: lifts on the first frame instead of
        // waiting for the smoothed ratio; scaled by the raw noise, which is larger.
        const rawNeed = Math.max(th.releaseRise * 1.5, K * Math.hypot(sigmaR, sigmaB))
        const vNeed = Math.max(th.openVelocity, (K * sigmaS * Math.SQRT2) / 0.067)
        const rawRise = (this.signal.raw ?? r) - this.baseline
        const release = r > th.releaseAbs || rise > riseNeed || rawRise > rawNeed || (v > vNeed && rise > th.releaseMinRise * k)
        if (release) {
          out.push({ type: 'end', reason: 'released', trimAfter: this.onsetTime(frame.t) })
          this.go('hover', out)
          this.sawOpen = true
          this.openPeak = r
          this.history = []
          out.push({ type: 'sample', sample })
          break
        }
        // Follow the writer's grip while it is steady (not while opening), and learn the noise.
        // Baseline: running mean of the raw ratio while steady (exact mean at first, then
        // an EMA with weight baselineFollow so it can follow a slowly relaxing grip).
        if (rise < th.releaseMinRise * k) {
          this.baselineN++
          const raw = this.signal.raw ?? r
          this.baseline += Math.max(1 / this.baselineN, this.cfg.baselineFollow) * (raw - this.baseline)
        }
        this.learnNoise()
        this.pushHistory(frame.t, r)
        out.push({ type: 'sample', sample: { ...sample, down: true } })
        break
      }
    }
    return out
  }

  /** Forces the pen up (e.g. webcam switched off). */
  reset(): GestureAction[] {
    const out: GestureAction[] = []
    if (this.isWriting) out.push({ type: 'end', reason: 'lost' })
    this.pending = []
    this.history = []
    this.signal.reset()
    this.handFrames = 0
    this.sawOpen = false
    if (this.s !== 'no-hand') this.go('no-hand', out)
    return out
  }

  /**
   * Raw-ratio noise from frame-to-frame differences: Var(diff) = 2σ² for
   * white noise, and slow trends (a relaxing grip) barely contribute.
   * Differences beyond 3σ are clipped so a real opening can't inflate it.
   */
  private learnNoise(): void {
    const raw = this.signal.raw
    if (raw === null) return
    if (this.prevRaw !== null) {
      const sd = Math.sqrt(this.noiseVar)
      const d = Math.max(-3 * Math.SQRT2 * sd, Math.min(3 * Math.SQRT2 * sd, raw - this.prevRaw))
      // Learn quickly during the first second of writing, then settle.
      const rate = this.noiseSamples < 30 ? 0.12 : 0.04
      this.noiseVar += rate * ((d * d) / 2 - this.noiseVar)
      this.noiseSamples++
    }
    this.prevRaw = raw
  }

  /** Starts writing once enough pinched frames are in and the closing motion has settled. */
  private tryStart(out: GestureAction[]): void {
    const p = this.pending
    if (p.length < this.cfg.enterFrames) return
    const last = p[p.length - 1]!
    const isSettled = last.rawVelocity > -this.cfg.settleVelocity
    if (!isSettled && p.length < this.cfg.maxSettleFrames) return
    // Ink starts at the first pending frame from which the fingers stayed settled.
    let k = p.length - 1
    if (isSettled) while (k > 0 && p[k - 1]!.rawVelocity > -this.cfg.settleVelocity) k--
    // Also include earlier frames that were already AT the settled level: the first
    // frame after the fingers touch has a steep slope into it but is no longer closing.
    const level = p.slice(k).reduce((a, x) => a + x.raw, 0) / (p.length - k)
    const near = Math.max(0.04, 2 * this.ratioNoise)
    while (k > 0 && Math.abs(p[k - 1]!.raw - level) < near) k--
    // Baseline = mean RAW ratio of the settled frames; restart the smoothed ratio there,
    // so the closing transition still inside the EMA can't look like an opening.
    const settled = p.slice(k).map((x) => x.raw)
    this.baseline = settled.reduce((a, b) => a + b, 0) / settled.length
    this.baselineN = settled.length
    this.signal.reseed(last.sample.t, this.baseline)
    this.prevRaw = last.raw
    this.history = p.slice(k).map((x) => ({ t: x.sample.t, r: x.ratio }))
    this.flushPending(k, out)
    this.go('writing', out)
  }

  /** Emits pending[0..k) as cursor moves and pending[k..] as ink. Pass k = pending.length for no ink. */
  private flushPending(k: number, out: GestureAction[]): void {
    this.pending.forEach((x, i) => out.push({ type: 'sample', sample: { ...x.sample, down: i >= k } }))
    this.pending = []
  }

  private pushHistory(t: number, r: number): void {
    this.history.push({ t, r })
    const cutoff = t - this.cfg.maxTrimMs - 100
    while (this.history.length > 2 && this.history[0]!.t < cutoff) this.history.shift()
  }

  /**
   * Release onset: the time of the last ink frame to keep. Walks back over
   * the final run of frames where the smoothed ratio was RISING and already
   * at least onsetRise/2 above the baseline — the fingers visibly opening —
   * and trims those. Requiring both a rise and a level keeps ordinary noise
   * wiggles (and a baseline that crept up during a slow release) from
   * trimming real ink. Bounded by maxTrimMs.
   */
  private onsetTime(now: number): number {
    const h = this.history
    const limit = now - this.cfg.maxTrimMs
    const level = this.baseline + this.cfg.onsetRise / 2
    let i = h.length - 1
    while (i >= 0) {
      const cur = h[i]!
      const opening = cur.r > level && (i === 0 || h[i - 1]!.r < cur.r)
      if (!opening || cur.t < limit) break
      i--
    }
    return i >= 0 ? h[i]!.t : Math.max(limit, (h[0]?.t ?? now) - 1)
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
      case 'pinch-pending':
      case 'hover':
        this.pending = []
        this.toNoHand(out)
        return
    }
  }

  private toNoHand(out: GestureAction[]): void {
    this.signal.reset()
    this.sawOpen = false
    this.history = []
    this.go('no-hand', out)
    out.push({ type: 'tracking-lost' })
  }

  private go(to: GestureState, out: GestureAction[]): void {
    if (to === this.s) return
    out.push({ type: 'state', from: this.s, to })
    this.s = to
  }
}

export { DEFAULT_PINCH }
