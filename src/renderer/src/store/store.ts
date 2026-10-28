import { create } from 'zustand'
import {
  PAPER_DEFAULTS,
  createNotebook as makeNotebook,
  createPageDoc,
  createPageMeta,
  newId
} from '@shared/factory'
import type { Library, NotebookIcon, NotebookMeta, PageDoc, PaperType } from '@shared/schema'
import { HISTORY_LIMIT, applyTransaction, invertTransaction, type PageHistory, type Transaction } from '@/canvas/history'
import { SaveQueue, type SaveStatus } from '@/services/saveQueue'

export type Section = 'notebooks' | 'all' | 'favorites' | 'shared' | 'trash'
export type View = { kind: 'library'; section: Section } | { kind: 'notebook' }
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text'

export const INK_COLORS = ['#1f2430', '#2563eb', '#e5484d'] as const
export const HIGHLIGHT_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4'] as const
export const PEN_SIZES = [2.5, 4, 6.5] as const

export interface Conflict {
  pageId: string
  conflictPath: string
}

interface State {
  ready: boolean
  loadError: string | null
  dataDir: string
  recovered: string[]
  library: Library | null
  view: View
  activeNotebookId: string | null
  activePageId: string | null
  pages: Record<string, PageDoc>
  history: Record<string, PageHistory>
  conflicts: Conflict[]
  saveStatus: SaveStatus

  tool: Tool
  penColor: string
  penSize: number
  highlightColor: string
  highlightSize: number
  eraserSize: number

  sidebarOpen: boolean
  navigatorOpen: boolean
  tutorOpen: boolean
  search: string
}

interface Actions {
  init(): Promise<void>
  flush(): Promise<void>
  showSection(section: Section): void
  openNotebook(notebookId: string, pageId?: string): Promise<void>
  selectPage(pageId: string): void

  createNotebook(name?: string): string
  renameNotebook(id: string, name: string): void
  styleNotebook(id: string, style: { color?: string; icon?: NotebookIcon }): void
  toggleFavorite(id: string): void
  trashNotebook(id: string): void
  restoreNotebook(id: string): void
  deleteNotebookForever(id: string): Promise<void>

  addPage(afterPageId?: string, paper?: PaperType): void
  duplicatePage(pageId: string): void
  trashPage(pageId: string): void
  restorePage(notebookId: string, pageId: string): void
  deletePageForever(notebookId: string, pageId: string): Promise<void>
  movePage(pageId: string, toIndex: number): void
  setPaper(pageId: string, paper: PaperType): void
  resolveConflictWithDisk(pageId: string): Promise<void>

  commit(pageId: string, tx: Transaction): void
  undo(): void
  redo(): void

  setTool(tool: Tool): void
  setColor(color: string): void
  setSize(size: number): void
  toggle(panel: 'sidebarOpen' | 'navigatorOpen' | 'tutorOpen'): void
  setSearch(q: string): void
}

export type Store = State & Actions

const notebookOf = (lib: Library | null, id: string | null): NotebookMeta | undefined =>
  lib?.notebooks.find((n) => n.id === id)

export const livePages = (nb: NotebookMeta | undefined) => nb?.pages.filter((p) => p.deletedAt === null) ?? []

