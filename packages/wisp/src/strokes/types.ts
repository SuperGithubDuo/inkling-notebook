/**
 * WISP stroke data model.
 *
 * COORDINATE CONVENTION (used everywhere in WISP):
 *   "Page-normalized" coordinates. x and y are in [0, 1] over the drawing
 *   page, origin at the TOP-LEFT, x to the right, y DOWN. The page has a fixed
 *   logical size (`WispDocument.canvas.width/height`, in logical pixels), so
 *   page geometry is page-normalized × that size. The on-screen canvas
 *   letterboxes the page, so resizing the window never distorts strokes.
 *
 * Timestamps are milliseconds from `performance.now()` (monotonic within a
 * session) for points, and epoch milliseconds for document-level dates.
 */

export const WISP_FORMAT = 'wisp.strokes' as const
export const WISP_FORMAT_VERSION = 1 as const

export type InputSource = 'webcam' | 'mouse' | 'import'

/** A position in page-normalized coordinates. */
export interface NormPoint {
  x: number
  y: number
}

export interface StrokePoint {
  /** Page-normalized X (0 = left edge, 1 = right edge). */
  x: number
  /** Page-normalized Y (0 = top edge, 1 = bottom edge). */
  y: number
  /** ms, performance.now() clock of the session that recorded it. */
  t: number
  /** 0–1 tracking confidence (webcam only). */
  confidence?: number
  /** The unsmoothed position this point came from (page-normalized). Kept for accuracy evaluation. */
  raw?: NormPoint
}

export interface Stroke {
  id: string
  /** Ordered, processed (smoothed + resampled) points. */
  points: StrokePoint[]
  /** #rrggbb */
  color: string
  /** Pen width in logical page pixels. */
  width: number
  source: InputSource
  startedAt: number
  endedAt: number
}

export interface CanvasMeta {
  /** Logical page size in pixels; defines the page aspect ratio. */
  width: number
  height: number
  background: string
}

export interface WispDocument {
  format: typeof WISP_FORMAT
  version: typeof WISP_FORMAT_VERSION
  id: string
  createdAt: number
  updatedAt: number
  canvas: CanvasMeta
  strokes: Stroke[]
}

export interface PenStyle {
  color: string
  width: number
}

export const DEFAULT_CANVAS: CanvasMeta = { width: 1600, height: 1000, background: '#ffffff' }

export function newId(prefix = 's'): string {
  const c = globalThis.crypto
  if (c && 'randomUUID' in c) return `${prefix}_${c.randomUUID().replace(/-/g, '').slice(0, 16)}`
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function createDocument(canvas: CanvasMeta = DEFAULT_CANVAS): WispDocument {
  const now = Date.now()
  return {
    format: WISP_FORMAT,
    version: WISP_FORMAT_VERSION,
    id: newId('doc'),
    createdAt: now,
    updatedAt: now,
    canvas: { ...canvas },
    strokes: []
  }
}
