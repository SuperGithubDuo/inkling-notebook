/**
 * Camera for the page view. Screen = page * scale + (x, y), in CSS pixels
 * relative to the canvas container. Pure functions, so they are unit-tested.
 */
export interface Camera {
  scale: number
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export const MAX_SCALE = 8
const EDGE = 48 // how far a page edge may be pulled into view
const BOTTOM_EXTRA = 96 // room for the floating dock under the page

export function minScale(page: Size, view: Size): number {
  return Math.min(fitPage(page, view).scale * 0.5, 0.25)
}

/** Page width fills the view, top of page at the top (the default view). */
export function fitWidth(page: Size, view: Size): Camera {
  const scale = view.width / page.width
  return clamp({ scale, x: 0, y: 0 }, page, view)
}

/** Whole page visible and centred. */
export function fitPage(page: Size, view: Size): Camera {
  const scale = Math.min(view.width / page.width, (view.height - 24) / page.height) * 0.96
  return { scale, x: (view.width - page.width * scale) / 2, y: (view.height - page.height * scale) / 2 }
}

/** Keeps the page reachable: centred when smaller than the view, edges bounded when larger. */
export function clamp(cam: Camera, page: Size, view: Size): Camera {
  const axis = (pos: number, pageLen: number, viewLen: number, extraEnd: number): number => {
    if (pageLen <= viewLen) return (viewLen - pageLen) / 2
    return Math.min(EDGE, Math.max(viewLen - pageLen - EDGE - extraEnd, pos))
  }
  const w = page.width * cam.scale
  const h = page.height * cam.scale
  // At exactly fit-width there is nothing to pan horizontally.
  const x = Math.abs(w - view.width) < 0.5 ? 0 : axis(cam.x, w, view.width, 0)
  return { scale: cam.scale, x, y: axis(cam.y, h, view.height, BOTTOM_EXTRA) }
}

/** Zooms by `factor`, keeping the page point under (sx, sy) fixed on screen. */
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number, page: Size, view: Size): Camera {
  const scale = Math.max(minScale(page, view), Math.min(MAX_SCALE, cam.scale * factor))
  const k = scale / cam.scale
  return clamp({ scale, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k }, page, view)
}

export function panBy(cam: Camera, dx: number, dy: number, page: Size, view: Size): Camera {
  return clamp({ ...cam, x: cam.x + dx, y: cam.y + dy }, page, view)
}

export function screenToPage(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.x) / cam.scale, (sy - cam.y) / cam.scale]
}
