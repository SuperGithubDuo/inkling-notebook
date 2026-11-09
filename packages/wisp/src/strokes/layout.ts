/**
 * Writing Assist layout tools (v0.1.4): optional, reversible, line-level.
 *
 * Principles (from the v0.1.4 brief):
 *  - Never reshape or resize strokes one by one. A whole LINE moves as one
 *    rigid body (rotation + translation), so letters, loops, superscripts,
 *    subscripts, fractions and connected writing keep their exact relative
 *    geometry.
 *  - Never snap points to a line. Only the line's overall slope and offset
 *    change; ascenders, descenders and every in-line offset are kept.
 *  - Always reversible: each moved stroke records the transform applied
 *    (`stroke.assist`), and `restoreOriginal` undoes it exactly (to float
 *    precision). The normal undo/redo also works.
 *
 * Size is NOT normalized here: estimating a line's letter size without
 * knowing which strokes are letters, superscripts or fraction parts would
 * shrink maths and enlarge short words. Consistent size comes from the
 * source instead — the steady writing plane (writingPlane.ts).
 */
import type { CanvasMeta, Stroke, StrokePoint } from './types'

/** Similarity transform in PAGE PIXELS: x' = a·x − b·y + tx, y' = b·x + a·y + ty. */
export interface Similarity {
  a: number
  b: number
  tx: number
  ty: number
}

export const IDENTITY: Similarity = { a: 1, b: 0, tx: 0, ty: 0 }

export function compose(outer: Similarity, inner: Similarity): Similarity {
  // outer(inner(p))
  return {
    a: outer.a * inner.a - outer.b * inner.b,
    b: outer.b * inner.a + outer.a * inner.b,
    tx: outer.a * inner.tx - outer.b * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.a * inner.ty + outer.ty
  }
}

export function invert(m: Similarity): Similarity {
  const d = m.a * m.a + m.b * m.b
  const a = m.a / d
  const b = -m.b / d
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) }
}

function applyPx(m: Similarity, x: number, y: number): [number, number] {
  return [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty]
}

/** Applies a page-pixel similarity to a stroke's points (and raw points), in page-normalized storage. */
function transformStroke(s: Stroke, m: Similarity, page: CanvasMeta): Stroke {
  const W = page.width
  const H = page.height
  const tp = (p: StrokePoint): StrokePoint => {
    const [x, y] = applyPx(m, p.x * W, p.y * H)
    const q: StrokePoint = { ...p, x: x / W, y: y / H }
    if (p.raw) {
      const [rx, ry] = applyPx(m, p.raw.x * W, p.raw.y * H)
      q.raw = { x: rx / W, y: ry / H }
    }
    return q
  }
  return { ...s, points: s.points.map(tp) }
}

const inPage = (s: Stroke): boolean =>
  s.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && (!p.raw || (p.raw.x >= 0 && p.raw.x <= 1 && p.raw.y >= 0 && p.raw.y <= 1)))

// ── Lines ──────────────────────────────────────────────────────────────────

interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}
function box(s: Stroke, page: CanvasMeta): Box {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of s.points) {
    const x = p.x * page.width
    const y = p.y * page.height
    x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y)
  }
  return { x0, x1, y0, y1 }
}
const median = (v: number[]): number => {
  const s = v.slice().sort((a, b) => a - b)
  const n = s.length
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/**
 * Groups strokes into lines of writing, in writing order. Writing moves
 * rightwards along a line; a new line starts with a "carriage return" (a
 * stroke starting well left of where the line has reached, and lower), or
 * with a big vertical jump. Vertical position alone is NOT used, so tall
 * symbols, superscripts, subscripts and the parts of a fraction stay on their
 * line.
 */
export function groupLines(strokes: readonly Stroke[], page: CanvasMeta): number[][] {
  const order = strokes.map((_, i) => i).sort((a, b) => strokes[a]!.startedAt - strokes[b]!.startedAt)
  const boxes = strokes.map((s) => box(s, page))
  const h = Math.max(8, median(boxes.map((b) => Math.max(4, b.y1 - b.y0))))
  const lines: number[][] = []
  let cur: number[] = []
  let cy = 0
  let reachX = -Infinity
  let bandY0 = Infinity
  let bandY1 = -Infinity
  for (const i of order) {
    const b = boxes[i]!
    const c = (b.y0 + b.y1) / 2
    const carriageReturn = b.x0 < reachX - 2 * h && c > cy + 0.5 * h
    // Far above or below everything on the line so far (a denominator overlaps the line's band; a new line doesn't).
    const apart = b.y0 > bandY1 + h || b.y1 < bandY0 - h
    if (cur.length > 0 && (carriageReturn || apart)) {
      lines.push(cur)
      cur = []
      reachX = -Infinity
      bandY0 = Infinity
      bandY1 = -Infinity
    }
    cur.push(i)
    cy = median(cur.map((j) => (boxes[j]!.y0 + boxes[j]!.y1) / 2))
    reachX = Math.max(reachX, b.x1)
    bandY0 = Math.min(bandY0, b.y0)
    bandY1 = Math.max(bandY1, b.y1)
  }
  if (cur.length) lines.push(cur)
  return lines
}

export interface Baseline {
  /** y = intercept + slope · x, page pixels. */
  slope: number
  intercept: number
  /** Strokes whose lowest point was used (the rest were descenders, superscripts, …). */
  inliers: number
  /** Typical stroke height in the line (px). */
  height: number
  /** Horizontal extent of the inliers (px). */
  span: number
  /** Standard error of the slope (jackknife over the inliers). */
  slopeSE: number
}

/**
 * Estimates a line's baseline from the LOWEST point of each stroke: most
 * letter strokes end on the baseline. Descenders, subscripts, superscripts,
 * fraction bars and dots don't, so the fit is robust (Theil–Sen slope,
 * median intercept, then outliers beyond 0.25 stroke-heights are dropped and
 * the line refitted). Null when fewer than 3 strokes agree.
 */
export function estimateBaseline(strokes: readonly Stroke[], page: CanvasMeta): Baseline | null {
  if (strokes.length < 3) return null
  const pts = strokes.map((s) => {
    let best: [number, number] = [0, -Infinity]
    for (const p of s.points) {
      const y = p.y * page.height
      if (y > best[1]) best = [p.x * page.width, y]
    }
    return best
  })
  const height = median(strokes.map((s) => {
    const b = box(s, page)
    return b.y1 - b.y0
  }))
  const fit = (P: Array<[number, number]>): { slope: number; intercept: number } | null => {
    if (P.length < 2) return null
    const slopes: number[] = []
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const dx = P[j]![0] - P[i]![0]
      if (Math.abs(dx) > Math.max(4, height * 0.5)) slopes.push((P[j]![1] - P[i]![1]) / dx)
    }
    if (slopes.length === 0) return null
    const slope = median(slopes)
    const intercept = median(P.map(([x, y]) => y - slope * x))
    return { slope, intercept }
  }
  let f = fit(pts)
  if (!f) return null
  const tol = Math.max(3, 0.25 * height)
  let inl = pts.filter(([x, y]) => Math.abs(y - (f!.intercept + f!.slope * x)) <= tol)
  if (inl.length < 3) return null
  f = fit(inl)
  if (!f) return null
  inl = pts.filter(([x, y]) => Math.abs(y - (f!.intercept + f!.slope * x)) <= tol)
  if (inl.length < 3) return null
  const xs = inl.map(([x]) => x)
  // Jackknife standard error of the slope: how much it depends on single strokes.
  const loo = inl.map((_, k) => fit(inl.filter((__, j) => j !== k))?.slope).filter((v): v is number => v !== undefined)
  const ms = loo.reduce((a, b) => a + b, 0) / Math.max(1, loo.length)
  const slopeSE = loo.length > 2 ? Math.sqrt(((loo.length - 1) / loo.length) * loo.reduce((a, b) => a + (b - ms) ** 2, 0)) : Infinity
  return { ...f, inliers: inl.length, height, span: Math.max(...xs) - Math.min(...xs), slopeSE }
}

export interface TidyOptions {
  /** Straighten lines whose baseline is tilted by at most this many degrees (larger tilts look intentional). */
  maxAngleDeg: number
  /**
   * Leave lines tilted less than this alone (degrees). Below ~1.5° the
   * baseline estimate itself is not more accurate than that in replay
   * (maths lines got WORSE when straightened by 0.5–1.5°).
   */
  minAngleDeg: number
  /** Optional ruled guides to align baselines to (page px). */
  guides?: { firstBaseline: number; pitch: number } | null
  /** Move a baseline onto a guide only if it is within this fraction of the pitch. */
  snapFraction: number
}

export const DEFAULT_TIDY: TidyOptions = { maxAngleDeg: 10, minAngleDeg: 1.5, guides: null, snapFraction: 0.3 }

export interface TidyReport {
  lines: number
  straightened: number
  aligned: number
  skipped: number
}

/**
 * Straightens each line of writing (rotation about the line's start on its
 * baseline) and optionally aligns it to the nearest ruled guide. Returns new
 * strokes; untouched strokes are returned as-is (same objects).
 */
