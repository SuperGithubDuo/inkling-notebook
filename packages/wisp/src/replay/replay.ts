/**
 * Replays a landmark trace through the real webcam pipeline
 * (HandFrameProcessor → GestureStateMachine → StrokeEngine) with any
 * settings, and measures the result. Used by the tests and by
 * `npm run replay` for recorded traces.
 */
import { HandFrameProcessor, type ProcessorConfig } from '../input/handFrameProcessor'
import { StrokeEngine, type EngineOptions } from '../strokes/strokeEngine'
import { cameraToPage } from '../strokes/coordinates'
import { effectiveRegion } from '../input/handFrameProcessor'
import type { NormPoint, Stroke } from '../strokes/types'
import { unpackLandmarks, type LandmarkTrace } from './trace'
import type { GestureConfig } from '../gestures/gestureState'

export interface ReplayConfig {
  processor?: Partial<ProcessorConfig>
  engine?: Partial<EngineOptions>
  gesture?: Partial<GestureConfig>
}

export const REPLAY_PROCESSOR: ProcessorConfig = {
  mirror: false,
  writingSensitivity: 1,
  pinchSensitivity: 1,
  releaseSensitivity: 1,
  penPoint: 'midpoint',
  region: null,
  pageAspect: 1.6
}

export interface ReplayResult {
  strokes: Stroke[]
  /** Cursor positions as emitted (page space). */
  cursor: Array<{ t: number; x: number; y: number; down: boolean }>
  config: ProcessorConfig
  /** Mean pipeline time per frame (ms), excluding hand tracking. */
  msPerFrame: number
}

export function replay(trace: LandmarkTrace, cfg: ReplayConfig = {}): ReplayResult {
  const config: ProcessorConfig = { ...REPLAY_PROCESSOR, ...cfg.processor }
  const engine = new StrokeEngine(cfg.engine)
  const proc = new HandFrameProcessor(engine, config, cfg.gesture)
  const strokes: Stroke[] = []
  const cursor: ReplayResult['cursor'] = []
  engine.onStrokeEnd((e) => strokes.push({ ...e.stroke, points: e.stroke.points.slice() }))
  engine.onCursor((c) => cursor.push({ t: c.t, x: c.x, y: c.y, down: c.down }))
  const frames = trace.frames.map((f) => ({ t: f.t, landmarks: unpackLandmarks(f.lm), confidence: f.c }))
  const t0 = performance.now()
  for (const f of frames) proc.process({ ...f, videoAspect: trace.videoAspect })
  proc.reset((trace.frames.at(-1)?.t ?? 0) + 1)
  const msPerFrame = frames.length ? (performance.now() - t0) / frames.length : 0
  return { strokes, cursor, config, msPerFrame }
}

// ── Metrics ────────────────────────────────────────────────────────────────

function distToSegment(p: NormPoint, a: NormPoint, b: NormPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy))
}

export function distToPolyline(p: NormPoint, line: readonly NormPoint[]): number {
  if (line.length === 1) return Math.hypot(p.x - line[0]!.x, p.y - line[0]!.y)
  let best = Infinity
  for (let i = 1; i < line.length; i++) best = Math.min(best, distToSegment(p, line[i - 1]!, line[i]!))
  return best
}

export function pathLength(pts: readonly NormPoint[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  return s
}

/**
 * Wobble: RMS deviation of the stroke from a local quadratic fit of itself
 * (7-point Savitzky–Golay). A quadratic follows real curves and loops, so
 * this measures shake, not curvature, offset or lag. Points are first
 * resampled to equal arc spacing (`step`) so the result doesn't depend on
 * how densely the engine stored points.
 */
export function wobble(pts: readonly NormPoint[], step = 0.004): number {
  const r = resampleArc(pts, step)
  const c = [-2, 3, 6, 7, 6, 3, -2]
  if (r.length < 9) return 0
  let sum = 0
  let n = 0
  for (let i = 3; i < r.length - 3; i++) {
    let fx = 0, fy = 0
    for (let k = -3; k <= 3; k++) {
      fx += c[k + 3]! * r[i + k]!.x
      fy += c[k + 3]! * r[i + k]!.y
    }
    sum += (r[i]!.x - fx / 21) ** 2 + (r[i]!.y - fy / 21) ** 2
    n++
  }
  return Math.sqrt(sum / n)
}

export function resampleArc(pts: readonly NormPoint[], step: number): NormPoint[] {
  if (pts.length < 2) return pts.slice()
  const out: NormPoint[] = [pts[0]!]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    let d = step - carry
    while (d <= len) {
      const k = d / len
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
      d += step
    }
    carry = len - (d - step)
  }
  return out
}