export const useStore = create<Store>()((set, get) => {
  const saver = new SaveQueue({
    getPage: (id) => get().pages[id],
    getLibrary: () => get().library,
    isBlocked: (id) => get().conflicts.some((c) => c.pageId === id),
    onStatus: (saveStatus) => set({ saveStatus }),
    onConflict: (pageId, conflictPath) =>
      set((s) => ({ conflicts: [...s.conflicts.filter((c) => c.pageId !== pageId), { pageId, conflictPath }] }))
  })

  /** Applies an immutable update to the library and schedules a save. */
  const updateLibrary = (fn: (lib: Library) => Library): void => {
    const lib = get().library
    if (!lib) return
    set({ library: fn(lib) })
    saver.markLibrary()
  }

  const updateNotebook = (id: string, fn: (nb: NotebookMeta) => NotebookMeta): void =>
    updateLibrary((lib) => ({ ...lib, notebooks: lib.notebooks.map((n) => (n.id === id ? fn(n) : n)) }))

  const touchPage = (notebookId: string, pageId: string): void => {
    const now = Date.now()
    updateNotebook(notebookId, (nb) => ({
      ...nb,
      updatedAt: now,
      pages: nb.pages.map((p) => (p.id === pageId ? { ...p, updatedAt: now } : p))
    }))
  }

  async function ensurePageLoaded(notebookId: string, pageId: string): Promise<void> {
    if (get().pages[pageId]) return
    let page: PageDoc | null = null
    try {
      const result = await window.inkling.loadPage(notebookId, pageId)
      page = result.page
      if (result.recovered) set((s) => ({ recovered: [...s.recovered, `page ${pageId.slice(0, 8)}`] }))
    } catch (err) {
      set({ saveStatus: { state: 'error', message: `Could not open page: ${(err as Error).message}` } })
      return
    }
    if (!page) {
      page = createPageDoc(notebookId, pageId)
      set((s) => ({ pages: { ...s.pages, [pageId]: page! } }))
      saver.markPage(pageId)
    } else {
      set((s) => ({ pages: { ...s.pages, [pageId]: page! } }))
    }
  }

  const activeNotebook = (): NotebookMeta | undefined => notebookOf(get().library, get().activeNotebookId)

  return {
    ready: false,
    loadError: null,
    dataDir: '',
    recovered: [],
    library: null,
    view: { kind: 'library', section: 'notebooks' },
    activeNotebookId: null,
    activePageId: null,
    pages: {},
    history: {},
    conflicts: [],
    saveStatus: { state: 'saved' },

    tool: 'pen',
    penColor: INK_COLORS[0],
    penSize: PEN_SIZES[1],
    highlightColor: HIGHLIGHT_COLORS[0],
    highlightSize: 18,
    eraserSize: 14,

    sidebarOpen: true,
    navigatorOpen: true,
    tutorOpen: true,
    search: '',

    async init() {
      try {
        const { library, recovered, dataDir } = await window.inkling.loadLibrary()
        set({ library, recovered, dataDir, ready: true })
        const last = readLastOpened()
        const target =
          library.notebooks.find((n) => n.id === last?.notebookId && n.deletedAt === null) ??
          library.notebooks.find((n) => n.deletedAt === null)
        if (target) await get().openNotebook(target.id, last?.notebookId === target.id ? last.pageId : undefined)
      } catch (err) {
        set({ loadError: (err as Error).message, ready: true })
      }
    },

    flush: () => saver.flush(),

    showSection(section) {
      set({ view: { kind: 'library', section } })
    },

    async openNotebook(notebookId, pageId) {
      const nb = notebookOf(get().library, notebookId)
      if (!nb) return
      const pages = livePages(nb)
      if (pages.length === 0) {
        // Every notebook always has at least one page to write on.
        const meta = createPageMeta()
        updateNotebook(notebookId, (n) => ({ ...n, pages: [...n.pages, meta] }))
        pages.push(meta)
      }
      const target = pages.find((p) => p.id === pageId) ?? pages[0]!
      await ensurePageLoaded(notebookId, target.id)
      set({ activeNotebookId: notebookId, activePageId: target.id, view: { kind: 'notebook' } })
      writeLastOpened(notebookId, target.id)
      // Load the rest in the background for thumbnails.
      await Promise.all(pages.map((p) => ensurePageLoaded(notebookId, p.id)))
    },

    selectPage(pageId) {
      const nbId = get().activeNotebookId
      if (!nbId) return
      void ensurePageLoaded(nbId, pageId).then(() => {
        set({ activePageId: pageId })
        writeLastOpened(nbId, pageId)
      })
    },

    createNotebook(name = 'Untitled Notebook') {
      const palette = ['#3b6fe0', '#8b5cf6', '#2f9e8f', '#f2a516', '#e5484d', '#ea8a2c', '#0ea5e9']
      const count = get().library?.notebooks.length ?? 0
      const nb = makeNotebook(name, palette[count % palette.length]!, 'book')
      updateLibrary((lib) => ({ ...lib, notebooks: [...lib.notebooks, nb] }))
      void get().openNotebook(nb.id)
      return nb.id
    },

    renameNotebook(id, name) {
      const clean = name.trim().slice(0, 120)
      if (clean) updateNotebook(id, (nb) => ({ ...nb, name: clean, updatedAt: Date.now() }))
    },

    styleNotebook(id, style) {
      updateNotebook(id, (nb) => ({ ...nb, ...style }))
    },

    toggleFavorite(id) {
      updateNotebook(id, (nb) => ({ ...nb, favorite: !nb.favorite }))
    },

    trashNotebook(id) {
      updateNotebook(id, (nb) => ({ ...nb, deletedAt: Date.now() }))
      if (get().activeNotebookId === id) {
        const next = get().library?.notebooks.find((n) => n.deletedAt === null)
        if (next) void get().openNotebook(next.id)
        else set({ activeNotebookId: null, activePageId: null, view: { kind: 'library', section: 'notebooks' } })
      }
    },

    restoreNotebook(id) {
      updateNotebook(id, (nb) => ({ ...nb, deletedAt: null }))
    },

    async deleteNotebookForever(id) {
      const nb = notebookOf(get().library, id)
      if (!nb) return
      nb.pages.forEach((p) => saver.forgetPage(p.id))
      updateLibrary((lib) => ({ ...lib, notebooks: lib.notebooks.filter((n) => n.id !== id) }))
      await saver.flush()
      await window.inkling.deleteNotebookFiles(id)
      set((s) => {
        const pages = { ...s.pages }
        nb.pages.forEach((p) => delete pages[p.id])
        return { pages }
      })
    },

    addPage(afterPageId, paper) {
      const nb = activeNotebook()
      if (!nb) return
      const current = get().activePageId ? get().pages[get().activePageId!] : undefined
      const meta = createPageMeta()
      const doc = createPageDoc(nb.id, meta.id, paper ?? current?.paper.type ?? 'grid')
      const anchor = afterPageId ?? get().activePageId
      updateNotebook(nb.id, (n) => {
        const pages = n.pages.slice()
        const at = pages.findIndex((p) => p.id === anchor)
        pages.splice(at === -1 ? pages.length : at + 1, 0, meta)
        return { ...n, pages, updatedAt: Date.now() }
      })
      set((s) => ({ pages: { ...s.pages, [meta.id]: doc }, activePageId: meta.id }))
      saver.markPage(meta.id)
      writeLastOpened(nb.id, meta.id)
    },

    duplicatePage(pageId) {
      const nb = activeNotebook()
      const src = get().pages[pageId]
      if (!nb || !src) return
      const meta = createPageMeta(nb.pages.find((p) => p.id === pageId)?.title ?? '')
      const doc: PageDoc = {
        ...src,
        id: meta.id,
        objects: src.objects.map((o) => ({ ...o, id: newId() })),
        updatedAt: Date.now()
      }
      updateNotebook(nb.id, (n) => {
        const pages = n.pages.slice()
        pages.splice(pages.findIndex((p) => p.id === pageId) + 1, 0, meta)
        return { ...n, pages }
      })
      set((s) => ({ pages: { ...s.pages, [meta.id]: doc }, activePageId: meta.id }))
      saver.markPage(meta.id)
    },

    trashPage(pageId) {
      const nb = activeNotebook()
      if (!nb) return
      const live = livePages(nb)
      const idx = live.findIndex((p) => p.id === pageId)
      updateNotebook(nb.id, (n) => ({
        ...n,
        pages: n.pages.map((p) => (p.id === pageId ? { ...p, deletedAt: Date.now() } : p))
      }))
      if (live.length === 1) {
        get().addPage(undefined)
      } else if (get().activePageId === pageId) {
        const next = live[idx + 1] ?? live[idx - 1]
        if (next) get().selectPage(next.id)
      }
    },

    restorePage(notebookId, pageId) {
      updateNotebook(notebookId, (n) => ({
        ...n,
        pages: n.pages.map((p) => (p.id === pageId ? { ...p, deletedAt: null } : p))
      }))
    },

    async deletePageForever(notebookId, pageId) {
      saver.forgetPage(pageId)
      updateNotebook(notebookId, (n) => ({ ...n, pages: n.pages.filter((p) => p.id !== pageId) }))
      await window.inkling.deletePageFile(notebookId, pageId)
      set((s) => {
        const pages = { ...s.pages }
        delete pages[pageId]
        return { pages }
      })
    },

    movePage(pageId, toIndex) {
      const nb = activeNotebook()
      if (!nb) return
      updateNotebook(nb.id, (n) => {
        // `toIndex` counts live pages only; trashed pages keep their slots.
        const live = livePages(n).filter((p) => p.id !== pageId)
        const moving = n.pages.find((p) => p.id === pageId)
        if (!moving) return n
        live.splice(Math.max(0, Math.min(toIndex, live.length)), 0, moving)
        let i = 0
        const pages = n.pages.filter((p) => p.id !== pageId).map((p) => (p.deletedAt === null ? live[i++]! : p))
        if (i < live.length) pages.push(...live.slice(i))
        return { ...n, pages }
      })
    },

    setPaper(pageId, paperType) {
      const page = get().pages[pageId]
      if (!page) return
      set((s) => ({ pages: { ...s.pages, [pageId]: { ...page, paper: { ...PAPER_DEFAULTS[paperType] }, updatedAt: Date.now() } } }))
      saver.markPage(pageId)
      touchPage(page.notebookId, pageId)
    },

    async resolveConflictWithDisk(pageId) {
      const page = get().pages[pageId]
      if (!page) return
      const { page: disk } = await window.inkling.loadPage(page.notebookId, pageId)
      set((s) => {
        const history = { ...s.history }
        delete history[pageId]
        return {
          conflicts: s.conflicts.filter((c) => c.pageId !== pageId),
          pages: disk ? { ...s.pages, [pageId]: disk } : s.pages,
          history
        }
      })
    },

    commit(pageId, tx) {
      const page = get().pages[pageId]
      if (!page || tx.ops.length === 0) return
      const prev = get().history[pageId] ?? { undo: [], redo: [] }
      set((s) => ({
        pages: { ...s.pages, [pageId]: applyTransaction(page, tx) },
        history: { ...s.history, [pageId]: { undo: [...prev.undo, tx].slice(-HISTORY_LIMIT), redo: [] } }
      }))
      saver.markPage(pageId)
      touchPage(page.notebookId, pageId)
    },

    undo() {
      step('undo')
    },

    redo() {
      step('redo')
    },

    setTool(tool) {
      set({ tool })
    },

    setColor(color) {
      if (get().tool === 'highlighter') set({ highlightColor: color })
      else set({ penColor: color, tool: get().tool === 'eraser' ? 'pen' : get().tool })
    },

    setSize(size) {
      const tool = get().tool
      if (tool === 'highlighter') set({ highlightSize: size })
      else if (tool === 'eraser') set({ eraserSize: size })
      else set({ penSize: size })
    },

    toggle(panel) {
      set((s) => ({ [panel]: !s[panel] }) as Partial<State>)
    },

    setSearch(search) {
      set({ search })
    }
  }

  function step(direction: 'undo' | 'redo'): void {
    const pageId = get().activePageId
    if (!pageId) return
    const page = get().pages[pageId]
    const hist = get().history[pageId]
    const tx = hist?.[direction].at(-1)
    if (!page || !hist || !tx) return
    const applied = direction === 'undo' ? invertTransaction(tx) : tx
    const nextHist: PageHistory =
      direction === 'undo'
        ? { undo: hist.undo.slice(0, -1), redo: [...hist.redo, tx] }
        : { undo: [...hist.undo, tx], redo: hist.redo.slice(0, -1) }
    set((s) => ({
      pages: { ...s.pages, [pageId]: applyTransaction(page, applied) },
      history: { ...s.history, [pageId]: nextHist }
    }))
    saver.markPage(pageId)
    touchPage(page.notebookId, pageId)
  }
})

const LAST_KEY = 'inkling:last-opened'
function readLastOpened(): { notebookId: string; pageId: string } | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null')
  } catch {
    return null
  }
}
function writeLastOpened(notebookId: string, pageId: string): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ notebookId, pageId }))
  } catch {
    /* non-essential */
  }
}

export const selectActiveNotebook = (s: Store) => notebookOf(s.library, s.activeNotebookId)
export const selectActivePage = (s: Store) => (s.activePageId ? s.pages[s.activePageId] : undefined)
