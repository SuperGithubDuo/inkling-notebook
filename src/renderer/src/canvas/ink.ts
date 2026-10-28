/**
 * Digital ink: turns recorded input points into a filled outline using
 * perfect-freehand (MIT). Pressure only varies width when the stroke carries
 * real stylus pressure; mouse and touch strokes have uniform width.
 */
import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Point, StrokeObject } from '@shared/schema'

export type InkStyle = Pick<StrokeObject, 'tool' | 'size' | 'hasPressure'>

export function inkOptions(style: InkStyle, complete: boolean): StrokeOptions {
  const pen = style.tool === 'pen'
  return {
    size: style.size,
    thinning: pen && style.hasPressure ? 0.6 : 0,
    smoothing: 0.55,
    streamline: pen ? 0.4 : 0.55,
    simulatePressure: false,
    last: complete,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  }
}

export function outlinePath(points: readonly Point[], style: InkStyle, complete = true): string {
  const input = points.map(([x, y, p]) => [x, y, style.hasPressure ? (p ?? 0.5) : 0.5])
  return svgPathFromOutline(getStroke(input, inkOptions(style, complete)))
}

const cache = new WeakMap<StrokeObject, { d: string; path: Path2D | null }>()

/** Outline for a committed stroke. Strokes are immutable, so cache by identity. */
export function strokePathData(stroke: StrokeObject): string {
  let hit = cache.get(stroke)
  if (!hit) {
    hit = { d: outlinePath(stroke.points, stroke), path: null }
    cache.set(stroke, hit)
  }
  return hit.d
}

export function strokePath2D(stroke: StrokeObject): Path2D {
  strokePathData(stroke)
  const hit = cache.get(stroke)!
  hit.path ??= new Path2D(hit.d)
  return hit.path
}

function svgPathFromOutline(outline: number[][]): string {
  const n = outline.length
  if (n === 0) return ''
  const r = (v: number): string => (Math.round(v * 100) / 100).toString()
  if (n < 3) {
    const [x, y] = outline[0]!
    return `M${r(x!)},${r(y!)}Z`
  }
  const avg = (a: number, b: number): number => (a + b) / 2
  const p0 = outline[0]!
  const p1 = outline[1]!
  const p2 = outline[2]!
  let d = `M${r(p0[0]!)},${r(p0[1]!)} Q${r(p1[0]!)},${r(p1[1]!)} ${r(avg(p1[0]!, p2[0]!))},${r(avg(p1[1]!, p2[1]!))} T`
  for (let i = 2; i < n - 1; i++) {
    const a = outline[i]!
    const b = outline[i + 1]!
    d += `${r(avg(a[0]!, b[0]!))},${r(avg(a[1]!, b[1]!))} `
  }
  return d + 'Z'
}
