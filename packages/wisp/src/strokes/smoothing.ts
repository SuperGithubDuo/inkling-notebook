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
  /**
   * Speed (units/s) that tracking noise alone produces in the filtered
   * derivative. Speeds below it don't open the filter: only movement beyond
   * what noise can explain counts as intentional (v0.1.2).
   */
  noiseSpeed = 0

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
    const cutoff = this.params.minCutoff + this.params.beta * Math.max(0, Math.abs(ed) - this.noiseSpeed)
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

  /**
   * Noise gate from a position-noise σ (page-normalized): the filtered
   * derivative of white noise has std ≈ σ·√2/dt·√(α/(2−α)); speeds up to
   * `k` times that don't loosen the filter.
   */
  setNoise(sigma: number, dtS = 1 / 30, k = 2.5): void {
    const d = this.fx.params.dCutoff
    const alpha = 1 / (1 + 1 / (2 * Math.PI * d) / dtS)
    const v = ((sigma * Math.SQRT2) / dtS) * Math.sqrt(alpha / (2 - alpha)) * PAGE_UNITS * k
    this.fx.noiseSpeed = v
    this.fy.noiseSpeed = v
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

/**
 * Solves (W + λ·DᵀD)·z = W·y, where D is the k-th order difference matrix
 * and W optional per-sample weights (Whittaker–Henderson smoother). The system is symmetric, positive-definite
 * and banded (bandwidth k), so a banded Cholesky solves it in O(n·k²).
 */
export function whittaker(y: readonly number[], lambda: number, order = 2, weights?: readonly number[]): number[] {
  const n = y.length
  if (n <= order || !(lambda > 0)) return y.slice()
  const w = (i: number) => (weights ? Math.max(1e-6, weights[i] ?? 1) : 1)
  // Coefficients of the k-th difference operator, e.g. order 2 → [1, −2, 1].
  let c = [1]
  for (let k = 0; k < order; k++) c = [...c, 0].map((v, i) => v - (i > 0 ? c[i - 1]! : 0))
  const bw = order
  // Band storage: A[i][j] = matrix entry (i, i + j), j = 0..bw.
  const A = Array.from({ length: n }, () => new Array<number>(bw + 1).fill(0))
  for (let r = 0; r + order < n; r++) {
    // Row r of D touches columns r..r+order with coefficients c.
    for (let a = 0; a <= order; a++) {
      for (let b = a; b <= order; b++) A[r + a]![b - a]! += lambda * c[a]! * c[b]!
    }
  }
  for (let i = 0; i < n; i++) A[i]![0]! += w(i)
  // Banded Cholesky: A = L·Lᵀ (stored in place, L[i][j] = entry (i+j, i)).
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= bw && i + j < n; j++) {
      let sum = A[i]![j]!
      for (let k = 1; k <= bw - j && i - k >= 0; k++) sum -= A[i - k]![k]! * A[i - k]![k + j]!
      if (j === 0) A[i]![0] = Math.sqrt(Math.max(sum, 1e-12))
      else A[i]![j] = sum / A[i]![0]!
    }
  }
  const z = y.map((v, i) => v * w(i))
  for (let i = 0; i < n; i++) {
    let sum = z[i]!
    for (let k = 1; k <= bw && i - k >= 0; k++) sum -= A[i - k]![k]! * z[i - k]!
    z[i] = sum / A[i]![0]!
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i]!
    for (let k = 1; k <= bw && i + k < n; k++) sum -= A[i]![k]! * z[i + k]!
    z[i] = sum / A[i]![0]!
  }
  return z
}

/**
 * Robust noise estimate of a sampled path from second differences:
 * for white noise σ, Var(Δ²) = 6σ². The median makes it insensitive to real
 * accelerations and glitches. Returns σ per axis combined (page units).
 */
export function noiseFromSecondDiff(pts: ReadonlyArray<{ x: number; y: number }>): number | null {
  if (pts.length < 5) return null
  const d: number[] = []
  for (let i = 1; i < pts.length - 1; i++) {
    d.push(Math.abs(pts[i + 1]!.x - 2 * pts[i]!.x + pts[i - 1]!.x), Math.abs(pts[i + 1]!.y - 2 * pts[i]!.y + pts[i - 1]!.y))
  }
  d.sort((a, b) => a - b)
  const med = d[Math.floor(d.length / 2)]!
  return med / 0.6745 / Math.sqrt(6)
}

/**
 * Removes single-frame glitches. Each point is compared with the midpoint of
 * its two neighbours (at the ends, with the line through the next two):
 * smooth handwriting stays close to that prediction even while moving fast,
 * a landmark that jumps for one frame does not. A point is a glitch when its
 * deviation is a local maximum and exceeds max(k × robust scale, minDist);
 * it is then replaced by the prediction.
 */
