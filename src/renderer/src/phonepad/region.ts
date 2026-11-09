/**
 * PhonePad geometry on the computer's side. Pure, so it is unit-tested.
 *
 * The phone has its own camera (infinite paper): each stroke arrives as
 * normalized (u, v) plus the page rectangle the phone showed, which has the
 * phone's aspect ratio, so (u, v) scale by the same factor on both axes and a
 * circle stays a circle on any phone, in any orientation, at any zoom.
 *
 * Here: where the phone starts (the part of the page the computer shows, in
 * the phone's shape), how much the page grows when ink goes past its edge, and
 * when the computer's view should follow the phone's frame.
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

/** Rect from a wire tuple. */
export const rectOf = ([x, y, width, height]: readonly [number, number, number, number]): Rect => ({ x, y, width, height })

/** How much to grow a page so `bounds` fits, with breathing room. */
export interface Growth {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Growth that makes `bounds` fit on the page with `margin` to spare. Amounts are
 * whole multiples of the paper spacing, so grid, lines and dots stay aligned
 * with existing ink when the page grows left or up. Capped at `max` per side.
 * Null when `bounds` already fits.
 */
export function growthFor(bounds: Rect, page: Size, spacing: number, margin: number, max: number): Growth | null {
  const step = Math.max(1, spacing)
  const need = (overflow: number): number => (overflow > 0 ? Math.ceil((overflow + margin) / step) * step : 0)
  let left = need(-bounds.x)
  let top = need(-bounds.y)
  let right = need(bounds.x + bounds.width - page.width)
  let bottom = need(bounds.y + bounds.height - page.height)
  if (!left && !top && !right && !bottom) return null
  // Never past the largest page: trim the far side first, then the near one.
  const fit = (near: number, far: number, len: number): [number, number] => {
    let excess = len + near + far - max
    if (excess <= 0) return [near, far]
    const cutFar = Math.min(far, excess)
    far -= cutFar
    excess -= cutFar
    return [Math.max(0, near - excess), far]
  }
  ;[left, right] = fit(left, right, page.width)
  ;[top, bottom] = fit(top, bottom, page.height)
  return left || top || right || bottom ? { left, top, right, bottom } : null
}

/**
 * The computer's view follows the phone lazily: only when the phone's frame
 * leaves the visible part of the view does the camera re-centre on it (zooming
 * out if the frame is bigger than the view). Null when no move is needed.
 */
export function followCamera(cam: Camera, view: Size, frame: Rect, insets = VIEW_INSETS): Camera | null {
  const visW = view.width - insets.left - insets.right
  const visH = view.height - insets.top - insets.bottom
  if (visW <= 0 || visH <= 0) return null
  const sx = frame.x * cam.scale + cam.x
  const sy = frame.y * cam.scale + cam.y
  const inside =
    sx >= insets.left - 1 &&
    sy >= insets.top - 1 &&
    sx + frame.width * cam.scale <= view.width - insets.right + 1 &&
    sy + frame.height * cam.scale <= view.height - insets.bottom + 1
  if (inside) return null
  const scale = Math.min(cam.scale, (visW * 0.9) / frame.width, (visH * 0.9) / frame.height)
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  return { scale, x: insets.left + visW / 2 - cx * scale, y: insets.top + visH / 2 - cy * scale }
}
