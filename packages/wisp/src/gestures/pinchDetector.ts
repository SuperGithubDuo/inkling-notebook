/**
 * Pinch classification with hysteresis.
 *
 * The input is the scale-invariant pinch ratio (thumb–index distance ÷ palm
 * size, see tracking/landmarks.ts). Two thresholds avoid flicker: the pinch
 * closes below `enter` and only opens again above `exit` (exit > enter), so
 * noise around a single threshold can't toggle the pen.
 */

export interface PinchThresholds {
  /** Ratio below which an open hand counts as pinched. */
  enter: number
  /** Ratio above which a pinched hand counts as released. */
  exit: number
}

export const DEFAULT_PINCH: PinchThresholds = { enter: 0.3, exit: 0.45 }

/**
 * Pinch sensitivity: 1 = defaults; >1 makes pinching easier (larger ratios
 * count), <1 requires tighter pinches. The hysteresis gap scales with it.
 */
export function pinchThresholds(sensitivity: number, base: PinchThresholds = DEFAULT_PINCH): PinchThresholds {
  const s = Number.isFinite(sensitivity) ? Math.min(2, Math.max(0.5, sensitivity)) : 1
  return { enter: base.enter * s, exit: base.exit * s }
}

export class PinchDetector {
  private pinched = false

  constructor(private thresholds: PinchThresholds = DEFAULT_PINCH) {
    if (!(thresholds.exit > thresholds.enter)) throw new Error('exit threshold must be larger than enter threshold')
  }

  setThresholds(t: PinchThresholds): void {
    if (!(t.exit > t.enter)) throw new Error('exit threshold must be larger than enter threshold')
    this.thresholds = t
  }

  get state(): boolean {
    return this.pinched
  }

  /** Feeds one ratio; returns the (hysteresis) pinch state. Invalid input keeps the current state. */
  update(ratio: number | null): boolean {
    if (ratio === null || !Number.isFinite(ratio)) return this.pinched
    if (this.pinched) {
      if (ratio > this.thresholds.exit) this.pinched = false
    } else if (ratio < this.thresholds.enter) {
      this.pinched = true
    }
    return this.pinched
  }

  reset(): void {
    this.pinched = false
  }
}
