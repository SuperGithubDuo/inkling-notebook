/**
 * Annotated PDF export with pdf-lib (MIT).
 *
 * PDF-backed pages are copied from the original file unchanged (text, vectors
 * and images stay as they were) and the annotations are drawn on top as
 * vectors: ink as filled outlines, shapes as paths, text as real text, images
 * embedded. Handwritten pages become pages of the same proportions with their
 * paper drawn as fine lines. Rich-text notes are not part of the export.
 */
import { BlendMode, LineCapStyle, PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState, rgb, type Color } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { CanvasObject, ImageObject, NotebookMeta, PageDoc, ShapeObject, StrokeObject, TextObject } from '@shared/schema'
import { PDF_SCALE } from '@shared/factory'
import { outlinePathExplicit } from '@/canvas/ink'
import { arrowHeadSize, TEXT_LINE_HEIGHT } from '@/canvas/geometry'

export interface ExportDeps {
  /** Loads a page document by id (from memory or disk). */
  getPage: (pageId: string) => PageDoc | null | Promise<PageDoc | null>
  /** Reads an asset of the notebook (PDF or image bytes). */
  readAsset: (notebookId: string, asset: string) => Promise<Uint8Array>
  /** Font for text annotations (TTF/OTF/WOFF). Falls back to Helvetica. */
  fontBytes?: () => Promise<Uint8Array>
  /** Handwriting font for 'hand' text (the AI tutor's notes). Falls back to the main font. */
  handFontBytes?: () => Promise<Uint8Array>
  /** Converts GIF/WebP images to PNG (needs a browser canvas). */
  toPng?: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface ExportResult {
  bytes: Uint8Array
  pages: number
  skippedNotes: number
}

const PAPER_STROKE = rgb(0.86, 0.88, 0.91)

export function hexColor(hex: string): Color {
  const n = Number.parseInt(hex.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

type Vec = [number, number]

/** A shape's outline(s) as polylines in page coordinates. */
export function shapePolylines(s: ShapeObject): { points: Vec[]; closed: boolean }[] {
  const rad = (s.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const place = (pts: Vec[]): Vec[] => pts.map(([lx, ly]) => [s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos])
  const { width: w, height: h } = s
  switch (s.kind) {
    case 'rect':
      return [{ points: place([[0, 0], [w, 0], [w, h], [0, h]]), closed: true }]
    case 'triangle':
      return [{ points: place([[w / 2, 0], [w, h], [0, h]]), closed: true }]
    case 'ellipse':
      return [
        {
          points: place(Array.from({ length: 96 }, (_, i): Vec => [w / 2 + (Math.cos((i / 96) * Math.PI * 2) * w) / 2, h / 2 + (Math.sin((i / 96) * Math.PI * 2) * h) / 2])),
          closed: true
        }
      ]
    case 'line':
      return [{ points: place([[0, 0], [w, h]]), closed: false }]
    case 'arrow': {
      const lines: { points: Vec[]; closed: boolean }[] = [{ points: place([[0, 0], [w, h]]), closed: false }]
      const len = Math.hypot(w, h)
      if (len >= 1) {
        const head = Math.min(arrowHeadSize(s.strokeWidth), len * 0.6)
        const a = Math.atan2(h, w)
        const spread = Math.PI / 7
        lines.push({
          points: place([
            [w - head * Math.cos(a - spread), h - head * Math.sin(a - spread)],
            [w, h],
            [w - head * Math.cos(a + spread), h - head * Math.sin(a + spread)]
          ]),
          closed: false
        })
      }
      return lines
    }
  }
}

const pathOf = (points: Vec[], closed: boolean): string =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('') + (closed ? 'Z' : '')

/** Greedy word wrap using real font metrics, like the canvas text box. */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (line && measure(next) > width) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

/**
 * Sets up `page` so drawing calls use the page as displayed: origin at the
 * bottom-left of the visible area, y up, honouring the PDF's /Rotate and
 * crop box. Returns the displayed size in points.
 */
function enterDisplaySpace(page: PDFPage): { width: number; height: number } {
  const crop = page.getCropBox()
  const angle = ((page.getRotation().angle % 360) + 360) % 360
  const { x: cx, y: cy, width: W, height: H } = crop
  let m: [number, number, number, number, number, number]
  if (angle === 90) m = [0, 1, -1, 0, W, 0]
  else if (angle === 180) m = [-1, 0, 0, -1, W, H]
  else if (angle === 270) m = [0, -1, 1, 0, 0, H]
  else m = [1, 0, 0, 1, 0, 0]
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4] + cx, m[5] + cy))
  return angle === 90 || angle === 270 ? { width: H, height: W } : { width: W, height: H }
}

class Painter {
  constructor(
    private readonly page: PDFPage,
    /** Page units per point. */
    private readonly k: number,
    /** Displayed page height in points. */
    private readonly height: number,
    private readonly font: PDFFont,
    private readonly embedImage: (o: ImageObject) => Promise<PDFImage>,
    private readonly handFont: { font: PDFFont; chars: Set<number> } | null = null
  ) {}

