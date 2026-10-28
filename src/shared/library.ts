/** Read-only helpers over the library shared by the main and renderer processes. */
import type { Library, NotebookMeta, PageMeta } from './schema'

export interface PageRef {
  pageId: string
  notebookId: string
  notebookName: string
  notebookColor: string
  kind: PageMeta['kind']
  /** Title to show: the page title, or a stable fallback for untitled pages. */
  title: string
  tags: string[]
  /** 1-based position among the notebook's live pages (0 when trashed). */
  position: number
  /** The page or its notebook is in the Trash. */
  trashed: boolean
  updatedAt: number
}

export function displayTitle(notebook: NotebookMeta, page: PageMeta): string {
  if (page.title) return page.title
  const position = notebook.pages.filter((p) => p.deletedAt === null).findIndex((p) => p.id === page.id) + 1
  if (page.kind === 'note') return 'Untitled note'
  return position ? `${notebook.name} · page ${position}` : `${notebook.name} · page`
}

/** Every page in the library, keyed by id. */
export function pageRefs(library: Library): Map<string, PageRef> {
  const out = new Map<string, PageRef>()
  for (const nb of library.notebooks) {
    let position = 0
    for (const p of nb.pages) {
      const trashed = nb.deletedAt !== null || p.deletedAt !== null
      if (p.deletedAt === null) position++
      out.set(p.id, {
        pageId: p.id,
        notebookId: nb.id,
        notebookName: nb.name,
        notebookColor: nb.color,
        kind: p.kind,
        title: displayTitle(nb, p),
        tags: p.tags,
        position: p.deletedAt === null ? position : 0,
        trashed,
        updatedAt: p.updatedAt
      })
    }
  }
  return out
}

/** Internal link URL for a page; stable across renames and moves. */
export const pageLinkUrl = (pageId: string): string => `inkling://page/${pageId}`
export const PAGE_LINK_RE = /^inkling:\/\/page\/([A-Za-z0-9_-]{6,64})$/
