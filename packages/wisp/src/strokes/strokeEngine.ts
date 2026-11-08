/**
 * The stroke engine: one pipeline for every input source.
 *
 * Input sources (webcam, mouse, tests) call `input(sample, down)` with raw
 * page-normalized positions. The engine smooths, rejects outliers, resamples,
 * builds strokes and emits integration events. It knows nothing about
 * MediaPipe, React, the DOM or the document/undo history.
 *
 * Pipeline per sample (v0.1.1):
 *   outlier gate → One Euro filter → stabilizer (webcam only) → cursor
 *                                                            └► stroke (when down) → distance resampling
 *
 * ONE continuous filter serves both the cursor and the ink. v0.1 reset a
 * separate stroke filter at every pen-down, so the first ink point was the
 * raw, unsmoothed position while the cursor showed a smoothed one: a visible
 * jump and a burst of unfiltered noise at every stroke start. Now pen-down
 * and pen-up don't disturb the filter at all; it restarts only when tracking
 * is lost or a tracking jump is confirmed.
 */
import { Emitter } from '../core/emitter'
import type { StrokeEndEvent, WispEventMap, WispInputEvents } from '../integration/types'
import { isFiniteNumber } from './coordinates'
import {
  DEFAULT_OUTLIER,
  DistanceSampler,
  OutlierGate,
  PointFilter,
  Stabilizer,
  oneEuroForStrength,
  refineZeroPhase,
  type OneEuroParams,
  type OutlierConfig
} from './smoothing'
import { newId, type InputSource, type PenStyle, type Stroke, type StrokePoint } from './types'

export interface RawSample {
  /** Page-normalized position, unsmoothed. */
  x: number
  y: number
  /** ms (performance.now clock). */
  t: number
  confidence?: number
  source: InputSource
}

export interface EngineOptions {
  style: PenStyle
  /** 0–1, see oneEuroForStrength. */
  smoothing: number
  /** 0–1 stabilizer strength (webcam input only); radius = strength × STABILIZER_MAX_RADIUS. */
  stabilizer: number
  /** Minimum distance between stored points (page-normalized). */
  minPointDistance: number
  outlier: OutlierConfig
  /** Keep the unsmoothed position on every point. */
  keepRaw: boolean
  /** Longest stroke before it is split (matches Inkling's 20 000-point limit). */
  maxPointsPerStroke: number
  /**
   * Pen-down seeding (see seed()): a still pointer (raw positions within
   * `seedSpread` over `seedWindowMs`) starts at their average; a moving one
   * at its latest raw position.
   */
  seedWindowMs: number
  seedSpread: number
  /**
   * Pen-up catch-up: the filtered point lags the hand a little, so a stroke
   * would end short. At pen-up the last point is pulled to the average raw
   * position of the final `seedWindowMs` (kept ≤ the trim time), if that is
   * within `catchUpMax` of the stroke end.
   */
  catchUpMax: number
  /**
   * Re-smooth noisy-source strokes at pen-up with a zero-phase filter
   * (see refineZeroPhase). The live stroke uses the low-latency filter; the
   * final stroke recovers curves and endpoints that live smoothing lags behind.
   */
  refine: boolean
  /** Advanced: explicit One Euro parameters, overriding the `smoothing` strength mapping (tuning/replay). */
  filterParams?: OneEuroParams
}

