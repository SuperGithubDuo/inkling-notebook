import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildNotebookPdf, shapePolylines, wrapText } from '../../src/renderer/src/pdf/exportPdf'
import { createNotebook, createPageDoc, createPageMeta, createPdfPageDoc, PDF_SCALE } from '../../src/shared/factory'
import type { CanvasObject, PageDoc, ShapeObject } from '../../src/shared/schema'

const root = join(import.meta.dirname, '../..')
// 2×2 red PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAWBgIBmIuL6QAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

async function sourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const a4 = doc.addPage([595.28, 841.89])
  a4.drawText("Newton's second law", { x: 72, y: 760, size: 18, font })
  const rotated = doc.addPage([400, 300])
  rotated.setRotation(degrees(90))
  rotated.drawText('Rotated source page', { x: 40, y: 150, size: 14, font })
  return doc.save()
}

async function textItems(bytes: Uint8Array, pageNo: number) {
  const pdf = await getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, standardFontDataUrl: join(root, 'node_modules/pdfjs-dist/standard_fonts/') }).promise
  const page = await pdf.getPage(pageNo)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  return {
    viewport,
    items: content.items.flatMap((it) => {
      if (!('str' in it) || !it.str.trim()) return []
      // Position on the page as displayed (points, origin top-left).
      const [, , , , x, y] = Util.transform(viewport.transform, it.transform)
      return [{ str: it.str, x, y }]
    })
  }
}

const base = { author: 'user' as const, createdAt: 0 }

