import Konva from 'konva'
import type { PageDoc } from '@shared/schema'
import { drawPaper } from './paper'
import type { Rect } from './geometry'
import { loadPdf } from '@/pdf/pdfjs'

/**
 * The mounted page canvas, for features outside it (toolbar image insert,
 * export, zoom shortcuts). Set by PageCanvas while it is mounted.
 */
export interface CanvasHandle {
  /** The content group in page coordinates (cloned for export). */
  world: () => Konva.Group | null
  placeImage: (asset: string) => Promise<void>
  zoom: (action: 'in' | 'out' | 'fit-width' | 'fit-page') => void
}

export const activeCanvas: { handle: CanvasHandle | null } = { handle: null }

/**
 * Renders part of a page as displayed (paper or PDF page, then content) to a
 * PNG data URL at page resolution × pixelRatio. Used for PNG export (whole
 * page) and for giving an assistant an image of a selected region.
 */
export async function renderPageRegionPng(page: PageDoc, region: Rect, pixelRatio = 2): Promise<string | null> {
  const world = activeCanvas.handle?.world()
  if (!world) return null
  const r = clipRect(region, page)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(r.width * pixelRatio))
  out.height = Math.max(1, Math.round(r.height * pixelRatio))
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, -r.x * pixelRatio, -r.y * pixelRatio)
  drawPaper(ctx, page.paper, page.width, page.height)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (page.background) {
    const doc = await loadPdf(page.notebookId, page.background.asset)
    const pdfPage = await doc.getPage(page.background.page + 1)
    const viewport = pdfPage.getViewport({ scale: (page.width / page.background.width) * pixelRatio })
    await pdfPage.render({ canvas: out, viewport, transform: [1, 0, 0, 1, -r.x * pixelRatio, -r.y * pixelRatio] }).promise
  }

  // Re-render the content off-screen at 1:1 page scale.
  const holder = document.createElement('div')
  const stage = new Konva.Stage({ container: holder, width: page.width, height: page.height })
  const layer = new Konva.Layer()
  stage.add(layer)
  layer.add(world.clone({ x: 0, y: 0, scaleX: 1, scaleY: 1 }))
  try {
    const content = layer.toCanvas({ x: r.x, y: r.y, width: r.width, height: r.height, pixelRatio })
    ctx.drawImage(content, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  } finally {
    stage.destroy()
  }
}

export function renderPagePng(page: PageDoc, pixelRatio = 2): Promise<string | null> {
  return renderPageRegionPng(page, { x: 0, y: 0, width: page.width, height: page.height }, pixelRatio)
}

/** A region padded a little and clipped to the page: exactly what renderPageRegionPng draws. */
export function clipRect(region: Rect, page: PageDoc): Rect {
  const pad = 12
  const x = Math.max(0, Math.floor(region.x - pad))
  const y = Math.max(0, Math.floor(region.y - pad))
  const right = Math.min(page.width, Math.ceil(region.x + region.width + pad))
  const bottom = Math.min(page.height, Math.ceil(region.y + region.height + pad))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
