import type { CanvasObject, Point, StrokeObject, TextObject } from '@shared/schema'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const TEXT_LINE_HEIGHT = 1.3

/** Approximate rendered height of a wrapped text box (used for hit-testing). */
export function textBounds(t: TextObject): Rect {
  const charsPerLine = Math.max(1, Math.floor(t.width / (t.fontSize * 0.55)))
  const lines = t.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  return { x: t.x, y: t.y, width: t.width, height: lines * t.fontSize * TEXT_LINE_HEIGHT }
}

export function strokeBounds(s: StrokeObject): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of s.points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const pad = s.size / 2
  return { x: minX - pad, y: minY - pad, width: maxX - minX + s.size, height: maxY - minY + s.size }
}

export function objectBounds(o: CanvasObject): Rect {
  return o.type === 'stroke' ? strokeBounds(o) : textBounds(o)
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px
  const cy = ay + t * dy - py
  return cx * cx + cy * cy
}

function segmentsDistSq(a: Point, b: Point, c: Point, d: Point): number {
  // Segments intersect → distance 0.
  const cross = (o: Point, p: Point, q: Point): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(
    distToSegmentSq(a[0], a[1], c[0], c[1], d[0], d[1]),
    distToSegmentSq(b[0], b[1], c[0], c[1], d[0], d[1]),
    distToSegmentSq(c[0], c[1], a[0], a[1], b[0], b[1]),
    distToSegmentSq(d[0], d[1], a[0], a[1], b[0], b[1])
  )
}

function rectNearSegment(r: Rect, a: Point, b: Point, radius: number): boolean {
  const minX = Math.min(a[0], b[0]) - radius
  const maxX = Math.max(a[0], b[0]) + radius
  const minY = Math.min(a[1], b[1]) - radius
  const maxY = Math.max(a[1], b[1]) + radius
  return !(r.x > maxX || r.x + r.width < minX || r.y > maxY || r.y + r.height < minY)
}

/**
 * Whether an eraser moving from `a` to `b` with the given radius touches the
 * object. Strokes are tested against their actual polyline, not just the box.
 */
export function eraserHits(o: CanvasObject, a: Point, b: Point, radius: number): boolean {
  const bounds = objectBounds(o)
  if (!rectNearSegment(bounds, a, b, radius)) return false
  if (o.type === 'text') return true
  const reach = radius + o.size / 2
  const reachSq = reach * reach
  const pts = o.points
  if (pts.length === 1) return distToSegmentSq(pts[0]![0], pts[0]![1], a[0], a[1], b[0], b[1]) <= reachSq
  for (let i = 1; i < pts.length; i++) {
    if (segmentsDistSq(pts[i - 1]!, pts[i]!, a, b) <= reachSq) return true
  }
  return false
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
}
