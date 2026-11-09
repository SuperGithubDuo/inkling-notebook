/**
 * Where on the page the phone writes.
 *
 * The phone sends normalized (u, v) in [0, 1] across its writing surface.
 * They land in the "PhonePad area": the largest rectangle with the phone's
 * aspect ratio that fits in the part of the page visible on the computer.
 * Because the area has the phone's aspect ratio, u and v are scaled by the
 * same factor (area width ÷ 1 ≡ area height ÷ (1/aspect)): a circle drawn on
 * the phone stays a circle, whatever the phone, orientation, page size, zoom
 * or screen resolution.
 *
 * Zooming the computer in shrinks the area, so the phone writes smaller and
 * more precisely ("zoomed writing"); the phone's two-finger gestures move and
 * zoom the computer's view to choose the area. Each stroke keeps the area it
 * started in, so rotating the phone or zooming mid-stroke never bends a stroke.
 * Pure, so it is unit-tested.
 */
import { screenToPage, type Camera, type Size } from '@/canvas/viewport'
import type { Rect } from '@/canvas/geometry'

export type Area = Rect

/** Room left around the edges of the canvas view: the floating tool dock sits at the bottom. */
export const VIEW_INSETS = { top: 12, right: 12, bottom: 88, left: 12 }

/** The page rectangle visible on screen (minus insets), clipped to the page. Null if none of the page shows. */
export function visiblePageRect(cam: Camera, view: Size, page: Size, insets = VIEW_INSETS): Rect | null {
  const [x0, y0] = screenToPage(cam, insets.left, insets.top)
  const [x1, y1] = screenToPage(cam, view.width - insets.right, view.height - insets.bottom)
  const left = Math.max(0, x0)
  const top = Math.max(0, y0)
  const right = Math.min(page.width, x1)
  const bottom = Math.min(page.height, y1)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The largest rectangle of `aspect` (width ÷ height) centred in `bounds`. */
export function fitAspect(bounds: Rect, aspect: number): Area {
  const a = Math.min(8, Math.max(0.15, aspect))
  let width = bounds.width
  let height = width / a
  if (height > bounds.height) {
    height = bounds.height
    width = height * a
  }
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height }
}

export function phoneArea(cam: Camera, view: Size, page: Size, aspect: number): Area | null {
  const visible = visiblePageRect(cam, view, page)
  return visible ? fitAspect(visible, aspect) : null
}

/** (u, v) on the phone → page coordinates. */
export function toPage(area: Area, u: number, v: number): [number, number] {
  return [area.x + u * area.width, area.y + v * area.height]
}

/** Page rectangle → where it sits on the phone, as [u0, v0, u1, v1]. */
export function toArea(area: Area, r: Rect): [number, number, number, number] {
  const u = (x: number): number => (x - area.x) / area.width
  const v = (y: number): number => (y - area.y) / area.height
  return [u(r.x), v(r.y), u(r.x + r.width), v(r.y + r.height)]
}

/** Screen pixels the camera should move for a phone pan of (du, dv) of the area. */
export function panToScreen(area: Area, cam: Camera, du: number, dv: number): [number, number] {
  // The area moves by (du, dv) of itself, so the page moves the other way on screen.
  return [-du * area.width * cam.scale, -dv * area.height * cam.scale]
}

/** Screen point to zoom around for a phone pinch centred at (u, v). */
export function zoomOrigin(area: Area, cam: Camera, u: number, v: number): [number, number] {
  const [x, y] = toPage(area, u, v)
  return [x * cam.scale + cam.x, y * cam.scale + cam.y]
}