export interface StrokeTruth {
  /** Intended path (page space). */
  path: NormPoint[]
  /** Frame time of each path point (synthetic traces). */
  times?: number[]
}

export interface Score {
  strokes: number
  expected: number
  /** Output strokes that match no intended stroke (accidental marks, connecting lines). */
  unintended: number
  /** Intended strokes that came out in two or more pieces. */
  broken: number
  /** Intended strokes with no ink at all. */
  lost: number
  /** RMS distance from ink points to the intended path (page units). */
  shapeError: number
  /** Mean wobble (page units). */
  wobble: number
  /** Ink farther than HOOK_TOL from the intended path, at a stroke's start (hook) or end (tail). */
  hook: number
  tail: number
  /** Mean distance between each intended stroke's start/end and its ink's start/end (page units). */
  startError: number
  endError: number
  /** All ink farther than TOL from the intended path (hooks + tails + connecting lines). */
  excess: number
  /** Intended path with no ink within TOL (shortened strokes, lost details). */
  missing: number
  /** Live lag: mean distance between the live cursor and the intended pen point while writing (page units). */
  liveLag: number
  /** Largest gap between consecutive points of a stroke (page units; continuity). */
  maxGap: number
  /** Total stored points. */
  points: number
  msPerFrame: number
}

/**
 * Distance (page-normalized) within which ink counts as "on the intended
 * path": 0.005 ≈ 8 px on the 1600-px page. Slow whole-hand sway of a few px
 * is in the same frequency band as writing and can't be filtered out without
 * lag, so a tighter tolerance would mostly measure the noise model.
 */
export const TOL = 0.005
/** Hooks/tails: ink more than ≈13 px off the path at a stroke's ends. */
export const HOOK_TOL = 0.008

/** Ground-truth strokes of a synthetic trace, mapped to page space with the replay's mapping. */
export function truthStrokes(
  truth: Array<{ t?: number; midpoint: NormPoint; index: NormPoint; intendInk: boolean }>,
  cfg: ProcessorConfig,
  videoAspect: number
): StrokeTruth[] {
  const region = effectiveRegion(cfg, videoAspect)
  const out: StrokeTruth[] = []
  let cur: StrokeTruth | null = null
  for (const f of truth) {
    if (f.intendInk) {
      const p = cameraToPage(cfg.penPoint === 'index' ? f.index : f.midpoint, { mirror: cfg.mirror, region })
      if (!p) continue
      if (!cur) out.push((cur = { path: [], times: [] }))
      cur.path.push({ x: p.x, y: p.y })
      cur.times!.push(f.t ?? 0)
    } else cur = null
  }
  return out
}

/** Length of polyline `a` lying farther than `tol` from every polyline in `bs` (fine resampling). */
function lengthOutside(a: readonly NormPoint[], bs: ReadonlyArray<readonly NormPoint[]>, tol: number): number {
  if (a.length === 1) return 0
  const step = 0.0005
  const r = resampleArc(a, step)
  let n = 0
  for (const p of r) if (bs.every((b) => distToPolyline(p, b) > tol)) n++
  return n * step
}

/** Ink belongs to an intended stroke if its mean distance to it is under this (≈32 px). */
const MATCH_TOL = 0.02

/**
 * Scores replayed strokes against intended strokes. Each output stroke is
 * matched to the intended stroke it lies closest to; output strokes far from
 * every intended stroke count as unintended.
 */