export function despike<T extends { x: number; y: number }>(pts: readonly T[], minDist: number, k = 4): T[] {
  const n = pts.length
  if (n < 4) return pts.slice()
  const pred = (i: number): { x: number; y: number } => {
    if (i === 0) return { x: 2 * pts[1]!.x - pts[2]!.x, y: 2 * pts[1]!.y - pts[2]!.y }
    if (i === n - 1) return { x: 2 * pts[n - 2]!.x - pts[n - 3]!.x, y: 2 * pts[n - 2]!.y - pts[n - 3]!.y }
    return { x: (pts[i - 1]!.x + pts[i + 1]!.x) / 2, y: (pts[i - 1]!.y + pts[i + 1]!.y) / 2 }
  }
  const dev = pts.map((p, i) => {
    const q = pred(i)
    return Math.hypot(p.x - q.x, p.y - q.y)
  })
  const sorted = dev.slice().sort((a, b) => a - b)
  const scale = sorted[Math.floor(n / 2)]! * 1.4826
  const limit = Math.max(k * scale, minDist)
  const out = pts.slice()
  for (let i = 0; i < n; i++) {
    const isPeak = (i === 0 || dev[i]! >= dev[i - 1]!) && (i === n - 1 || dev[i]! >= dev[i + 1]!)
    if (isPeak && dev[i]! > limit) out[i] = { ...pts[i]!, ...pred(i) }
  }
  return out
}

/**
 * Noise-matched smoothing of a COMPLETED stroke (v0.1.2 refinement):
 *   1. despike — drop one-frame landmark glitches;
 *   2. Whittaker smoother whose strength λ is chosen so the removed
 *      movement (RMS residual) matches the measured landmark noise σ
 *      ("remove what noise explains, keep the rest"), capped at `maxLambda`
 *      so real details at handwriting frequencies are never flattened.
 * Zero lag, endpoints included. Works on strokes of any length, including
 * the 4–6 sample strokes of quick ticks and dashes, where a recursive filter
 * barely acts.
 */
export function refineNoiseMatched<T extends { x: number; y: number }>(
  samples: readonly T[],
  sigma: number,
  opts: { maxLambda: number; minLambda?: number; strength?: number; spikeMin: number }
): NormPoint[] {
  const n = samples.length
  if (n < 3) return samples.map((p) => ({ x: p.x, y: p.y }))
  const clean = despike(samples, opts.spikeMin)
  const xs = clean.map((p) => p.x)
  const ys = clean.map((p) => p.y)
  const target = Math.max(0, sigma) * (opts.strength ?? 1)
  const rms = (lam: number) => {
    const zx = whittaker(xs, lam)
    const zy = whittaker(ys, lam)
    let s = 0
    for (let i = 0; i < n; i++) s += (zx[i]! - xs[i]!) ** 2 + (zy[i]! - ys[i]!) ** 2
    return { r: Math.sqrt(s / (2 * n)), zx, zy }
  }
  const lo0 = opts.minLambda ?? 0.05
  let best = rms(opts.maxLambda)
  if (best.r > target) {
    // Bisection on log λ for residual ≈ target (residual grows with λ).
    let lo = Math.log(lo0)
    let hi = Math.log(opts.maxLambda)
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2
      const m = rms(Math.exp(mid))
      if (m.r > target) hi = mid
      else (lo = mid), (best = m)
    }
    if (best.r > target) best = rms(lo0)
  }
  return best.zx.map((x, i) => ({ x, y: best.zy[i]! }))
}

/**
 * Online estimate of tracking noise (page units) from second differences of
 * raw positions, updated only while the pointer moves slowly (real motion
 * then contributes little). Used to gate One Euro's speed response and to
 * size the stabilizer and the pen-up refinement.
 */
export class NoiseEstimator {
  private v: number
  private last: Array<{ x: number; y: number; t: number }> = []
  samples = 0

  constructor(
    initial = 0.0025,
    private readonly maxSpeed = 0.35
  ) {
    this.v = initial * initial
  }

  get sigma(): number {
    return Math.sqrt(this.v)
  }

  add(p: { x: number; y: number }, t: number): void {
    this.last.push({ x: p.x, y: p.y, t })
    if (this.last.length > 3) this.last.shift()
    if (this.last.length < 3) return
    const [a, b, c] = this.last as [typeof p & { t: number }, typeof p & { t: number }, typeof p & { t: number }]
    const dt = (c.t - a.t) / 2000
    if (!(dt > 0)) return
    const speed = Math.hypot(c.x - a.x, c.y - a.y) / (2 * dt)
    if (speed > this.maxSpeed) return
    const d2 = (c.x - 2 * b.x + a.x) ** 2 + (c.y - 2 * b.y + a.y) ** 2
    // Per-axis variance = E[d2]/(2·6); clip to 9× current to resist glitches.
    const est = Math.min(d2 / 12, 9 * this.v)
    const rate = this.samples < 60 ? 0.08 : 0.03
    this.v += rate * (est - this.v)
    this.samples++
  }

  /** Forget the last positions (tracking gap) but keep the noise level. */
  break(): void {
    this.last = []
  }
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
