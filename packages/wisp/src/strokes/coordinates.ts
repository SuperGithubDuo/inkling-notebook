/**
 * Coordinate spaces used by WISP:
 *
 *  1. Camera space — MediaPipe's normalized image coordinates: [0,1] over the
 *     video frame, origin top-left, NOT mirrored (as the camera sees it).
 *  2. View space — camera space after optional mirroring (x → 1 − x), i.e.
 *     what the user sees in a selfie-style preview. Writing regions are
 *     defined here, so "move right" always means "cursor moves right".
 *  3. Page space — page-normalized [0,1]² (see strokes/types.ts). This is the
 *     only space strokes are stored in.
 *  4. Screen space — CSS pixels on the drawing canvas; derived from page
 *     space by letterboxing the page into the canvas (`fitPage`).
 */
import type { NormPoint } from './types'

/** A rectangle in view space (mirrored camera coordinates). */
export interface WritingRegion {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface CameraMapping {
  mirror: boolean
  /** Region of the camera view that maps to the whole page. */
  region: WritingRegion
}

export const FULL_REGION: WritingRegion = { x0: 0, y0: 0, x1: 1, y1: 1 }

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function cameraToView(p: NormPoint, mirror: boolean): NormPoint {
  return { x: mirror ? 1 - p.x : p.x, y: p.y }
}

/**
 * Default writing region: centred in the camera view, covering `coverage` of
 * the frame in its limiting dimension, with the same *pixel* aspect ratio as
 * the page so circles drawn in the air stay circles on the page.
 */
export function defaultRegion(videoAspect: number, pageAspect: number, coverage = 0.7): WritingRegion {
  if (!(videoAspect > 0) || !(pageAspect > 0)) return { ...FULL_REGION }
  const cov = clamp(coverage, 0.1, 1)
  // Width/height in normalized units; pixel aspect = (w * videoAspect) / h.
  let h = cov
  let w = (pageAspect * h) / videoAspect
  if (w > cov) {
    w = cov
    h = (w * videoAspect) / pageAspect
  }
  return { x0: 0.5 - w / 2, y0: 0.5 - h / 2, x1: 0.5 + w / 2, y1: 0.5 + h / 2 }
}

/**
 * Writing sensitivity scales the region around its centre: 2 means half the
 * hand movement covers the page, 0.5 means twice as much.
 */
export function applySensitivity(region: WritingRegion, sensitivity: number): WritingRegion {
  const s = clamp(isFiniteNumber(sensitivity) ? sensitivity : 1, 0.25, 4)
  const cx = (region.x0 + region.x1) / 2
  const cy = (region.y0 + region.y1) / 2
  const hw = (region.x1 - region.x0) / 2 / s
  const hh = (region.y1 - region.y0) / 2 / s
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }
}

/** Builds a region from two view-space corners (calibration), normalizing order. */
export function regionFromCorners(a: NormPoint, b: NormPoint, minSize = 0.08): WritingRegion | null {
  if (![a.x, a.y, b.x, b.y].every(isFiniteNumber)) return null
  const r = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
  if (r.x1 - r.x0 < minSize || r.y1 - r.y0 < minSize) return null
  return r
}

export interface MappedPoint extends NormPoint {
  /** True when the input was outside the writing region and was clamped to the page edge. */
  clamped: boolean
}

/**
 * Camera-space point → page-normalized point. Returns null for invalid input
 * (NaN, missing values) so callers never propagate bad coordinates.
 */
export function cameraToPage(p: NormPoint | null | undefined, m: CameraMapping): MappedPoint | null {
  if (!p || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return null
  const v = cameraToView(p, m.mirror)
  const { x0, y0, x1, y1 } = m.region
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0) || !(h > 0)) return null
  const ux = (v.x - x0) / w
  const uy = (v.y - y0) / h
  const x = clamp(ux, 0, 1)
  const y = clamp(uy, 0, 1)
  return { x, y, clamped: x !== ux || y !== uy }
}

/** Where the page sits inside a canvas of the given CSS size. */
export interface PageFit {
  /** CSS px offset of the page's top-left corner. */
  left: number
  top: number
  /** CSS px per page-normalized unit along x and y. */
  width: number
  height: number
}

export function fitPage(viewW: number, viewH: number, pageW: number, pageH: number, padding = 24): PageFit {
  const vw = Math.max(1, viewW - padding * 2)
  const vh = Math.max(1, viewH - padding * 2)
  const scale = Math.max(1e-6, Math.min(vw / pageW, vh / pageH))
  const width = pageW * scale
  const height = pageH * scale
  return { left: (viewW - width) / 2, top: (viewH - height) / 2, width, height }
}

export function pageToScreen(p: NormPoint, fit: PageFit): NormPoint {
  return { x: fit.left + p.x * fit.width, y: fit.top + p.y * fit.height }
}

export function screenToPage(p: NormPoint, fit: PageFit): MappedPoint {
  const ux = (p.x - fit.left) / fit.width
  const uy = (p.y - fit.top) / fit.height
  const x = clamp(ux, 0, 1)
  const y = clamp(uy, 0, 1)
  return { x, y, clamped: x !== ux || y !== uy }
}
