/**
 * The stroke engine: one pipeline for every input source.
 *
 * Input sources (webcam, mouse, tests) call `input(sample, down)` with raw
 * page-normalized positions. The engine smooths, rejects outliers, resamples,
 * builds strokes and emits integration events. It knows nothing about
 * MediaPipe, React, the DOM or the document/undo history.
 */
import { Emitter } from '../core/emitter'
import type { StrokeEndEvent, WispEventMap, WispInputEvents } from '../integration/types'
import { isFiniteNumber } from './coordinates'
import {
  DEFAULT_OUTLIER,
  DistanceSampler,
  OutlierGate,
  PointFilter,
  oneEuroForStrength,
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
  /** Minimum distance between stored points (page-normalized). */
  minPointDistance: number
  outlier: OutlierConfig
  /** Keep the unsmoothed position on every point. */
  keepRaw: boolean
  /** Longest stroke before it is split (matches Inkling's 20 000-point limit). */
  maxPointsPerStroke: number
}

export const DEFAULT_ENGINE: EngineOptions = {
  style: { color: '#1f2430', width: 4 },
  smoothing: 0.5,
  minPointDistance: 0.0012,
  outlier: DEFAULT_OUTLIER,
  keepRaw: true,
  maxPointsPerStroke: 20000
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6

export class StrokeEngine implements WispInputEvents {
  readonly events = new Emitter<WispEventMap>()
  private opts: EngineOptions
  private active: Stroke | null = null
  private readonly filter: PointFilter
  private readonly hoverFilter: PointFilter
  private readonly gate: OutlierGate
  private readonly sampler: DistanceSampler
  /** Latest filtered point not yet stored (kept so the stroke ends exactly where the pen lifted). */
  private tail: StrokePoint | null = null
  private cursorVisible = false

  /** Simple counters for the diagnostics panel. */
  readonly stats = { samples: 0, rejected: 0, discontinuities: 0 }

  constructor(opts: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULT_ENGINE, ...opts }
    const { params, enabled } = oneEuroForStrength(this.opts.smoothing)
    this.filter = new PointFilter(params, enabled)
    this.hoverFilter = new PointFilter(params, enabled)
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
    const { params, enabled } = oneEuroForStrength(strength)
    this.filter.setParams(params, enabled)
    this.hoverFilter.setParams(params, enabled)
  }

  /** Feeds one raw sample. `down` = pen is touching (pinch held / mouse button pressed). */
  input(sample: RawSample, down: boolean): void {
    if (!isFiniteNumber(sample.x) || !isFiniteNumber(sample.y) || !isFiniteNumber(sample.t)) return
    this.stats.samples++
    const raw = { x: Math.min(1, Math.max(0, sample.x)), y: Math.min(1, Math.max(0, sample.y)) }

    if (!down) {
      if (this.active) this.end('released')
      const c = this.hoverFilter.filter(raw, sample.t)
      this.emitCursor(c.x, c.y, sample.t, false, sample.source)
      return
    }

    if (!this.active) {
      this.begin(sample, raw)
      return
    }

    const verdict = this.gate.check(raw, sample.t)
    if (verdict === 'reject') {
      this.stats.rejected++
      return
    }
    if (verdict === 'discontinuity') {
      this.stats.discontinuities++
      this.end('discontinuity')
      this.begin(sample, raw)
      return
    }

    const f = this.filter.filter(raw, sample.t)
    const point = this.makePoint(f.x, f.y, sample, raw)
    this.emitCursor(f.x, f.y, sample.t, true, sample.source)
    if (this.sampler.accept(point)) {
      this.tail = null
      this.append(point)
      if (this.active.points.length >= this.opts.maxPointsPerStroke) {
        this.end('discontinuity')
      }
    } else {
      this.tail = point
    }
  }

  /** Ends the active stroke, if any. Returns the completed stroke. */
  end(reason: StrokeEndEvent['reason'] = 'released'): Stroke | null {
    const s = this.active
    if (!s) return null
    if (this.tail) {
      s.points.push(this.tail)
      this.events.emit('strokeUpdate', { stroke: s, added: [this.tail] })
      this.tail = null
    }
    s.endedAt = s.points[s.points.length - 1]?.t ?? s.startedAt
    this.active = null
    this.gate.reset()
    this.sampler.reset()
    this.filter.reset()
    // Restart the hover filter from the pen-up position so the cursor doesn't lag back.
    this.hoverFilter.reset()
    const last = s.points[s.points.length - 1]
    if (last) this.hoverFilter.filter(last, last.t)
    this.events.emit('strokeEnd', { stroke: s, reason })
    return s
  }

  /** Called when the input source can no longer see/locate the pointer. */
  hideCursor(t: number): void {
    if (!this.cursorVisible) return
    this.cursorVisible = false
    this.hoverFilter.reset()
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

  private begin(sample: RawSample, raw: { x: number; y: number }): void {
    this.filter.reset()
    this.gate.reset()
    this.sampler.reset()
    this.tail = null
    this.gate.check(raw, sample.t)
    const f = this.filter.filter(raw, sample.t)
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
    this.emitCursor(f.x, f.y, sample.t, true, sample.source)
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
