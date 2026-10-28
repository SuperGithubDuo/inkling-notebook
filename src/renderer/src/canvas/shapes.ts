/**
 * Shape outlines as SVG path data in the shape's local box (origin at the box's
 * top-left). The same string feeds Konva (via Path2D) and the SVG thumbnails,
 * so both always agree.
 */
import type { ShapeKind, ShapeObject } from '@shared/schema'
import { arrowHeadSize } from './geometry'

const r = (v: number): string => (Math.round(v * 100) / 100).toString()

export function shapePathData(kind: ShapeKind, w: number, h: number, strokeWidth: number): string {
  switch (kind) {
    case 'rect':
      return `M0 0H${r(w)}V${r(h)}H0Z`
    case 'ellipse': {
      const rx = Math.abs(w / 2)
      const ry = Math.abs(h / 2)
      return `M0 ${r(h / 2)}A${r(rx)} ${r(ry)} 0 1 0 ${r(w)} ${r(h / 2)}A${r(rx)} ${r(ry)} 0 1 0 0 ${r(h / 2)}Z`
    }
    case 'triangle':
      return `M${r(w / 2)} 0L${r(w)} ${r(h)}L0 ${r(h)}Z`
    case 'line':
      return `M0 0L${r(w)} ${r(h)}`
    case 'arrow': {
      const len = Math.hypot(w, h)
      if (len < 1) return `M0 0L${r(w)} ${r(h)}`
      const head = Math.min(arrowHeadSize(strokeWidth), len * 0.6)
      const a = Math.atan2(h, w)
      const spread = Math.PI / 7
      const p1 = [w - head * Math.cos(a - spread), h - head * Math.sin(a - spread)]
      const p2 = [w - head * Math.cos(a + spread), h - head * Math.sin(a + spread)]
      return `M0 0L${r(w)} ${r(h)}M${r(p1[0]!)} ${r(p1[1]!)}L${r(w)} ${r(h)}L${r(p2[0]!)} ${r(p2[1]!)}`
    }
  }
}

const cache = new WeakMap<ShapeObject, { d: string; path: Path2D | null }>()

export function shapeD(s: ShapeObject): string {
  let hit = cache.get(s)
  if (!hit) {
    hit = { d: shapePathData(s.kind, s.width, s.height, s.strokeWidth), path: null }
    cache.set(s, hit)
  }
  return hit.d
}

export function shapePath2D(s: ShapeObject): Path2D {
  shapeD(s)
  const hit = cache.get(s)!
  hit.path ??= new Path2D(hit.d)
  return hit.path
}

export const isLineLike = (s: { kind: ShapeKind }): boolean => s.kind === 'line' || s.kind === 'arrow'

/** Draws a shape in its local box onto a 2D context (fill, then outline). */
export function paintShape(
  c: CanvasRenderingContext2D,
  path: Path2D,
  style: { color: string; strokeWidth: number; fill: string | null; fillOpacity: number }
): void {
  c.lineJoin = 'round'
  c.lineCap = 'round'
  if (style.fill && style.fillOpacity > 0) {
    c.globalAlpha = style.fillOpacity
    c.fillStyle = style.fill
    c.fill(path)
    c.globalAlpha = 1
  }
  c.strokeStyle = style.color
  c.lineWidth = style.strokeWidth
  c.stroke(path)
}