  /** The handwriting font for 'hand' text when it has every character needed. */
  private fontFor(t: TextObject): PDFFont {
    if (t.font !== 'hand' || !this.handFont) return this.font
    const { font, chars } = this.handFont
    for (const ch of t.text) if (ch !== '\n' && !chars.has(ch.codePointAt(0)!)) return this.font
    return font
  }

  /** SVG path data in page units → drawn in place. */
  private path(d: string, options: Parameters<PDFPage['drawSvgPath']>[1]): void {
    this.page.drawSvgPath(d, { x: 0, y: this.height, scale: 1 / this.k, ...options })
  }

  stroke(s: StrokeObject): void {
    const d = outlinePathExplicit(s.points, s)
    if (!d) return
    this.path(d, {
      color: hexColor(s.color),
      opacity: s.opacity,
      borderWidth: 0,
      blendMode: s.tool === 'highlighter' ? BlendMode.Multiply : BlendMode.Normal
    })
  }

  shape(s: ShapeObject): void {
    const lines = shapePolylines(s)
    const width = s.strokeWidth / this.k
    for (const { points, closed } of lines) {
      const d = pathOf(points, closed)
      if (closed && s.fill && s.fillOpacity > 0) this.path(d, { color: hexColor(s.fill), opacity: s.fillOpacity, borderWidth: 0 })
      this.path(d, { borderColor: hexColor(s.color), borderWidth: width, borderLineCap: LineCapStyle.Round })
    }
  }

  text(t: TextObject): void {
    const size = t.fontSize / this.k
    const lineHeight = t.fontSize * TEXT_LINE_HEIGHT
    const font = this.fontFor(t)
    const lines = wrapText(t.text, t.width, (s) => font.widthOfTextAtSize(s, t.fontSize))
    lines.forEach((line, i) => {
      if (!line) return
      // Konva centres each line in its line box; the baseline sits ~0.35em below the middle.
      const baseline = t.y + i * lineHeight + lineHeight / 2 + t.fontSize * 0.35
      this.page.drawText(line, { x: t.x / this.k, y: this.height - baseline / this.k, size, font, color: hexColor(t.color) })
    })
  }

  async image(o: ImageObject): Promise<void> {
    const img = await this.embedImage(o)
    const rad = (o.rotation * Math.PI) / 180
    // pdf-lib rotates around the image's bottom-left corner.
    const blx = o.x - o.height * Math.sin(rad)
    const bly = o.y + o.height * Math.cos(rad)
    this.page.drawImage(img, {
      x: blx / this.k,
      y: this.height - bly / this.k,
      width: o.width / this.k,
      height: o.height / this.k,
      rotate: degrees(-o.rotation)
    })
  }

  async object(o: CanvasObject): Promise<void> {
    if (o.type === 'stroke') this.stroke(o)
    else if (o.type === 'shape') this.shape(o)
    else if (o.type === 'text') this.text(o)
    else await this.image(o)
  }

