/**
 * Ghost Whiteboard geometry (pure; no DOM).
 *
 * The webcam is shown behind a translucent whiteboard, placed so that the
 * camera's WRITING REGION (the part of the view that maps to the page)
 * covers the whiteboard exactly. A hand in the background then appears
 * right under the cursor and the ink, at every point of the page — the
 * same mapping the handwriting engine uses (coordinates.ts cameraToPage),
 * just drawn the other way round.
 *
 * Regions are in VIEW space (mirrored camera coordinates, [0,1]²). With
 * mirroring on, the video element is flipped horizontally (CSS scaleX(-1)
 * about its own centre), so displayed coordinates are view coordinates.
 */
import type { PageFit, WritingRegion } from '../strokes/coordinates'

export interface VideoBox {
  /** CSS px, relative to the canvas host. */
  left: number
  top: number
  width: number
  height: number
  mirror: boolean
}

/** Where to draw the webcam so the writing region lands exactly on the page. Null for a degenerate region. */
export function ghostVideoBox(fit: PageFit, region: WritingRegion | null, mirror: boolean): VideoBox | null {
  if (!region) return null
  const rw = region.x1 - region.x0
  const rh = region.y1 - region.y0
  if (!(rw > 1e-6) || !(rh > 1e-6) || !(fit.width > 0) || !(fit.height > 0)) return null
  const width = fit.width / rw
  const height = fit.height / rh
  return { left: fit.left - region.x0 * width, top: fit.top - region.y0 * height, width, height, mirror }
}

/** Screen position (CSS px) at which a VIEW-space point of the camera image is shown. */
export function viewToScreen(box: VideoBox, p: { x: number; y: number }): { x: number; y: number } {
  return { x: box.left + p.x * box.width, y: box.top + p.y * box.height }
}

/** Webcam visibility limits (share of the webcam that shows through the board). */
export const GHOST_MIN = 0.03
export const GHOST_MAX = 0.5
export const GHOST_DEFAULT = 0.12

/**
 * Board opacity for a webcam visibility: the board covers the webcam, so
 * 12 % visibility = an 88 % opaque board. Without a live camera the board is
 * fully opaque (a normal whiteboard).
 */
export function boardOpacity(visibility: number, cameraLive: boolean): number {
  if (!cameraLive) return 1
  const v = Number.isFinite(visibility) ? Math.min(GHOST_MAX, Math.max(GHOST_MIN, visibility)) : GHOST_DEFAULT
  return 1 - v
}
