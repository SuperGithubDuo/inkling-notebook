/**
 * The notebook as seen by an assistant: a small, typed API that a future AI
 * integration (Phase 4–5) calls instead of reaching into UI components.
 *
 * Reading: page outlines, structured note content (JSON and Markdown), canvas
 * objects, PDF text, search, links, and the current lasso selection (as
 * objects plus an image of that region, for handwriting the app can't read).
 *
 * Writing goes only through validated paths: typed canvas commands tagged as
 * AI content (one undoable step, never touching the user's own objects unless
 * allowed) and appending Markdown to a note. Nothing here talks to a model or
 * the network; that layer will live separately.
 */
import type { CanvasObject, NoteNode, PageDoc } from '@shared/schema'
import type { PageRef } from '@shared/library'
import type { Connections, SearchHit } from '@shared/search'
import { noteToPlainText } from '@shared/noteText'
import { useStore, type RunResult } from '@/store/store'
import type { CanvasCommand } from '@/canvas/commands'
import { objectBounds, unionRects, type Rect } from '@/canvas/geometry'
import { clipRect, renderPageRegionPng } from '@/canvas/stageRef'
import { docToMarkdown, markdownToDoc } from '@/notes/format'
import { currentPageRefs, resolvePage } from '@/notes/pages'

export type PageContent =
  | { kind: 'note'; page: PageRef; markdown: string; text: string; doc: NoteNode }
  | {
      kind: 'canvas'
      page: PageRef
      size: { width: number; height: number }
      objects: CanvasObject[]
      /** Typed text on the page (text boxes). Handwriting is not text. */
      textBoxes: string[]
      /** Embedded text of the PDF page underneath, if any. */
      pdfText: string | null
    }

export interface SelectionContext {
  pageId: string
  objects: CanvasObject[]
  /** Region of the page covered by the selection (page units). */
  bounds: Rect
  /** PNG data URL of that region as displayed (ink, shapes, PDF), for vision models. */
  image: string | null
  /** The page rectangle the image shows (the bounds plus a small margin). */
  imageRect: Rect
}

async function pageDoc(pageId: string, notebookId: string): Promise<PageDoc | null> {
  return useStore.getState().pages[pageId] ?? (await window.inkling.loadPage(notebookId, pageId)).page
}

export const notebookContext = {
  /** Every live page and note, with notebook, title and tags. */
  outline(): PageRef[] {
    return [...currentPageRefs().values()].filter((p) => !p.trashed)
  },

  async page(pageId: string): Promise<PageContent | null> {
    const ref = currentPageRefs().get(pageId)
    if (!ref || ref.trashed) return null
    if (ref.kind === 'note') {
      const note = useStore.getState().notes[pageId] ?? (await window.inkling.loadNote(ref.notebookId, pageId)).note
      if (!note) return null
      return { kind: 'note', page: ref, doc: note.doc, text: noteToPlainText(note.doc), markdown: docToMarkdown(note.doc, { pages: { resolve: resolvePage } }) }
    }
    const doc = await pageDoc(pageId, ref.notebookId)
    if (!doc) return null
    return {
      kind: 'canvas',
      page: ref,
      size: { width: doc.width, height: doc.height },
      objects: doc.objects,
      textBoxes: doc.objects.flatMap((o) => (o.type === 'text' ? [o.text] : [])),
      pdfText: doc.background?.text ?? null
    }
  },

  search(query: string, options?: { notebookId?: string; limit?: number }): Promise<SearchHit[]> {
    return window.inkling.search(query, options)
  },

  connections(pageId: string): Promise<Connections> {
    return window.inkling.connections(pageId)
  },

  /** The lasso selection on the open page, or null if nothing is selected. */
  async selection(options: { pixelRatio?: number } = {}): Promise<SelectionContext | null> {
    const s = useStore.getState()
    const page = s.activePageId ? s.pages[s.activePageId] : undefined
    if (!page || !s.selection.length) return null
    const ids = new Set(s.selection)
    const objects = page.objects.filter((o) => ids.has(o.id))
    const bounds = unionRects(objects.map(objectBounds))
    if (!bounds) return null
    return { pageId: page.id, objects, bounds, imageRect: clipRect(bounds, page), image: await renderPageRegionPng(page, bounds, options.pixelRatio) }
  },

  /**
   * Applies canvas commands as AI-authored content (one undoable step).
   * Editing the user's own objects requires `allowEditUserContent`.
   */
  applyCanvasCommands(pageId: string, commands: CanvasCommand[], options: { label?: string; allowEditUserContent?: boolean } = {}): RunResult {
    return useStore.getState().run(commands, {
      pageId,
      label: options.label ?? 'AI edit',
      context: { author: 'ai', allowEditUserContent: options.allowEditUserContent ?? false }
    })
  },

  /** Appends Markdown (sanitised like any import) to the end of a note. */
  appendToNote(pageId: string, markdown: string): boolean {
    const note = useStore.getState().notes[pageId]
    if (!note) return false
    const addition = markdownToDoc(markdown).content ?? []
    useStore.getState().updateNote(pageId, appendBlocks(note.doc, addition))
    return true
  }
}

/** Appends blocks to a document, dropping a trailing empty paragraph first. */
export function appendBlocks(doc: NoteNode, blocks: NoteNode[]): NoteNode {
  const content = [...(doc.content ?? [])]
  const last = content[content.length - 1]
  if (last?.type === 'paragraph' && !last.content?.length) content.pop()
  return { ...doc, content: [...content, ...blocks] }
}
