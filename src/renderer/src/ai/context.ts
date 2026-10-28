/**
 * Builds the smallest useful context for a tutor request from the notebook:
 * the lasso selection (as a cropped, downscaled image plus any typed text),
 * or the current page (its typed text and PDF text, plus an image of the
 * handwritten part only when there is handwriting). Images are JPEGs of at
 * most ~1024 px on the long edge.
 */
import { MAX_IMAGE_BASE64, type AiPart } from '@shared/ai'
import type { PageDoc } from '@shared/schema'
import { useStore } from '@/store/store'
import { notebookContext } from '@/services/notebookContext'
import { objectBounds, unionRects, type Rect } from '@/canvas/geometry'
import { clipRect, renderPageRegionPng } from '@/canvas/stageRef'

export type ContextKind = 'selection' | 'page' | 'none'

export const MAX_IMAGE_EDGE = 1024
const MAX_PAGE_TEXT = 6000
const MAX_NOTE_TEXT = 12_000

/** Where an image sent to the model came from, so its coordinates can be mapped back. */
export interface ImageRegion {
  pageId: string
  /** Page rectangle the image shows (page units). */
  rect: Rect
  width: number
  height: number
}

export interface BuiltContext {
  kind: Exclude<ContextKind, 'none'>
  label: string
  parts: AiPart[]
  /** Small preview of the image sent, for the chat. */
  thumb?: string
  region?: ImageRegion
}

export interface EncodedImage {
  mimeType: 'image/jpeg'
  data: string
  dataUrl: string
  width: number
  height: number
}

/** Re-encodes an image as a JPEG on white, no larger than `maxEdge`. */
export async function encodeJpeg(dataUrl: string, maxEdge = MAX_IMAGE_EDGE): Promise<EncodedImage> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  for (const [edge, quality] of [
    [maxEdge, 0.85],
    [Math.round(maxEdge * 0.75), 0.75],
    [Math.round(maxEdge * 0.5), 0.7]
  ] as const) {
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const out = canvas.toDataURL('image/jpeg', quality)
    const data = out.slice(out.indexOf(',') + 1)
    if (data.length <= MAX_IMAGE_BASE64) return { mimeType: 'image/jpeg', data, dataUrl: out, width, height }
  }
  throw new Error('The selected area is too large to send. Select a smaller part of the page.')
}

/** Renders a page region at a resolution that lands near MAX_IMAGE_EDGE. */
async function renderRegion(page: PageDoc, rect: Rect): Promise<{ image: EncodedImage; region: ImageRegion } | null> {
  const r = clipRect(rect, page)
  const pixelRatio = Math.min(2, Math.max(0.5, MAX_IMAGE_EDGE / Math.max(r.width, r.height)))
  const png = await renderPageRegionPng(page, rect, pixelRatio)
  if (!png) return null
  const image = await encodeJpeg(png)
  return { image, region: { pageId: page.id, rect: r, width: image.width, height: image.height } }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n[…truncated]` : s)

export function hasSelection(): boolean {
  const s = useStore.getState()
  return !!s.activePageId && s.selection.length > 0 && !!s.pages[s.activePageId]
}

export async function buildContext(kind: ContextKind): Promise<BuiltContext | null> {
  if (kind === 'none') return null
  const s = useStore.getState()
  const pageId = s.activePageId
  if (!pageId) return null

  if (kind === 'selection') {
    const page = s.pages[pageId]
    const ids = new Set(s.selection)
    const objects = page?.objects.filter((o) => ids.has(o.id)) ?? []
    const bounds = unionRects(objects.map(objectBounds))
    if (!page || !bounds) return null
    const rendered = await renderRegion(page, bounds)
    const typed = objects.flatMap((o) => (o.type === 'text' && o.text.trim() ? [o.text.trim()] : []))
    const parts: AiPart[] = [
      {
        text: `<selection>\nThe attached image shows the part of my page I selected (handwriting, drawings${page.background ? ', PDF' : ''}).${
          typed.length ? `\nTyped text in it:\n${clip(typed.join('\n'), MAX_PAGE_TEXT)}` : ''
        }\n</selection>`
      }
    ]
    if (rendered) parts.push({ image: { mimeType: rendered.image.mimeType, data: rendered.image.data } })
    const n = objects.length
    return { kind, label: `Selection · ${n} item${n === 1 ? '' : 's'}`, parts, thumb: rendered?.image.dataUrl, region: rendered?.region }
  }

  const content = await notebookContext.page(pageId)
  if (!content) return null
  const title = content.page.title || 'Untitled'
  if (content.kind === 'note') {
    return { kind, label: `This page · ${title}`, parts: [{ text: `<notes title="${title.replace(/"/g, "'")}">\n${clip(content.markdown, MAX_NOTE_TEXT)}\n</notes>` }] }
  }
  const page = s.pages[pageId]
  const lines = [`<page title="${title.replace(/"/g, "'")}">`]
  if (content.textBoxes.length) lines.push(`Typed text:\n${clip(content.textBoxes.join('\n'), MAX_PAGE_TEXT)}`)
  if (content.pdfText?.trim()) lines.push(`Text of the PDF page:\n${clip(content.pdfText.trim(), MAX_PAGE_TEXT)}`)
  // Handwriting and drawings can only be understood from an image: send the
  // area that has them (or the whole page over a PDF), not the empty page.
  const drawn = content.objects.filter((o) => o.type !== 'text')
  let rendered: Awaited<ReturnType<typeof renderRegion>> = null
  if (page && (drawn.length || page.background)) {
    const area = page.background ? { x: 0, y: 0, width: page.width, height: page.height } : unionRects(drawn.map(objectBounds))
    if (area) rendered = await renderRegion(page, area)
    if (rendered) lines.push('The attached image shows the handwritten part of the page.')
  }
  if (lines.length === 1) lines.push('(The page is empty.)')
  lines.push('</page>')
  const parts: AiPart[] = [{ text: lines.join('\n') }]
  if (rendered) parts.push({ image: { mimeType: rendered.image.mimeType, data: rendered.image.data } })
  return { kind, label: `This page · ${title}`, parts, thumb: rendered?.image.dataUrl, region: rendered?.region }
}
