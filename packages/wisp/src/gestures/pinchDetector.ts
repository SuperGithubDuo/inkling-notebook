/**
 * Pinch signal processing.
 *
 * Input: the scale-invariant pinch ratio (thumb–index distance ÷ palm size,
 * see tracking/landmarks.ts). Output, per frame:
 *   value     – the ratio after light smoothing (EMA). Removes single-frame
 *               noise; adds well under a frame of delay.
 *   velocity  – opening speed in ratio units per second, measured over two
 *               frames (a two-frame span halves the noise of a one-frame
 *               difference while still reacting within ~70 ms).
 *
 * Thresholds are ASYMMETRIC (v0.1.1):
 *   - Starting a stroke is conservative: the ratio must fall below `enter`
 *     and the closing motion must have settled (see gestureState.ts).
 *   - Ending a stroke is fast and RELATIVE to the writer's own pinch: the pen
 *     lifts when the ratio rises `releaseRise` above the baseline measured
 *     while writing, or opens quickly (`openVelocity`) by at least
 *     `releaseMinRise`. A fixed absolute ceiling (`releaseAbs`) is a backstop.
 *   v0.1 used a single absolute release at 0.45 — for someone whose fingers
 *   rest at ratio ≈ 0.15 when pinched, that meant opening 0.30 palm-widths
 *   before the pen lifted, which is the "open too far" problem.
 */

export interface PinchThresholds {
  /** Ratio below which an open hand can start a pinch. */
  enter: number
  /** After a release, the ratio must fall this far below its open peak to pinch again (anti-flicker). */
  rearmDrop: number
  /** Lift the pen when the ratio rises this much above the writing baseline. */
  releaseRise: number
  /** Lift the pen when opening faster than this (ratio/s) … */
  openVelocity: number
  /** … and the ratio has already risen at least this much. */
  releaseMinRise: number
  /** Absolute backstop: always lift above this ratio. */
  releaseAbs: number
}

/**
 * v0.1.4: these are the v0.1.2 values, which real-webcam testing confirmed
 * work well. (v0.1.3 tried openVelocity 1.4 and releaseAbs 0.38 but was never
 * tested on a real webcam; see README "v0.1.3".)
 *
 * v0.1.2 defaults (v0.1.1 in brackets):
 *  - pen-down is slightly MORE deliberate: enter 0.27 [0.30], and the pinch
 *    must close by rearmDrop 0.12 [0.10] from a recent open peak;
 *  - pen-up is slightly MORE sensitive: releaseRise 0.07 [0.08], openVelocity
 *    1.7/s [2.0], releaseMinRise 0.05 [0.06]; backstop releaseAbs unchanged.
 */
export const DEFAULT_PINCH: PinchThresholds = {
  enter: 0.27,
  rearmDrop: 0.12,
  releaseRise: 0.07,
  openVelocity: 1.7,
  releaseMinRise: 0.05,
  releaseAbs: 0.42
}

const clampSens = (s: number): number => (Number.isFinite(s) ? Math.min(2, Math.max(0.5, s)) : 1)

/**
 * pinchSensitivity  (start)  >1: looser pinches start a stroke (enter scales up).
 * releaseSensitivity (lift)  >1: the pen lifts after a smaller / slower opening.
 */
export function pinchThresholds(pinchSensitivity = 1, releaseSensitivity = 1, base: PinchThresholds = DEFAULT_PINCH): PinchThresholds {
  const p = clampSens(pinchSensitivity)
  const r = clampSens(releaseSensitivity)
  const enter = base.enter * p
  return {
    enter,
    rearmDrop: base.rearmDrop,
    releaseRise: base.releaseRise / r,
    openVelocity: base.openVelocity / r,
    releaseMinRise: base.releaseMinRise / r,
    // Backstop follows the start threshold and always stays above it.
    releaseAbs: Math.max(enter + 0.08, base.releaseAbs * p)
  }
}

export class PinchSignal {
  private v: number | null = null
  private hist: Array<{ t: number; v: number; raw: number }> = []

  constructor(private readonly alpha = 0.6) {}

  /** Feeds a raw ratio; returns the smoothed value, or null if none yet. */
  update(t: number, ratio: number | null): number | null {
    if (ratio === null || !Number.isFinite(ratio)) return this.v
    this.v = this.v === null ? ratio : this.alpha * ratio + (1 - this.alpha) * this.v
    this.hist.push({ t, v: this.v, raw: ratio })
    if (this.hist.length > 3) this.hist.shift()
    return this.v
  }

  get value(): number | null {
    return this.v
  }

  /** Latest unsmoothed ratio. */
  get raw(): number | null {
    return this.hist.at(-1)?.raw ?? null
  }

  /** Smoothed ratio units per second over the last two frames (positive = opening). Used for release. */
  get velocity(): number {
    return this.slope('v')
  }

  /**
   * Unsmoothed two-frame slope. Used to decide when a closing pinch has
   * settled: the smoothed value lags by about a frame and would make the
   * fingers look like they are still closing after they've stopped.
   */
  get rawVelocity(): number {
    return this.slope('raw')
  }

  private slope(k: 'v' | 'raw'): number {
    const h = this.hist
    if (h.length < 2) return 0
    const a = h[0]!
    const b = h[h.length - 1]!
    const dt = (b.t - a.t) / 1000
    return dt > 0 ? (b[k] - a[k]) / dt : 0
  }

  /** Restarts the smoothed value at `v` (e.g. once a pinch has settled), so it carries no closing transition. */
  reseed(t: number, v: number): void {
    this.v = v
    this.hist = [{ t, v, raw: v }]
  }

  /** Smoothed-value noise implied by a raw-ratio noise σ (EMA variance reduction). */
  smoothedNoise(rawSigma: number): number {
    return rawSigma * Math.sqrt(this.alpha / (2 - this.alpha))
  }

  reset(): void {
    this.v = null
    this.hist = []
  }
}
