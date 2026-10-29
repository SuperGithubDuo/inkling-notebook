/**
 * PDF reading with pdf.js (Apache-2.0). Documents are loaded from the
 * notebook's assets and rendered on demand at the current zoom; nothing is
 * ever stored as a rasterised image.
 *
 * pdf.js itself (~750 KB) is loaded on first use, so notebooks without PDFs
 * don't pay for it at startup.
 */
import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFJS_RESOURCE_URL, assetUrl } from '@shared/ipc'

let pdfjs: Promise<typeof import('pdfjs-dist')> | null = null
function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjs) {
    pdfjs = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl
      return m
    })
    pdfjs.catch(() => (pdfjs = null)) // allow a retry after a failed load
  }
  return pdfjs
}

const docs = new Map<string, Promise<PDFDocumentProxy>>()

export async function readAssetBytes(notebookId: string, asset: string): Promise<Uint8Array> {
  const res = await fetch(assetUrl(notebookId, asset))
  if (!res.ok) throw new Error(`Could not read ${asset}`)
  return new Uint8Array(await res.arrayBuffer())
}

export function loadPdf(notebookId: string, asset: string): Promise<PDFDocumentProxy> {
  const key = `${notebookId}/${asset}`
  let doc = docs.get(key)
  if (!doc) {
    doc = Promise.all([readAssetBytes(notebookId, asset), loadPdfjs()]).then(
      ([data, { getDocument }]) =>
        getDocument({
          data,
          standardFontDataUrl: `${PDFJS_RESOURCE_URL}standard_fonts/`,
          cMapUrl: `${PDFJS_RESOURCE_URL}cmaps/`,
          cMapPacked: true,
          wasmUrl: `${PDFJS_RESOURCE_URL}wasm/`,
          iccUrl: `${PDFJS_RESOURCE_URL}iccs/`,
          // Resources are fetched through the app's own protocol by this page.
          useWorkerFetch: false,
          // XFA forms are not rendered (and no PDF scripts are ever run).
          enableXfa: false
        }).promise
    )
    doc.catch(() => docs.delete(key))
    docs.set(key, doc)
  }
  return doc
}

export interface PdfPageInfo {
  /** Page size in PDF points, after the page's own rotation. */
  width: number
  height: number
  text: string
}

/** Sizes and embedded text of every page, for creating notebook pages. */
export async function readPdfPages(doc: PDFDocumentProxy, onProgress?: (done: number) => void): Promise<PdfPageInfo[]> {
  const out: PdfPageInfo[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const { width, height } = page.getViewport({ scale: 1 })
    let text = ''
    try {
      const content = await page.getTextContent()
      text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .slice(0, 500_000)
    } catch {
      /* scanned or broken text layer: the page is still usable */
    }
    out.push({ width, height, text })
    page.cleanup()
    onProgress?.(i)
  }
  return out
}

const thumbs = new Map<string, Promise<string>>()

/** A small rendering of a PDF page, for thumbnails (kept in memory only). */
export function pdfThumbnail(notebookId: string, asset: string, pageIndex: number, width = 220): Promise<string> {
  const key = `${notebookId}/${asset}#${pageIndex}@${width}`
  let p = thumbs.get(key)
  if (!p) {
    p = (async () => {
      const doc = await loadPdf(notebookId, asset)
      const page = await doc.getPage(pageIndex + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      return canvas.toDataURL('image/png')
    })()
    p.catch(() => thumbs.delete(key))
    thumbs.set(key, p)
  }
  return p
}

export function usePdfThumbnail(notebookId: string, asset: string, pageIndex: number): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    pdfThumbnail(notebookId, asset, pageIndex).then(
      (u) => live && setUrl(u),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [notebookId, asset, pageIndex])
  return url
}
