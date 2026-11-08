/**
 * Sketch of the future WISP → Inkling adapter. NOT wired into Inkling.
 *
 * Inkling stores ink as page-coordinate points `[x, y]` inside a
 * `createStroke` command (src/renderer/src/canvas/commands.ts), drawn with
 * perfect-freehand. WISP strokes are page-normalized, so converting is a
 * scale into the target page rectangle. The type below mirrors the shape of
 * Inkling's command locally, so WISP keeps zero imports from Inkling; when the
 * adapter moves into Inkling it should use Inkling's real types and run the
 * result through `useStore.getState().run([...])` like any other pen stroke.
 */
import type { Stroke } from '../strokes/types'

/** Local mirror of Inkling's `createStroke` command (schemaVersion 3 pages). */
export interface InklingCreateStrokeCommand {
  type: 'createStroke'
  stroke: {
    tool: 'pen'
    color: string
    size: number
    opacity: number
    hasPressure: false
    points: Array<[number, number]>
  }
}

/** Where WISP's normalized page lands on the Inkling page, in Inkling page coordinates. */
export interface TargetRect {
  x: number
  y: number
  width: number
  height: number
}

const INKLING_MAX_POINTS = 20000

export function toInklingCreateStroke(
  stroke: Stroke,
  target: TargetRect,
  /** WISP logical page width, used to scale pen width into the target. */
  wispPageWidth: number
): InklingCreateStrokeCommand {
  const scale = target.width / wispPageWidth
  const size = Math.min(80, Math.max(0.5, stroke.width * scale))
  const pts = stroke.points.slice(0, INKLING_MAX_POINTS)
  return {
    type: 'createStroke',
    stroke: {
      tool: 'pen',
      color: stroke.color,
      size: Math.round(size * 100) / 100,
      opacity: 1,
      hasPressure: false,
      points: pts.map((p) => [
        Math.round((target.x + p.x * target.width) * 100) / 100,
        Math.round((target.y + p.y * target.height) * 100) / 100
      ])
    }
  }
}