export function tidyLines(strokes: readonly Stroke[], page: CanvasMeta, opts: Partial<TidyOptions> = {}): { strokes: Stroke[]; report: TidyReport } {
  const o = { ...DEFAULT_TIDY, ...opts }
  const out = strokes.slice()
  const report: TidyReport = { lines: 0, straightened: 0, aligned: 0, skipped: 0 }
  for (const idx of groupLines(strokes, page)) {
    report.lines++
    const members = idx.map((i) => strokes[i]!)
    const base = estimateBaseline(members, page)
    // Too little evidence for a baseline: fewer than 5 strokes (or under half the
    // line) agree, or they span < 3 letter heights. Lines dense with notation
    // (fractions, roots, integrals, sub/superscripts) usually fail this and are
    // left exactly as written.
    if (!base || base.inliers < Math.max(5, members.length / 2) || base.span < 3 * base.height) {
      report.skipped++
      continue
    }
    const angle = Math.atan(base.slope)
    const deg = Math.abs((angle * 180) / Math.PI)
    let m: Similarity = IDENTITY
    const x0 = Math.min(...members.map((s) => box(s, page).x0))
    const y0 = base.intercept + base.slope * x0
    // Rotate only a tilt that is clearly measured (> 2 standard errors) and in the plausible range.
    if (deg >= o.minAngleDeg && deg <= o.maxAngleDeg && Math.abs(base.slope) > 2 * base.slopeSE) {
      // Rotate by −angle about (x0, y0), the start of the line on its baseline.
      const a = Math.cos(-angle)
      const b = Math.sin(-angle)
      m = { a, b, tx: x0 - (a * x0 - b * y0), ty: y0 - (b * x0 + a * y0) }
    }
    let aligned = false
    if (o.guides && o.guides.pitch > 0) {
      const k = Math.round((y0 - o.guides.firstBaseline) / o.guides.pitch)
      const target = o.guides.firstBaseline + k * o.guides.pitch
      const dy = target - y0
      if (Math.abs(dy) > 0.5 && Math.abs(dy) <= o.snapFraction * o.guides.pitch) {
        m = compose({ a: 1, b: 0, tx: 0, ty: dy }, m)
        aligned = true
      }
    }
    if (m === IDENTITY) continue
    const moved = members.map((s) => {
      const t = transformStroke(s, m, page)
      t.assist = compose(m, s.assist ?? IDENTITY)
      return t
    })
    // Never push ink off the page: such a line is left as written.
    if (!moved.every(inPage)) {
      report.skipped++
      continue
    }
    idx.forEach((i, k) => (out[i] = moved[k]!))
    if (m.b !== 0) report.straightened++
    if (aligned) report.aligned++
  }
  return { strokes: out, report }
}

/** Undoes every Writing Assist transform (exactly, up to float rounding). */
export function restoreOriginal(strokes: readonly Stroke[], page: CanvasMeta): Stroke[] {
  return strokes.map((s) => {
    if (!s.assist) return s
    const t = transformStroke(s, invert(s.assist), page)
    // Float round-off can leave 1e-16 outside the page; clamp only that.
    const c = (v: number) => (v < 0 && v > -1e-9 ? 0 : v > 1 && v < 1 + 1e-9 ? 1 : v)
    t.points = t.points.map((p) => ({ ...p, x: c(p.x), y: c(p.y), ...(p.raw ? { raw: { x: c(p.raw.x), y: c(p.raw.y) } } : {}) }))
    delete t.assist
    return t
  })
}

// ── Guides ─────────────────────────────────────────────────────────────────

export interface GuideLines {
  /** Baselines (page px). */
  baselines: number[]
  /** Offsets above the baseline (px) of the x-height and cap height lines. */
  xHeight: number
  capHeight: number
  pitch: number
}

/**
 * Ruled guides for a page: baseline every `pitch` px, a dashed x-height line
 * and a cap-height line above it. The letter guides follow the writing scale
 * (so they match the letter size the mapping produces); `lineSpacing`
 * (v0.1.5, 0.6–2) only changes the distance between lines, never the
 * x-height or cap height.
 */
export function guideLines(page: CanvasMeta, writingScale: number, basePitch = 125, lineSpacing = 1): GuideLines {
  const sp = Number.isFinite(lineSpacing) && lineSpacing > 0 ? Math.min(2, Math.max(0.6, lineSpacing)) : 1
  const pitch = Math.max(40, Math.round(basePitch * sp * (Number.isFinite(writingScale) && writingScale > 0 ? writingScale : 1)))
  const first = Math.round(pitch * 0.85)
  const baselines: number[] = []
  for (let y = first; y < page.height - pitch * 0.15; y += pitch) baselines.push(y)
  const letter = pitch / sp
  return { baselines, xHeight: Math.round(letter * 0.33), capHeight: Math.round(letter * 0.6), pitch }
}
