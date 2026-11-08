/**
 * Stroke smoothing pipeline (all page-normalized coordinates):
 *
 *   raw sample ─► OutlierGate ─► OneEuroFilter (x, y) ─► DistanceSampler ─► stroke point
 *                   │ reject single-frame spikes
 *                   └ two agreeing far samples ⇒ discontinuity (split the stroke, never draw a connecting line)
 *
 * Why One Euro (Casiez et al., CHI 2012): it is an adaptive low-pass filter
 * whose cutoff rises with speed. Slow, careful movement (where jitter is
 * visible) is smoothed strongly; fast movement (where lag is visible) is
 * barely smoothed. That is the jitter-vs-latency trade-off handwriting needs.
 * An EMA has one fixed cutoff, so it is either jittery or laggy; a Kalman
 * filter needs a motion model and tuning per camera. One Euro has three
 * intuitive parameters and O(1) cost per sample.
 *
 * Catmull-Rom interpolation is applied only at render time (`densify`), so
 * stored points stay a faithful record of what was tracked.
 */
import type { NormPoint } from './types'
import { clamp, isFiniteNumber } from './coordinates'

/** Filters run in "page units": 1000 per page width, so speeds are intuitive (units/s). */
export const PAGE_UNITS = 1000

class LowPass {
  private y: number | null = null
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y
    return this.y
  }
  get last(): number | null {
    return this.y
  }
  reset(): void {
    this.y = null
  }
}

const alphaFor = (cutoffHz: number, dtS: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dtS)
}

export interface OneEuroParams {
  /** Hz. Lower = smoother when moving slowly (more lag at rest). */
  minCutoff: number
  /** Speed coefficient. Higher = less lag when moving fast. */
  beta: number
  /** Hz, cutoff for the derivative estimate. */
  dCutoff: number
}

/** One-dimensional One Euro filter. Timestamps in ms. */
export class OneEuroFilter {
  private readonly x = new LowPass()
  private readonly dx = new LowPass()
  private lastT: number | null = null

  constructor(public params: OneEuroParams) {}

  filter(value: number, tMs: number): number {
    if (this.lastT === null || this.x.last === null) {
      this.lastT = tMs
      this.dx.filter(0, 1)
      return this.x.filter(value, 1)
    }
    // Guard against duplicate/out-of-order timestamps.
    const dt = Math.max(1, tMs - this.lastT) / 1000
    this.lastT = tMs
    const prev = this.x.last
    const d = (value - prev) / dt
    const ed = this.dx.filter(d, alphaFor(this.params.dCutoff, dt))
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(ed)
    return this.x.filter(value, alphaFor(cutoff, dt))
  }

  reset(): void {
    this.x.reset()
    this.dx.reset()
    this.lastT = null
  }
}

/** Two-dimensional One Euro filter over page-normalized points. */
export class PointFilter {
  private readonly fx: OneEuroFilter
  private readonly fy: OneEuroFilter
  private enabled: boolean

  constructor(params: OneEuroParams, enabled = true) {
    this.fx = new OneEuroFilter(params)
    this.fy = new OneEuroFilter(params)
    this.enabled = enabled
  }

  setParams(params: OneEuroParams, enabled = true): void {
    this.fx.params = params
    this.fy.params = params
    this.enabled = enabled
  }

  filter(p: NormPoint, tMs: number): NormPoint {
    if (!this.enabled) return { x: p.x, y: p.y }
    return {
      x: this.fx.filter(p.x * PAGE_UNITS, tMs) / PAGE_UNITS,
      y: this.fy.filter(p.y * PAGE_UNITS, tMs) / PAGE_UNITS
    }
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
  }
}

/**
 * Smoothing strength 0–1 → One Euro parameters (v0.1.1 retune).
 *  0    → filter off (raw points)
 *  0.5  → default: minCutoff ≈ 1.1 Hz, beta 0.04, dCutoff 0.7 Hz
 *  1    → heavy:   minCutoff 0.4 Hz, beta 0.02
 *
 * minCutoff sets smoothing when the pen moves slowly (where shake is most
 * visible); beta lets the cutoff rise with speed so fast strokes stay
 * responsive; dCutoff smooths the speed estimate itself. v0.1 used
 * dCutoff 1 Hz and a higher minCutoff: tracking noise then registered as
 * "speed", opened the filter, and let the noise through. A slower speed
 * estimate (0.7 Hz) keeps jitter from being mistaken for intentional motion.
 * See README → "Smoothing (v0.1.1)" for how the values were chosen.
 */
