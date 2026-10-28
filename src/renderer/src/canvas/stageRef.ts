import type Konva from 'konva'
import type { PageDoc } from '@shared/schema'
import { drawPaper } from './paper'

/** The currently mounted page stage, for features outside the canvas (export). */
export const activeStage: { stage: Konva.Stage | null; scale: number } = { stage: null, scale: 1 }

/** Renders a page (paper + content) to a PNG data URL at page resolution × `pixelRatio`. */
export function renderPagePng(page: PageDoc, pixelRatio = 2): string | null {
  const { stage, scale } = activeStage
  if (!stage) return null
  const out = document.createElement('canvas')
  out.width = page.width * pixelRatio
  out.height = page.height * pixelRatio
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.scale(pixelRatio, pixelRatio)
  drawPaper(ctx, page.paper, page.width, page.height)
  const content = stage.toCanvas({ pixelRatio: pixelRatio / scale })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(content, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}
