/** PDF import/export actions used from menus. */
import { selectActiveNotebook, useStore } from '@/store/store'
import interWoff from '@fontsource/inter/files/inter-latin-400-normal.woff?url'
import caveatWoff from '@fontsource/caveat/files/caveat-latin-500-normal.woff?url'
import { loadPdf, readAssetBytes, readPdfPages } from './pdfjs'

async function toPng(bytes: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

/** Picks a PDF and adds its pages to the open notebook, after the current page. */
export async function importPdfIntoNotebook(): Promise<void> {
  const s = useStore.getState()
  const notebook = selectActiveNotebook(s)
  if (!notebook) return
  const result = await window.inkling.importPdf(notebook.id)
  if ('error' in result) return s.setNotice(result.error)
  if ('canceled' in result) return
  try {
    const doc = await loadPdf(notebook.id, result.asset)
    s.setNotice(`Importing “${result.name}”…`)
    const pages = await readPdfPages(doc, (done) => useStore.getState().setNotice(`Importing “${result.name}”… ${done}/${doc.numPages} pages`))
    useStore.getState().addPdfPages(
      undefined,
      result.name,
      pages.map((p, i) => ({ type: 'pdf' as const, asset: result.asset, page: i, width: p.width, height: p.height, text: p.text }))
    )
    useStore.getState().setNotice(null)
  } catch (err) {
    useStore.getState().setNotice(`Could not read this PDF: ${(err as Error).message}`)
  }
}

/** Exports the open notebook's handwritten and PDF pages, with annotations, as one PDF. */
export async function exportActiveNotebookPdf(): Promise<void> {
  const s = useStore.getState()
  const notebook = selectActiveNotebook(s)
  if (!notebook) return
  await s.flush()
  try {
    s.setNotice('Preparing PDF…')
    // pdf-lib and fontkit (~1.5 MB) are only needed here, so they load on first export.
    const { buildNotebookPdf } = await import('./exportPdf')
    const { bytes, skippedNotes } = await buildNotebookPdf(notebook, {
      getPage: async (id) => useStore.getState().pages[id] ?? (await window.inkling.loadPage(notebook.id, id)).page,
      readAsset: readAssetBytes,
      fontBytes: async () => new Uint8Array(await (await fetch(interWoff)).arrayBuffer()),
      handFontBytes: async () => new Uint8Array(await (await fetch(caveatWoff)).arrayBuffer()),
      toPng
    })
    const result = await window.inkling.exportPdf(notebook.name, bytes)
    const notes = skippedNotes ? ` (${skippedNotes} rich-text note${skippedNotes === 1 ? '' : 's'} not included)` : ''
    useStore.getState().setNotice(result.error ? `Export failed: ${result.error}` : result.saved ? `Exported to ${result.path}${notes}` : null)
  } catch (err) {
    useStore.getState().setNotice(`Export failed: ${(err as Error).message}`)
  }
}