export function oneEuroForStrength(strength: number): { params: OneEuroParams; enabled: boolean } {
  const s = clamp(isFiniteNumber(strength) ? strength : 0.5, 0, 1)
  if (s < 0.02) return { params: { minCutoff: 1000, beta: 0, dCutoff: 1 }, enabled: false }
  // minCutoff: log interpolation 3 Hz (light) → 0.4 Hz (heavy); 0.5 → 1.1 Hz.
  const minCutoff = Math.exp(Math.log(3) + (Math.log(0.4) - Math.log(3)) * s)
  // beta: 0.06 (light) → 0.02 (heavy); 0.5 → 0.04. v0.1 used 0.012, which left
  // small fast details (loops, superscripts) inside the filter's cut band.
  const beta = 0.06 - 0.04 * s
  return { params: { minCutoff, beta, dCutoff: 0.7 }, enabled: true }
}

/**
 * Stabilizer ("lazy pen"): the output only moves when the filtered point
 * is more than `radius` away, and then by the excess. Residual jitter
 * smaller than the radius never reaches the ink; any movement larger than
 * it does, so small intentional details survive. Costs at most `radius`
 * of positional lag and rounds corners by at most `radius`.
 *
 * `softness` blends a hard dead zone into a smooth one: inside the radius
 * the output still follows by (d/radius)^2 of the way, so very slow,
 * deliberate motion is never completely frozen.
 */
export class Stabilizer {
  private out: NormPoint | null = null

  constructor(
    public radius: number,
    public softness = 0.25
  ) {}

  apply(p: NormPoint): NormPoint {
    if (!this.out || !(this.radius > 0)) {
      this.out = { x: p.x, y: p.y }
      return { ...this.out }
    }
    const dx = p.x - this.out.x
    const dy = p.y - this.out.y
    const d = Math.hypot(dx, dy)
    if (d > 0) {
      let step: number
      if (d > this.radius) step = d - this.radius + this.softness * this.radius
      else step = this.softness * this.radius * (d / this.radius) ** 2
      step = Math.min(d, step)
      this.out = { x: this.out.x + (dx / d) * step, y: this.out.y + (dy / d) * step }
    }
    return { ...this.out }
  }

  /** Jump straight to p (start of tracking, discontinuity). */
  reset(p?: NormPoint): void {
    this.out = p ? { x: p.x, y: p.y } : null
  }
}

/**
 * Zero-phase refinement of a COMPLETED stroke (applied at pen-up).
 *
 * A causal (real-time) filter must lag: the smoothed point trails the
 * finger, which cuts tight curves (loops, superscripts) and ends strokes
 * short. Once a stroke is finished we have all of it, so we filter it
 * forward and then backward in time: the backward pass's lead cancels the
 * forward pass's lag (the classic "filtfilt"). Both ends are padded with an
 * odd reflection of the stroke so the endpoints stay where the finger was
 * instead of being pulled inward.
 *
 * Two passes smooth more than one, so the caller passes slightly lighter
 * parameters than the live filter.
 */
export function refineZeroPhase<T extends { x: number; y: number; t: number }>(samples: readonly T[], params: OneEuroParams): NormPoint[] {
  const n = samples.length
  if (n < 4) return samples.map((p) => ({ x: p.x, y: p.y }))
  const pad = Math.min(n - 1, 8)
  const first = samples[0]!
  const last = samples[n - 1]!
  // Odd reflection about the end points: p' = 2·p_end − p_k, t' mirrored.
  const pre: Array<{ x: number; y: number; t: number }> = []
  for (let k = pad; k >= 1; k--) {
    const q = samples[k]!
    pre.push({ x: 2 * first.x - q.x, y: 2 * first.y - q.y, t: 2 * first.t - q.t })
  }
  const post: Array<{ x: number; y: number; t: number }> = []
  for (let k = 1; k <= pad; k++) {
    const q = samples[n - 1 - k]!
    post.push({ x: 2 * last.x - q.x, y: 2 * last.y - q.y, t: 2 * last.t - q.t })
  }
  const all = [...pre, ...samples.map((p) => ({ x: p.x, y: p.y, t: p.t })), ...post]
  const fwd = new PointFilter(params)
  const a = all.map((p) => fwd.filter(p, p.t))
  const bwd = new PointFilter(params)
  const T = all[all.length - 1]!.t
  const b: NormPoint[] = new Array(all.length)
  for (let i = all.length - 1; i >= 0; i--) b[i] = bwd.filter(a[i]!, T - all[i]!.t)
  return b.slice(pad, pad + n)
}

