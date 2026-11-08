/**
 * Boundary reach (v0.1.4): can the pen reach every page edge and corner?
 *
 * The writer traces a rectangle a little (4 %) beyond the page edges they see,
 * then both diagonals, with a hand facing the camera at 45 cm. Tracking is
 * lost whenever the palm leaves the camera frame (synth
 * `edgeLoss`), which is what limits the reachable area on a real webcam.
 * The rectangle is aimed at each mapping's own writing region (the user
 * aims at the page, wherever the mapping puts it in the camera view).
 */
import { GLYPHS, type Placed } from './font'
import { LAYOUT_CONFIGS, buildScene, fittedRegion, imageToPhys, replayLayout, type LayoutScene } from './layout'
import type { NoiseModel } from './synth'
import type { WritingRegion } from '../strokes/coordinates'
import type { Stroke } from '../strokes/types'

const DEPTH = 0.45

export function boundaryScene(region: WritingRegion, overshoot = 0.04): LayoutScene {
  const w = region.x1 - region.x0
  const h = region.y1 - region.y0
  const X0 = region.x0 - w * overshoot, X1 = region.x1 + w * overshoot
  const Y0 = region.y0 - h * overshoot, Y1 = region.y1 + h * overshoot
  // Glyph space with em = 1 m: x = X, y = −Y (font y is up).
  const P = (x: number, y: number): [number, number] => {
    const p = imageToPhys(x, y, DEPTH)
    return [p.X, -p.Y]
  }
  const strokes: Array<Array<[number, number]>> = [
    [P(X0, Y0), P(X1, Y0)], // top, left → right
    [P(X1, Y0), P(X1, Y1)], // right, top → bottom
    [P(X1, Y1), P(X0, Y1)], // bottom, right → left
    [P(X0, Y1), P(X0, Y0)], // left, bottom → top
    [P(X0, Y0), P(X1, Y1)], // diagonal ↘
    [P(X1, Y0), P(X0, Y1)] // diagonal ↙
  ]
  const words: LayoutScene['words'] = strokes.map((s, i) => {
    const key = `#edge${i}`
    GLYPHS[key] = { strokes: [s], advance: 0 }
    const g: Placed = { ch: key, dx: 0, dy: 0, scale: 1, role: 'main', word: i }
    return { glyphs: [g], depth: DEPTH }
  })
  return { id: 'LF-boundary', title: 'Edges, corners and diagonals', em: 1, origin: { X: 0, Y: 0 }, words, speed: 0.12 }
}

export interface BoundaryResult {
  config: string
  /** Gap between the ink and each page edge (page px; 0 = reached). */
  top: number
  bottom: number
  left: number
  right: number
  /** Corners with ink within 20 px (0–4). */
  corners: number
  /** Camera frames without tracking (palm out of frame). */
  lostFrames: number
}

function reach(strokes: readonly Stroke[]): Omit<BoundaryResult, 'config' | 'lostFrames'> {
  const pts = strokes.flatMap((s) => s.points.map((p) => [p.x * 1600, p.y * 1000] as const))
  if (pts.length === 0) return { top: 1000, bottom: 1000, left: 1600, right: 1600, corners: 0 }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const corners = ([[0, 0], [1600, 0], [0, 1000], [1600, 1000]] as const).filter(([cx, cy]) => pts.some(([x, y]) => Math.hypot(x - cx, y - cy) <= 20)).length
  return { top: Math.min(...ys), bottom: 1000 - Math.max(...ys), left: Math.min(...xs), right: 1600 - Math.max(...xs), corners }
}

export function boundaryReport(seeds: number, noise: NoiseModel): BoundaryResult[] {
  const out: BoundaryResult[] = []
  for (const [label, cfg] of Object.entries(LAYOUT_CONFIGS)) {
    const acc = { top: 0, bottom: 0, left: 0, right: 0, corners: 0, lostFrames: 0 }
    for (let seed = 1; seed <= seeds; seed++) {
      // Aim at the region this mapping shows the user (probe with the hand resting near the middle).
      const region = fittedRegion(cfg, seed, noise)
      const { trace } = buildScene(boundaryScene(region), seed, noise)
      const r = replayLayout(trace, cfg)
      const m = reach(r.strokes)
      for (const k of ['top', 'bottom', 'left', 'right', 'corners'] as const) acc[k] += m[k] / seeds
      acc.lostFrames += trace.frames.filter((f) => !f.lm).length / seeds
    }
    out.push({ config: label, ...acc })
  }
  return out
}
