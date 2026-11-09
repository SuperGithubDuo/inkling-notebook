/**
 * Stroke helpers shared by every ink input (mouse, touch, stylus, PhonePad):
 * point simplification before saving, and the eraser's hit testing and the
 * commands it produces. Pure, so they are unit-tested.
 */
import type { CanvasObject, Point, StrokeObject } from '@shared/schema'
import type { CanvasCommand } from './commands'
import { eraserHits } from './geometry'
import { cutRuns, densify } from './eraser'

/** Drops points closer than 0.4 page units apart: smaller files, same look. */
export function simplify(points: Point[]): Point[] {
  const round = (v: number): number => Math.round(v * 100) / 100
  const out: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const q = out[out.length - 1]
    if (!q || i === points.length - 1 || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.4) out.push(p)
  }
  return out.map((p) => (p.length === 3 ? [round(p[0]), round(p[1]), round(p[2])] : [round(p[0]), round(p[1])]) as Point)
}

/** What an eraser drag has touched so far. */
export interface EraseState {
  hits: Set<string>
  /** Precise mode: the pieces of each cut stroke that remain. */
  pieces: Map<string, Point[][]>
  precise: boolean
}

export const newEraseState = (precise: boolean): EraseState => ({ hits: new Set(), pieces: new Map(), precise })

/** Erases along the segment a→b with `radius` (page units). Returns true if anything new was hit. */
export function eraseSegment(state: EraseState, objects: readonly CanvasObject[], a: Point, b: Point, radius: number): boolean {
  let changed = false
  for (const o of objects) {
    if (state.hits.has(o.id) && !state.pieces.has(o.id)) continue
    if (state.precise && o.type === 'stroke') {
      const runs = state.pieces.get(o.id) ?? [densify(o.points, Math.max(0.75, radius / 3))]
      const cut = cutRuns(runs, a, b, radius + o.size * 0.35)
      if (cut) {
        state.pieces.set(o.id, cut)
        state.hits.add(o.id)
        changed = true
      }
    } else if (!state.hits.has(o.id) && eraserHits(o, a, b, radius)) {
      state.hits.add(o.id)
      changed = true
    }
  }
  return changed
}

/** Strokes to preview while erasing: the remaining pieces of cut strokes. */
export function erasePieces(state: EraseState, objects: readonly CanvasObject[]): StrokeObject[] {
  const extra: StrokeObject[] = []
  for (const [id, runs] of state.pieces) {
    const src = objects.find((o) => o.id === id) as StrokeObject | undefined
    if (src) runs.forEach((points, i) => extra.push({ ...src, id: `${id}-p${i}`, points }))
  }
  return extra
}

/** The commands that apply an erase: delete what was hit, re-create the remaining pieces in place. */
export function eraseCommands(state: EraseState, objects: readonly CanvasObject[]): CanvasCommand[] {
  const commands: CanvasCommand[] = []
  // Work from the top layer down so earlier indices stay valid.
  const hit = objects.map((o, index) => ({ o, index })).filter(({ o }) => state.hits.has(o.id))
  for (const { o, index } of hit.reverse()) {
    commands.push({ type: 'deleteObjects', ids: [o.id] })
    const runs = state.pieces.get(o.id)
    if (runs && o.type === 'stroke') {
      runs.forEach((points, i) => {
        const { color, size, opacity, tool, hasPressure } = o
        commands.push({ type: 'createStroke', index: index + i, stroke: { color, size, opacity, tool, hasPressure, points: simplify(points) } })
      })
    }
  }
  return commands
}