export interface OutlierConfig {
  /** Page widths per second. Faster jumps are suspicious. */
  maxSpeed: number
  /** Jumps smaller than this (page-normalized) are always accepted. */
  minJump: number
  /** Jumps larger than this are always suspicious, whatever the time gap. */
  maxJump: number
  /** Two suspicious samples this close to each other confirm a real relocation. */
  confirmRadius: number
}

export const DEFAULT_OUTLIER: OutlierConfig = { maxSpeed: 5, minJump: 0.04, maxJump: 0.18, confirmRadius: 0.05 }

export type GateResult = 'accept' | 'reject' | 'discontinuity'

/**
 * Rejects single-frame tracking spikes. If the tracker really did move (two
 * consecutive far samples that agree), reports a discontinuity so the caller
 * can split the stroke instead of drawing a long connecting line.
 */
export class OutlierGate {
  private last: { p: NormPoint; t: number } | null = null
  private candidate: { p: NormPoint; t: number } | null = null

  constructor(public cfg: OutlierConfig = DEFAULT_OUTLIER) {}

  check(p: NormPoint, t: number): GateResult {
    if (!this.last) {
      this.last = { p, t }
      return 'accept'
    }
    const jump = Math.hypot(p.x - this.last.p.x, p.y - this.last.p.y)
    const dt = Math.max(1, t - this.last.t) / 1000
    const suspicious = jump > this.cfg.maxJump || (jump > this.cfg.minJump && jump / dt > this.cfg.maxSpeed)
    if (!suspicious) {
      this.last = { p, t }
      this.candidate = null
      return 'accept'
    }
    if (this.candidate && Math.hypot(p.x - this.candidate.p.x, p.y - this.candidate.p.y) <= this.cfg.confirmRadius) {
      this.last = { p, t }
      this.candidate = null
      return 'discontinuity'
    }
    this.candidate = { p, t }
    return 'reject'
  }

  reset(): void {
    this.last = null
    this.candidate = null
  }
}

/** Keeps a point only once it is at least `minDistance` from the last kept point. */
export class DistanceSampler {
  private lastKept: NormPoint | null = null
  constructor(public minDistance: number) {}

  accept(p: NormPoint): boolean {
    if (!this.lastKept || Math.hypot(p.x - this.lastKept.x, p.y - this.lastKept.y) >= this.minDistance) {
      this.lastKept = p
      return true
    }
    return false
  }

  reset(): void {
    this.lastKept = null
  }
}

/** Exponential moving average, kept for comparison/evaluation (not used by default). */
export function ema(points: readonly NormPoint[], alpha: number): NormPoint[] {
  const a = clamp(alpha, 0, 1)
  const out: NormPoint[] = []
  let prev: NormPoint | null = null
  for (const p of points) {
    prev = prev ? { x: a * p.x + (1 - a) * prev.x, y: a * p.y + (1 - a) * prev.y } : { x: p.x, y: p.y }
    out.push(prev)
  }
  return out
}

/**
 * Render-time centripetal-style Catmull-Rom subdivision: inserts points so no
 * segment is longer than `maxSegment` (in the input's units). Passes through
 * every original point, so corners are kept.
 */
export function densify<T extends NormPoint>(pts: readonly T[], maxSegment: number): NormPoint[] {
  if (pts.length < 3 || !(maxSegment > 0)) return pts.map((p) => ({ x: p.x, y: p.y }))
  const out: NormPoint[] = [{ x: pts[0]!.x, y: pts[0]!.y }]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const n = Math.min(16, Math.floor(len / maxSegment))
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1)
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      })
    }
    out.push({ x: p2.x, y: p2.y })
  }
  return out
}