describe('annotated PDF export', () => {
  it('keeps original PDF content as vectors/text and places annotations exactly, also on rotated pages', async () => {
    const src = await sourcePdf()
    const nb = createNotebook('Physics', '#f2a516', 'atom')
    const [m1, m2, m3, note] = [createPageMeta(), createPageMeta(), createPageMeta(), createPageMeta('A note', 'note')]
    nb.pages = [m1!, m2!, m3!, note!]
    const p1 = createPdfPageDoc(nb.id, m1!.id, { type: 'pdf', asset: 'abcdef123456.pdf', page: 0, width: 595.28, height: 841.89, text: '' })
    const k1 = p1.width / 595.28
    p1.objects = [
      { ...base, id: 'text-000001', type: 'text', x: 200, y: 300, width: 600, text: 'F = ma checked', color: '#e5484d', fontSize: 30, font: 'sans' },
      { ...base, id: 'stroke-0001', type: 'stroke', tool: 'pen', color: '#2563eb', size: 4, opacity: 1, hasPressure: false, points: [[100, 100], [300, 140], [500, 100]] },
      { ...base, id: 'stroke-0002', type: 'stroke', tool: 'highlighter', color: '#fde047', size: 18, opacity: 0.45, hasPressure: false, points: [[100, 200], [600, 200]] },
      { ...base, id: 'shape-0001', type: 'shape', kind: 'ellipse', x: 140, y: 560, width: 300, height: 120, rotation: 15, color: '#e5484d', strokeWidth: 3, fill: '#e5484d', fillOpacity: 0.2 },
      { ...base, id: 'image-0001', type: 'image', asset: 'abcdef654321.png', x: 700, y: 900, width: 200, height: 200, rotation: 30, naturalWidth: 2, naturalHeight: 2 }
    ] satisfies CanvasObject[]
    // Rotated source page: displayed 300 × 400 pt.
    const p2 = createPdfPageDoc(nb.id, m2!.id, { type: 'pdf', asset: 'abcdef123456.pdf', page: 1, width: 300, height: 400, text: '' })
    const k2 = p2.width / 300
    p2.objects = [{ ...base, id: 'text-000002', type: 'text', x: 50 * k2, y: 40 * k2, width: 400, text: 'Margin note', color: '#1f2430', fontSize: 24, font: 'sans' }]
    const p3: PageDoc = createPageDoc(nb.id, m3!.id, 'grid')
    p3.objects = [{ ...base, id: 'text-000003', type: 'text', x: 124, y: 124, width: 600, text: 'Blank page text', color: '#1f2430', fontSize: 26, font: 'sans' }]
    const docs = new Map([p1, p2, p3].map((p) => [p.id, p]))

    const { bytes, pages, skippedNotes } = await buildNotebookPdf(nb, {
      getPage: (id) => docs.get(id) ?? null,
      readAsset: async (_nb, asset) => (asset.endsWith('.pdf') ? src : PNG),
      fontBytes: () => readFile(join(root, 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff')).then((b) => new Uint8Array(b))
    })
    expect(pages).toBe(3)
    expect(skippedNotes).toBe(1)

    const out = await PDFDocument.load(bytes)
    expect(out.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 })
    expect(out.getPage(1).getRotation().angle).toBe(90)
    expect(out.getPage(2).getWidth()).toBeCloseTo(p3.width / PDF_SCALE, 1)

    const page1 = await textItems(bytes, 1)
    const original = page1.items.find((i) => i.str.includes('Newton'))
    expect(original, 'original PDF text is still text').toBeDefined()
    const note1 = page1.items.find((i) => i.str.includes('F = ma'))!
    expect(note1.x).toBeCloseTo(200 / k1, 0)
    const baseline = (300 + (30 * 1.3) / 2 + 30 * 0.35) / k1
    expect(Math.abs(note1.y - baseline)).toBeLessThan(1)

    const page2 = await textItems(bytes, 2)
    expect(page2.viewport.width).toBeCloseTo(300, 1)
    expect(page2.viewport.height).toBeCloseTo(400, 1)
    expect(page2.items.some((i) => i.str.includes('Rotated source'))).toBe(true)
    const margin = page2.items.find((i) => i.str.includes('Margin'))!
    // Same displayed position as on screen, despite the page's /Rotate 90.
    expect(margin.x).toBeCloseTo(50, 0)
    expect(Math.abs(margin.y - (40 * k2 + (24 * 1.3) / 2 + 24 * 0.35) / k2)).toBeLessThan(1)

    const page3 = await textItems(bytes, 3)
    expect(page3.items.map((i) => i.str).join(' ')).toContain('Blank page text')
  })

  it('falls back to Helvetica when no font is available', async () => {
    const nb = createNotebook('X', '#3b6fe0', 'book')
    const doc = createPageDoc(nb.id, nb.pages[0]!.id)
    doc.objects = [{ ...base, id: 'text-000004', type: 'text', x: 10, y: 10, width: 300, text: 'Plain', color: '#000000', fontSize: 20, font: 'sans' }]
    const { bytes } = await buildNotebookPdf(nb, { getPage: () => doc, readAsset: async () => new Uint8Array() })
    expect((await textItems(bytes, 1)).items.map((i) => i.str)).toContain('Plain')
  })

  it('exports the tutor’s handwriting-style notes in Caveat, falling back for missing characters', async () => {
    const nb = createNotebook('AI', '#3b6fe0', 'book')
    const doc = createPageDoc(nb.id, nb.pages[0]!.id)
    doc.objects = [
      { ...base, id: 'text-000005', author: 'ai', type: 'text', x: 10, y: 10, width: 400, text: '2x = 8', color: '#e5484d', fontSize: 26, font: 'hand' },
      { ...base, id: 'text-000006', author: 'ai', type: 'text', x: 10, y: 60, width: 400, text: 'so x = 4 → √', color: '#6d63f0', fontSize: 26, font: 'hand' }
    ]
    const font = (f: string) => () => readFile(join(root, 'node_modules/@fontsource', f)).then((b) => new Uint8Array(b))
    const { bytes } = await buildNotebookPdf(nb, { getPage: () => doc, readAsset: async () => new Uint8Array(), fontBytes: font('inter/files/inter-latin-400-normal.woff'), handFontBytes: font('caveat/files/caveat-latin-500-normal.woff') })
    const pdf = await PDFDocument.load(bytes)
    const fonts = pdf.context.enumerateIndirectObjects().map(([, o]) => String((o as { get?: (k: unknown) => unknown }).get?.(pdf.context.obj('BaseFont')) ?? '')).filter(Boolean)
    expect(fonts.some((f) => /Caveat/i.test(f))).toBe(true)
    expect((await textItems(bytes, 1)).items.map((i) => i.str).join(' ')).toContain('2x = 8')
  })

  it('refuses a notebook with nothing exportable', async () => {
    const nb = createNotebook('Notes only', '#3b6fe0', 'book')
    nb.pages = [createPageMeta('n', 'note')]
    await expect(buildNotebookPdf(nb, { getPage: () => null, readAsset: async () => new Uint8Array() })).rejects.toThrow(/no handwritten or PDF pages/)
  })

  it('outlines rotated shapes and arrow heads in page coordinates', () => {
    const rect: ShapeObject = { ...base, id: 'shape-0002', type: 'shape', kind: 'rect', x: 10, y: 20, width: 100, height: 50, rotation: 90, color: '#000000', strokeWidth: 2, fill: null, fillOpacity: 0 }
    const [outline] = shapePolylines(rect)
    expect(outline!.points[1]![0]).toBeCloseTo(10)
    expect(outline!.points[1]![1]).toBeCloseTo(120)
    const arrow = shapePolylines({ ...rect, kind: 'arrow', rotation: 0 })
    expect(arrow).toHaveLength(2)
    expect(arrow[1]!.points[1]).toEqual([110, 70])
  })

  it('wraps text by measured width', () => {
    expect(wrapText('aa bb cc', 5, (s) => s.length)).toEqual(['aa bb', 'cc'])
    expect(wrapText('one\ntwo', 100, (s) => s.length)).toEqual(['one', 'two'])
  })
})
