import type { CanvasObject, ImageObject, Point, ShapeObject, StrokeObject, TextObject } from '@shared/schema'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Vec = [number, number]

export const TEXT_LINE_HEIGHT = 1.3

/** Approximate rendered height of a wrapped text box (used for hit-testing). */
export function textBounds(t: TextObject): Rect {
  const charsPerLine = Math.max(1, Math.floor(t.width / (t.fontSize * 0.55)))
  const lines = t.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  return { x: t.x, y: t.y, width: t.width, height: lines * t.fontSize * TEXT_LINE_HEIGHT }
}

export function rectFromPoints(points: readonly (readonly number[])[], pad = 0): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    const x = p[0]!
    const y = p[1]!
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
}

export function strokeBounds(s: StrokeObject): Rect {
  return rectFromPoints(s.points, s.size / 2)
}

/** Corners of a (possibly rotated) box in page coordinates, clockwise from (x, y). */
export function boxCorners(o: { x: number; y: number; width: number; height: number; rotation: number }): Vec[] {
  const rad = (o.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const local: Vec[] = [
    [0, 0],
    [o.width, 0],
    [o.width, o.height],
    [0, o.height]
  ]
  return local.map(([lx, ly]) => [o.x + lx * cos - ly * sin, o.y + lx * sin + ly * cos])
}

export function shapeBounds(s: ShapeObject): Rect {
  if (s.kind === 'line' || s.kind === 'arrow') {
    const head = s.kind === 'arrow' ? arrowHeadSize(s.strokeWidth) : 0
    return rectFromPoints(lineEnds(s), s.strokeWidth / 2 + head)
  }
  return rectFromPoints(boxCorners(s), s.strokeWidth / 2)
}

export function imageBounds(i: ImageObject): Rect {
  return rectFromPoints(boxCorners(i))
}

export function objectBounds(o: CanvasObject): Rect {
  switch (o.type) {
    case 'stroke':
      return strokeBounds(o)
    case 'text':
      return textBounds(o)
    case 'shape':
      return shapeBounds(o)
    case 'image':
      return imageBounds(o)
  }
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  const pts = rects.flatMap((r) => [
    [r.x, r.y],
    [r.x + r.width, r.y + r.height]
  ])
  return rectFromPoints(pts)
}

export function lineEnds(s: ShapeObject): [Vec, Vec] {
  return [
    [s.x, s.y],
    [s.x + s.width, s.y + s.height]
  ]
}

export const arrowHeadSize = (strokeWidth: number): number => Math.max(10, strokeWidth * 4)

// ---------------------------------------------------------------- distances

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

export function pointSegmentDistance(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(distToSegmentSq(p[0]!, p[1]!, a[0]!, a[1]!, b[0]!, b[1]!))
}

function segmentsDistSq(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number {
  const cross = (o: readonly number[], p: readonly number[], q: readonly number[]): number =>
    (p[0]! - o[0]!) * (q[1]! - o[1]!) - (p[1]! - o[1]!) * (q[0]! - o[0]!)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(
    distToSegmentSq(a[0]!, a[1]!, c[0]!, c[1]!, d[0]!, d[1]!),
    distToSegmentSq(b[0]!, b[1]!, c[0]!, c[1]!, d[0]!, d[1]!),
    distToSegmentSq(c[0]!, c[1]!, a[0]!, a[1]!, b[0]!, b[1]!),
    distToSegmentSq(d[0]!, d[1]!, a[0]!, a[1]!, b[0]!, b[1]!)
  )
}

function rectNearSegment(r: Rect, a: Point, b: Point, radius: number): boolean {
  const minX = Math.min(a[0], b[0]) - radius
  const maxX = Math.max(a[0], b[0]) + radius
  const minY = Math.min(a[1], b[1]) - radius
  const maxY = Math.max(a[1], b[1]) + radius
  return !(r.x > maxX || r.x + r.width < minX || r.y > maxY || r.y + r.height < minY)
}

function polylineNear(pts: readonly (readonly number[])[], a: Point, b: Point, reach: number): boolean {
  const reachSq = reach * reach
  if (pts.length === 1) return distToSegmentSq(pts[0]![0]!, pts[0]![1]!, a[0], a[1], b[0], b[1]) <= reachSq
  for (let i = 1; i < pts.length; i++) if (segmentsDistSq(pts[i - 1]!, pts[i]!, a, b) <= reachSq) return true
  return false
}

/**
 * Whether an eraser moving from `a` to `b` with the given radius touches the
 * object. Strokes and shape outlines are tested against their actual lines.
 * Images are never erased (delete them with the lasso instead).
 */
export function eraserHits(o: CanvasObject, a: Point, b: Point, radius: number): boolean {
  if (o.type === 'image') return false
  if (!rectNearSegment(objectBounds(o), a, b, radius)) return false
  if (o.type === 'text') return true
  if (o.type === 'stroke') return polylineNear(o.points, a, b, radius + o.size / 2)
  const reach = radius + o.strokeWidth / 2
  if (o.kind === 'line' || o.kind === 'arrow') return polylineNear(lineEnds(o), a, b, reach)
  if (o.fill && o.fillOpacity > 0.3 && pointInPolygon(a, shapeOutline(o))) return true
  return polylineNear(shapeOutline(o, true), a, b, reach)
}

// ---------------------------------------------------------------- polygons

/** Outline of a closed shape as a polygon in page coordinates. */
export function shapeOutline(s: ShapeObject, closed = false): Vec[] {
  const rad = (s.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let local: Vec[]
  if (s.kind === 'ellipse') {
    local = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2
      return [s.width / 2 + (Math.cos(t) * s.width) / 2, s.height / 2 + (Math.sin(t) * s.height) / 2] as Vec
    })
  } else if (s.kind === 'triangle') {
    local = [
      [s.width / 2, 0],
      [s.width, s.height],
      [0, s.height]
    ]
  } else {
    local = [
      [0, 0],
      [s.width, 0],
      [s.width, s.height],
      [0, s.height]
    ]
  }
  if (closed) local.push(local[0]!)
  return local.map(([lx, ly]) => [s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos])
}

export function pointInPolygon(p: readonly number[], poly: readonly (readonly number[])[]): boolean {
  const x = p[0]!
  const y = p[1]!
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0]!
    const yi = poly[i]![1]!
    const xj = poly[j]![0]!
    const yj = poly[j]![1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Fraction of a stroke's points that must fall inside the lasso to select it. */
export const LASSO_STROKE_COVERAGE = 0.6

/**
 * Lasso hit-test against real geometry, not bounding boxes: a stroke is
 * selected when most of its points are inside the loop; other objects when
 * their centre is inside the loop.
 */
export function lassoSelects(o: CanvasObject, lasso: readonly Vec[]): boolean {
  if (lasso.length < 3) return false
  const b = objectBounds(o)
  const lb = rectFromPoints(lasso)
  if (b.x > lb.x + lb.width || b.x + b.width < lb.x || b.y > lb.y + lb.height || b.y + b.height < lb.y) return false
  if (o.type === 'stroke') {
    let inside = 0
    for (const p of o.points) if (pointInPolygon(p, lasso)) inside++
    return inside / o.points.length >= LASSO_STROKE_COVERAGE
  }
  return pointInPolygon([b.x + b.width / 2, b.y + b.height / 2], lasso)
}

/** Topmost object at a point (for tap-to-select). */
export function objectAt(objects: readonly CanvasObject[], p: Vec, tolerance: number): CanvasObject | undefined {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]!
    if (o.type === 'image') {
      if (pointInPolygon(p, boxCorners(o))) return o
    } else if (o.type === 'shape' && o.kind !== 'line' && o.kind !== 'arrow' && o.fill && pointInPolygon(p, shapeOutline(o))) {
      return o
    } else if (eraserHits(o, p, p, tolerance)) return o
  }
  return undefined
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
}
