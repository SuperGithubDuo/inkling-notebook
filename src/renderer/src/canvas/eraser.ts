/**
 * Precise (partial) erasing: cuts the parts of a stroke under the eraser and
 * keeps the rest as separate strokes with the original style and pressure.
 */
import type { Point } from '@shared/schema'
import { pointSegmentDistance } from './geometry'

/** Inserts interpolated points so no gap is wider than `step`. */
export function densify(points: readonly Point[], step: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    if (i > 0) {
      const q = points[i - 1]!
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      const n = Math.floor(d / step)
      for (let k = 1; k < n; k++) {
        const t = k / n
        const x = q[0] + (p[0] - q[0]) * t
        const y = q[1] + (p[1] - q[1]) * t
        out.push(p.length === 3 && q.length === 3 ? [x, y, q[2] + (p[2] - q[2]) * t] : [x, y])
      }
    }
    out.push(p)
  }
  return out
}

/**
 * Removes the points of each run that lie within `reach` of the eraser segment
 * a→b and returns the surviving runs. Runs shorter than two points are dropped.
 * Returns null when nothing was cut.
 */
export function cutRuns(runs: readonly Point[][], a: Point, b: Point, reach: number): Point[][] | null {
  let changed = false
  const out: Point[][] = []
  for (const run of runs) {
    let current: Point[] = []
    for (const p of run) {
      if (pointSegmentDistance(p, a, b) <= reach) {
        changed = true
        if (current.length >= 2) out.push(current)
        current = []
      } else current.push(p)
    }
    if (current.length >= 2) out.push(current)
    else if (current.length && current.length === run.length) out.push(current)
  }
  return changed ? out : null
}