  paper(doc: PageDoc): void {
    const { type, spacing } = doc.paper
    const W = doc.width
    const H = doc.height
    const line = (x1: number, y1: number, x2: number, y2: number): void =>
      this.page.drawLine({ start: { x: x1 / this.k, y: this.height - y1 / this.k }, end: { x: x2 / this.k, y: this.height - y2 / this.k }, thickness: 0.4, color: PAPER_STROKE })
    if (type === 'grid') {
      for (let x = spacing; x < W; x += spacing) line(x, 0, x, H)
      for (let y = spacing; y < H; y += spacing) line(0, y, W, y)
    } else if (type === 'lined') {
      for (let y = spacing; y < H; y += spacing) line(0, y, W, y)
    } else if (type === 'dotted') {
      for (let x = spacing / 2; x < W; x += spacing)
        for (let y = spacing / 2; y < H; y += spacing)
          this.page.drawCircle({ x: x / this.k, y: this.height - y / this.k, size: 0.6, color: PAPER_STROKE })
    }
  }
}

export async function buildNotebookPdf(notebook: NotebookMeta, deps: ExportDeps): Promise<ExportResult> {
  const out = await PDFDocument.create()
  out.setTitle(notebook.name)
  out.setCreator('Inkling')
  out.registerFontkit(fontkit)
  let font: PDFFont
  try {
    if (!deps.fontBytes) throw new Error('no font')
    font = await out.embedFont(await deps.fontBytes(), { subset: true })
  } catch {
    font = await out.embedFont(StandardFonts.Helvetica)
  }
  let handFont: { font: PDFFont; chars: Set<number> } | null = null
  try {
    if (deps.handFontBytes) {
      const f = await out.embedFont(await deps.handFontBytes(), { subset: true })
      handFont = { font: f, chars: new Set(f.getCharacterSet()) }
    }
  } catch {
    handFont = null
  }

  const sources = new Map<string, Promise<PDFDocument>>()
  const source = (asset: string): Promise<PDFDocument> => {
    let p = sources.get(asset)
    if (!p) {
      p = deps.readAsset(notebook.id, asset).then((b) => PDFDocument.load(b, { ignoreEncryption: true }))
      sources.set(asset, p)
    }
    return p
  }
  const images = new Map<string, Promise<PDFImage>>()
  const embedImage = (o: ImageObject): Promise<PDFImage> => {
    let p = images.get(o.asset)
    if (!p) {
      p = (async () => {
        const bytes = await deps.readAsset(notebook.id, o.asset)
        if (o.asset.endsWith('.png')) return out.embedPng(bytes)
        if (o.asset.endsWith('.jpg') || o.asset.endsWith('.jpeg')) return out.embedJpg(bytes)
        if (!deps.toPng) throw new Error(`Cannot embed ${o.asset}`)
        return out.embedPng(await deps.toPng(bytes))
      })()
      images.set(o.asset, p)
    }
    return p
  }

  let pages = 0
  let skippedNotes = 0
  for (const meta of notebook.pages) {
    if (meta.deletedAt !== null) continue
    if (meta.kind === 'note') {
      skippedNotes++
      continue
    }
    const doc = await deps.getPage(meta.id)
    if (!doc) continue
    let page: PDFPage
    let size: { width: number; height: number }
    let k: number
    if (doc.background) {
      const [copied] = await out.copyPages(await source(doc.background.asset), [doc.background.page])
      page = out.addPage(copied!)
      size = enterDisplaySpace(page)
      k = doc.width / size.width
    } else {
      k = PDF_SCALE
      page = out.addPage([doc.width / k, doc.height / k])
      size = enterDisplaySpace(page)
    }
    const painter = new Painter(page, k, size.height, font, embedImage, handFont)
    if (!doc.background) painter.paper(doc)
    for (const o of doc.objects) await painter.object(o)
    page.pushOperators(popGraphicsState())
    pages++
  }
  if (!pages) throw new Error('This notebook has no handwritten or PDF pages to export.')
  return { bytes: await out.save(), pages, skippedNotes }
}