export function score(result: ReplayResult, truth: StrokeTruth[]): Score {
  let shape = 0, wob = 0, tail = 0, hook = 0, excess = 0, missing = 0, points = 0, nShape = 0, unintended = 0, maxGap = 0
  const truthPaths = truth.map((t) => t.path)
  const matched: Stroke[][] = truth.map(() => [])
  for (const s of result.strokes) {
    points += s.points.length
    excess += lengthOutside(s.points, truthPaths, TOL)
    for (let i = 1; i < s.points.length; i++) maxGap = Math.max(maxGap, Math.hypot(s.points[i]!.x - s.points[i - 1]!.x, s.points[i]!.y - s.points[i - 1]!.y))
    // Match by time first (unambiguous for crossing glyphs like "x" or "="):
    // the intended stroke whose time span overlaps this stroke most; then
    // check it is also spatially close, else it is an unintended mark.
    let bi = -1
    let bestOverlap = -Infinity
    truth.forEach((t, i) => {
      if (!t.times || t.times.length === 0) return
      const t0 = t.times[0]!
      const t1 = t.times[t.times.length - 1]!
      const overlap = Math.min(t1, s.endedAt) - Math.max(t0, s.startedAt)
      if (overlap > bestOverlap) (bestOverlap = overlap), (bi = i)
    })
    // Allow a gap of up to 300 ms (a stroke may start/end a few frames off).
    if (bestOverlap < -300) bi = -1
    if (bi < 0) {
      let bd = Infinity
      truth.forEach((t, i) => {
        const d = s.points.reduce((m, p) => m + distToPolyline(p, t.path), 0) / s.points.length
        if (d < bd) (bd = d), (bi = i)
      })
    }
    const bd = bi >= 0 ? s.points.reduce((m, p) => m + distToPolyline(p, truth[bi]!.path), 0) / s.points.length : Infinity
    if (bi < 0 || bd > MATCH_TOL) {
      unintended++
      continue
    }
    matched[bi]!.push(s)
    const best = truth[bi]!
    let err = 0
    for (const p of s.points) err += distToPolyline(p, best.path) ** 2
    shape += Math.sqrt(err / s.points.length)
    wob += wobble(s.points)
    nShape++
    const pts = s.points
    let i0 = 0
    while (i0 < pts.length - 1 && distToPolyline(pts[i0]!, best.path) > HOOK_TOL) i0++
    let i1 = pts.length - 1
    while (i1 > i0 && distToPolyline(pts[i1]!, best.path) > HOOK_TOL) i1--
    hook += pathLength(pts.slice(0, i0 + 1))
    tail += pathLength(pts.slice(i1))
  }
  let startErr = 0, endErr = 0, nEnds = 0, broken = 0, lost = 0
  truth.forEach((t, i) => {
    const m = matched[i]!
    if (m.length === 0) return void lost++
    if (m.length > 1) broken++
    const first = m[0]!.points[0]!
    const last = m[m.length - 1]!.points.at(-1)!
    startErr += Math.hypot(first.x - t.path[0]!.x, first.y - t.path[0]!.y)
    endErr += Math.hypot(last.x - t.path.at(-1)!.x, last.y - t.path.at(-1)!.y)
    nEnds++
  })
  const inkPaths = result.strokes.map((s) => s.points)
  for (const t of truth) missing += inkPaths.length === 0 ? pathLength(t.path) : lengthOutside(t.path, inkPaths, TOL)
  // Live lag: cursor vs intended pen point at the same frame, while ink was intended.
  const cursorAt = new Map(result.cursor.map((c) => [Math.round(c.t * 10), c]))
  let lag = 0, nLag = 0
  for (const t of truth) {
    t.times?.forEach((tt, k) => {
      const c = cursorAt.get(Math.round(tt * 10))
      if (c && c.down) {
        lag += Math.hypot(c.x - t.path[k]!.x, c.y - t.path[k]!.y)
        nLag++
      }
    })
  }
  return {
    strokes: result.strokes.length,
    expected: truth.length,
    unintended,
    broken,
    lost,
    shapeError: nShape ? shape / nShape : 0,
    wobble: nShape ? wob / nShape : 0,
    hook,
    tail,
    startError: nEnds ? startErr / nEnds : 0,
    endError: nEnds ? endErr / nEnds : 0,
    excess,
    missing,
    liveLag: nLag ? lag / nLag : 0,
    maxGap,
    points,
    msPerFrame: result.msPerFrame
  }
}