export const DEFAULT_ENGINE: EngineOptions = {
  style: { color: '#1f2430', width: 4 },
  smoothing: 0.5,
  stabilizer: 0.4,
  minPointDistance: 0.0015,
  outlier: DEFAULT_OUTLIER,
  keepRaw: true,
  maxPointsPerStroke: 20000,
  seedWindowMs: 110,
  seedSpread: 0.012,
  catchUpMax: 0.025,
  refine: true
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** Largest stabilizer radius (page-normalized): 0.004 ≈ 6 px on the 1600-px page. */
export const STABILIZER_MAX_RADIUS = 0.004

/** Input sources whose positions carry tracking noise (get the stabilizer). */
const NOISY: ReadonlySet<InputSource> = new Set(['webcam'])

export class StrokeEngine implements WispInputEvents {
  readonly events = new Emitter<WispEventMap>()
  private opts: EngineOptions
  private active: Stroke | null = null
  private readonly filter: PointFilter
  private readonly stabilizer: Stabilizer
  private readonly gate: OutlierGate
  private readonly sampler: DistanceSampler
  /** Latest filtered point not yet stored (kept so the stroke ends exactly where the pen lifted). */
  private tail: StrokePoint | null = null
  private cursorVisible = false
  /** Every accepted raw sample of the active stroke (for pen-up refinement). */
  private rawLog: Array<{ x: number; y: number; t: number; confidence?: number }> = []
  /** Recent raw samples (pen up or down), for pen-down seeding and pen-up catch-up. */
  private recent: Array<{ x: number; y: number; t: number }> = []

  /** Simple counters for the diagnostics panel. */
  readonly stats = { samples: 0, rejected: 0, discontinuities: 0, trimmed: 0, refined: 0 }

  constructor(opts: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULT_ENGINE, ...opts }
    const { params, enabled } = this.filterConfig()
    this.filter = new PointFilter(params, enabled)
    this.stabilizer = new Stabilizer(this.opts.stabilizer * STABILIZER_MAX_RADIUS)
    this.gate = new OutlierGate(this.opts.outlier)
    this.sampler = new DistanceSampler(this.opts.minPointDistance)
  }

  get activeStroke(): Readonly<Stroke> | null {
    return this.active
  }

  get style(): PenStyle {
    return this.opts.style
  }

  setStyle(style: Partial<PenStyle>): void {
    // Applies to the next stroke; the active stroke keeps its style.
    this.opts.style = { ...this.opts.style, ...style }
  }

  setSmoothing(strength: number): void {
    this.opts.smoothing = strength
    const { params, enabled } = this.filterConfig()
    this.filter.setParams(params, enabled)
  }

  setRefine(on: boolean): void {
    this.opts.refine = on
  }

  setStabilizer(strength: number): void {
    const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0
    this.opts.stabilizer = s
    this.stabilizer.radius = s * STABILIZER_MAX_RADIUS
  }

  /** Feeds one raw sample. `down` = pen is touching (pinch held / mouse button pressed). */
  input(sample: RawSample, down: boolean): void {
    if (!isFiniteNumber(sample.x) || !isFiniteNumber(sample.y) || !isFiniteNumber(sample.t)) return
    this.stats.samples++
    const raw = { x: Math.min(1, Math.max(0, sample.x)), y: Math.min(1, Math.max(0, sample.y)) }

    // For tracked (noisy) input the gate watches every sample, pen up or down, so a
    // tracking spike can't drag the cursor or seed the filter right before a stroke.
    // Mouse input has no tracking spikes; a fast flick must never be dropped.
    const verdict = NOISY.has(sample.source) ? this.gate.check(raw, sample.t) : 'accept'
    if (verdict === 'reject') {
      this.stats.rejected++
      return
    }
    if (verdict === 'discontinuity') {
      this.stats.discontinuities++
      if (this.active) this.end('discontinuity')
      this.restartFilters()
    }
    this.recent.push({ x: raw.x, y: raw.y, t: sample.t })
    while (this.recent.length > 8) this.recent.shift()

    if (down && !this.active) this.seed(sample)
    const f = this.smooth(raw, sample)
    this.emitCursor(f.x, f.y, sample.t, down, sample.source)

    if (!down) {
      if (this.active) this.end('released')
      return
    }
    if (!this.active) {
      this.begin(f, sample, raw)
      return
    }
    this.rawLog.push({ x: raw.x, y: raw.y, t: sample.t, confidence: sample.confidence })
    const point = this.makePoint(f.x, f.y, sample, raw)
    if (this.sampler.accept(point)) {
      this.tail = null
      this.append(point)
      if (this.active.points.length >= this.opts.maxPointsPerStroke) this.end('discontinuity')
    } else {
      this.tail = point
    }
  }

  /**
   * Ends the active stroke, if any. `trimAfter` (ms) removes points recorded
   * after that time — the gesture layer passes the moment the fingers began
   * to open, so ink drawn during the release is dropped. At least one point
   * always remains. Returns the completed stroke.
   */
  end(reason: StrokeEndEvent['reason'] = 'released', trimAfter?: number): Stroke | null {
    const s = this.active
    if (!s) return null
    const keep = (p: StrokePoint): boolean => trimAfter === undefined || !isFiniteNumber(trimAfter) || p.t <= trimAfter
    if (this.tail && keep(this.tail)) {
      s.points.push(this.tail)
      this.events.emit('strokeUpdate', { stroke: s, added: [this.tail] })
    }
    this.tail = null
    if (trimAfter !== undefined && isFiniteNumber(trimAfter)) {
      let n = s.points.length
      while (n > 1 && !keep(s.points[n - 1]!)) n--
      if (n < s.points.length) {
        this.stats.trimmed += s.points.length - n
        s.points.length = n
      }
    }
    if (this.opts.refine && NOISY.has(s.source) && this.rawLog.length >= 4) this.refine(s, trimAfter)
    else this.catchUp(s, trimAfter)
    this.rawLog = []
    s.endedAt = s.points[s.points.length - 1]?.t ?? s.startedAt
    this.active = null
    this.sampler.reset()
    this.events.emit('strokeEnd', { stroke: s, reason })
    return s
  }

  /** Called when the input source can no longer see/locate the pointer. */
  hideCursor(t: number): void {
    // Tracking is gone: the next position starts fresh (no smoothing across the gap).
    this.restartFilters()
    if (!this.cursorVisible) return
    this.cursorVisible = false
    this.events.emit('cursorHidden', { t })
  }

  onStrokeStart(fn: (e: WispEventMap['strokeStart']) => void): () => void {
    return this.events.on('strokeStart', fn)
  }
  onStrokeUpdate(fn: (e: WispEventMap['strokeUpdate']) => void): () => void {
    return this.events.on('strokeUpdate', fn)
  }
  onStrokeEnd(fn: (e: WispEventMap['strokeEnd']) => void): () => void {
    return this.events.on('strokeEnd', fn)
  }
  onTrackingLost(fn: (e: WispEventMap['trackingLost']) => void): () => void {
    return this.events.on('trackingLost', fn)
  }
  onGestureChange(fn: (e: WispEventMap['gestureChange']) => void): () => void {
    return this.events.on('gestureChange', fn)
  }
  onCursor(fn: (e: WispEventMap['cursor']) => void): () => void {
    return this.events.on('cursor', fn)
  }

  private filterConfig(): { params: OneEuroParams; enabled: boolean } {
    return this.opts.filterParams ? { params: this.opts.filterParams, enabled: true } : oneEuroForStrength(this.opts.smoothing)
  }

  private smooth(raw: { x: number; y: number }, sample: RawSample): { x: number; y: number } {
    const f = this.filter.filter(raw, sample.t)
    return NOISY.has(sample.source) ? this.stabilizer.apply(f) : f
  }

  /**
   * Pen-down seeding: a stroke must start where the pen actually is, not
   * where the filter still lags behind the movement that brought it there
   * (that lag draws a hook). If the pointer held still for the last
   * `seedWindowMs`, start at the average of those raw positions (noise
   * averages out); if it was moving, start at the latest raw position.
   */
  private seed(sample: RawSample): void {
    const win = this.recent.filter((r) => sample.t - r.t <= this.opts.seedWindowMs)
    const latest = this.recent[this.recent.length - 1]
    if (!latest) return
    let start = { x: latest.x, y: latest.y }
    if (win.length >= 2) {
      const mx = win.reduce((a, r) => a + r.x, 0) / win.length
      const my = win.reduce((a, r) => a + r.y, 0) / win.length
      const spread = Math.max(...win.map((r) => Math.hypot(r.x - mx, r.y - my)))
      if (spread <= this.opts.seedSpread) start = { x: mx, y: my }
    }
    this.filter.reset()
    this.filter.filter(start, sample.t - 1)
    this.stabilizer.reset(start)
  }

  /** Replaces the stroke's points with a zero-phase refinement of its raw samples. */
  private refine(s: Stroke, trimAfter?: number): void {
    const log = trimAfter === undefined ? this.rawLog : this.rawLog.filter((r, i) => i === 0 || r.t <= trimAfter)
    if (log.length < 4) return
    const { params, enabled } = this.filterConfig()
    if (!enabled) return
    // Two passes smooth more than one: lighten the cutoff so the result matches the chosen strength.
    const refined = refineZeroPhase(log, { ...params, minCutoff: params.minCutoff * 1.6 })
    const sampler = new DistanceSampler(this.opts.minPointDistance)
    const points: StrokePoint[] = []
    refined.forEach((q, i) => {
      const r = log[i]!
      const p = this.makePoint(q.x, q.y, { x: r.x, y: r.y, t: r.t, confidence: r.confidence, source: s.source }, r)
      if (sampler.accept(p) || i === refined.length - 1) points.push(p)
    })
    if (points.length === 0) return
    s.points = points
    this.stats.refined++
  }

  /** Pen-up catch-up (see EngineOptions.catchUpMax). */
  private catchUp(s: Stroke, trimAfter?: number): void {
    if (s.source === 'mouse' || s.points.length < 2) return
    const limit = trimAfter ?? Infinity
    const lastT = s.points[s.points.length - 1]!.t
    const win = this.recent.filter((r) => r.t <= limit && r.t <= lastT && lastT - r.t <= this.opts.seedWindowMs * 0.7)
    if (win.length === 0) return
    const target = { x: win.reduce((a, r) => a + r.x, 0) / win.length, y: win.reduce((a, r) => a + r.y, 0) / win.length }
    const last = s.points[s.points.length - 1]!
    const d = Math.hypot(target.x - last.x, target.y - last.y)
    if (d < this.opts.minPointDistance || d > this.opts.catchUpMax) return
    // Only extend forward along the stroke's direction; never bend back (that would be a hook).
    const prev = s.points[s.points.length - 2]!
    const dirX = last.x - prev.x
    const dirY = last.y - prev.y
    if (dirX * (target.x - last.x) + dirY * (target.y - last.y) <= 0) return
    const p: StrokePoint = { ...last, x: round(target.x), y: round(target.y), t: last.t + 0.1 }
    s.points.push(p)
    this.events.emit('strokeUpdate', { stroke: s, added: [p] })
  }

  private restartFilters(): void {
    this.filter.reset()
    this.stabilizer.reset()
    this.gate.reset()
    this.recent = []
  }

  private begin(f: { x: number; y: number }, sample: RawSample, raw: { x: number; y: number }): void {
    this.sampler.reset()
    this.tail = null
    // Refinement starts from where the live stroke starts (the seeded/filtered point), not a noisy raw sample.
    this.rawLog = [{ x: f.x, y: f.y, t: sample.t, confidence: sample.confidence }]
    const p = this.makePoint(f.x, f.y, sample, raw)
    this.sampler.accept(p)
    this.active = {
      id: newId('stroke'),
      points: [p],
      color: this.opts.style.color,
      width: this.opts.style.width,
      source: sample.source,
      startedAt: sample.t,
      endedAt: sample.t
    }
    this.events.emit('strokeStart', { stroke: this.active })
  }

  private append(p: StrokePoint): void {
    this.active!.points.push(p)
    this.active!.endedAt = p.t
    this.events.emit('strokeUpdate', { stroke: this.active!, added: [p] })
  }

  private makePoint(x: number, y: number, sample: RawSample, raw: { x: number; y: number }): StrokePoint {
    const p: StrokePoint = { x: round(x), y: round(y), t: Math.round(sample.t * 10) / 10 }
    if (isFiniteNumber(sample.confidence)) p.confidence = Math.round(sample.confidence * 1000) / 1000
    if (this.opts.keepRaw) p.raw = { x: round(raw.x), y: round(raw.y) }
    return p
  }

  private emitCursor(x: number, y: number, t: number, down: boolean, source: InputSource): void {
    this.cursorVisible = true
    this.events.emit('cursor', { x, y, t, down, source })
  }
}
