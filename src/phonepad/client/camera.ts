/**
 * The phone's own camera over the page: infinite paper. Pure, so unit-tested.
 *
 * `x, y` is the page point at the surface's top-left corner and `scale` is
 * CSS pixels per page unit. Panning and zooming happen here, on the phone,
 * with no round trip; the desktop is told where the phone is looking.
 */
export interface PhoneCamera {
  x: number
  y: number
  scale: number
}

export type PageRect = [number, number, number, number]

/** How far out and in the phone may zoom: its view spans 40 to 24 000 page units. */
export const MIN_VIEW_WIDTH = 40
export const MAX_VIEW_WIDTH = 24000
/** How far past the page the paper reaches (the largest page is 20 000 units a side). */
export const REACH = 20000

const round = (v: number): number => Math.round(v * 1000) / 1000

export function toPage(cam: PhoneCamera, sx: number, sy: number): [number, number] {
  return [cam.x + sx / cam.scale, cam.y + sy / cam.scale]
}

export function toScreen(cam: PhoneCamera, px: number, py: number): [number, number] {
  return [(px - cam.x) * cam.scale, (py - cam.y) * cam.scale]
}

/** The page rectangle a `width`×`height` surface shows. */
export function viewRect(cam: PhoneCamera, width: number, height: number): PageRect {
  return [round(cam.x), round(cam.y), round(width / cam.scale), round(height / cam.scale)]
}

/** A camera showing `rect` across a surface: its width fills the surface, centred vertically. */
export function fromRect(rect: PageRect, width: number, height: number): PhoneCamera {
  const scale = clampScale(width / rect[2], width)
  const cy = rect[1] + rect[3] / 2
  return keepNear({ x: rect[0] + rect[2] / 2 - width / 2 / scale, y: cy - height / 2 / scale, scale }, width, height)
}

function clampScale(scale: number, width: number): number {
  return Math.min(width / MIN_VIEW_WIDTH, Math.max(width / MAX_VIEW_WIDTH, scale))
}

/** The paper is huge but not unbounded: keep the view's centre within reach of the page. */
function keepNear(cam: PhoneCamera, width: number, height: number, page = { width: 0, height: 0 }): PhoneCamera {
  const cx = cam.x + width / 2 / cam.scale
  const cy = cam.y + height / 2 / cam.scale
  const nx = Math.min(page.width + REACH, Math.max(-REACH, cx))
  const ny = Math.min(page.height + REACH, Math.max(-REACH, cy))
  return { scale: cam.scale, x: cam.x + nx - cx, y: cam.y + ny - cy }
}

/** Pans by screen pixels (the paper follows the finger). */
export function panBy(cam: PhoneCamera, dx: number, dy: number, width: number, height: number, page?: { width: number; height: number }): PhoneCamera {
  return keepNear({ ...cam, x: cam.x - dx / cam.scale, y: cam.y - dy / cam.scale }, width, height, page)
}

/**
 * Two fingers moved from midpoint `a` (spread `da`) to midpoint `b` (spread `db`):
 * the page point under the fingers stays under them while the paper zooms.
 */
export function pinch(
  cam: PhoneCamera,
  a: [number, number],
  b: [number, number],
  da: number,
  db: number,
  width: number,
  height: number,
  page?: { width: number; height: number }
): PhoneCamera {
  const [px, py] = toPage(cam, a[0], a[1])
  const scale = clampScale(cam.scale * (db / Math.max(1, da)), width)
  return keepNear({ scale, x: px - b[0] / scale, y: py - b[1] / scale }, width, height, page)
}

/** Zooms by `factor` around a screen point (mouse wheel, trackpad). */
export function zoomAt(cam: PhoneCamera, factor: number, sx: number, sy: number, width: number, height: number, page?: { width: number; height: number }): PhoneCamera {
  return pinch(cam, [sx, sy], [sx, sy], 100, 100 * factor, width, height, page)
}

export interface Paper {
  type: 'grid' | 'lined' | 'dotted' | 'blank'
  spacing: number
  color: string
}

/** Margin line on lined paper, as Inkling draws it (page units from the left edge). */
export const LINED_MARGIN = 120

/**
 * Where the paper's lines fall inside a page range [from, to): the same
 * positions Inkling's own paper uses (multiples of the spacing from the page
 * origin, extended past the page), so the phone's paper lines up exactly with
 * the desktop's picture of the page.
 */
export function paperLines(paper: Paper, from: number, to: number, axis: 'x' | 'y'): number[] {
  const s = paper.spacing
  if (paper.type === 'blank' || s <= 0) return []
  // Grid: lines at k·s on both axes. Lined: rows at k·s − 1. Dotted: dots at s/2 + k·s.
  if (paper.type === 'lined' && axis === 'x') return []
  const offset = paper.type === 'lined' ? s - 1 : paper.type === 'dotted' ? s / 2 : 0
  const out: number[] = []
  const first = Math.ceil((from - offset) / s)
  for (let k = first; offset + k * s < to && out.length < 4000; k++) out.push(offset + k * s)
  return out
}
