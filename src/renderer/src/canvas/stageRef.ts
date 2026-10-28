import Konva from 'konva'
import type { PageDoc } from '@shared/schema'
import { drawPaper } from './paper'

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

/** Renders a whole page (paper + content) to PNG at page resolution × pixelRatio. */
export function renderPagePng(page: PageDoc, pixelRatio = 2): string | null {
  const world = activeCanvas.handle?.world()
  if (!world) return null
  const out = document.createElement('canvas')
  out.width = page.width * pixelRatio
  out.height = page.height * pixelRatio
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.scale(pixelRatio, pixelRatio)
  drawPaper(ctx, page.paper, page.width, page.height)

  // Re-render the content off-screen at 1:1 page scale.
  const holder = document.createElement('div')
  const stage = new Konva.Stage({ container: holder, width: page.width, height: page.height })
  const layer = new Konva.Layer()
  stage.add(layer)
  const clone = world.clone({ x: 0, y: 0, scaleX: 1, scaleY: 1 })
  layer.add(clone)
  try {
    const content = layer.toCanvas({ x: 0, y: 0, width: page.width, height: page.height, pixelRatio })
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(content, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  } finally {
    stage.destroy()
  }
}
