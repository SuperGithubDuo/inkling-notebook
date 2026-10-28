/**
 * Debounced auto-save. Edits mark a page (or the library) dirty; a short
 * debounce later the latest snapshot is written. `flush()` writes everything
 * immediately (Ctrl+S, window close). Failed saves stay dirty and are retried.
 */
import type { Library, NoteDoc, PageDoc } from '@shared/schema'
import type { SaveResult } from '@shared/ipc'

export type SaveStatus = { state: 'saved' | 'saving' | 'error'; message?: string }

interface Deps {
  getPage(pageId: string): PageDoc | undefined
  getNote(pageId: string): NoteDoc | undefined
  getLibrary(): Library | null
  /** Pages that must not be written (unresolved external conflict). */
  isBlocked(pageId: string): boolean
  onStatus(status: SaveStatus): void
  onConflict(pageId: string, conflictPath: string): void
}

const PAGE_DELAY = 500
const LIBRARY_DELAY = 400
const RETRY_DELAY = 3000

export class SaveQueue {
  private dirtyPages = new Set<string>()
  private dirtyNotes = new Set<string>()
  private libraryDirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null

  constructor(private readonly deps: Deps) {}

  get hasPending(): boolean {
    return this.dirtyPages.size > 0 || this.dirtyNotes.size > 0 || this.libraryDirty
  }

  markPage(pageId: string): void {
    this.dirtyPages.add(pageId)
    this.schedule(PAGE_DELAY)
  }

  markNote(pageId: string): void {
    this.dirtyNotes.add(pageId)
    this.schedule(PAGE_DELAY)
  }

  markLibrary(): void {
    this.libraryDirty = true
    this.schedule(LIBRARY_DELAY)
  }

  forgetPage(pageId: string): void {
    this.dirtyPages.delete(pageId)
    this.dirtyNotes.delete(pageId)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Wait for an in-flight run, then write whatever became dirty meanwhile.
    while (this.running) await this.running
    if (this.hasPending) await this.run()
  }

  private schedule(delay: number): void {
    this.deps.onStatus({ state: 'saving' })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, delay)
  }

  private async run(): Promise<void> {
    if (this.running) {
      await this.running
      if (this.hasPending) this.schedule(PAGE_DELAY)
      return
    }
    this.running = this.write()
    try {
      await this.running
    } finally {
      this.running = null
    }
  }

  private async write(): Promise<void> {
    this.deps.onStatus({ state: 'saving' })
    const errors: string[] = []

    const pageIds = [...this.dirtyPages]
    this.dirtyPages.clear()
    const noteIds = [...this.dirtyNotes]
    this.dirtyNotes.clear()
    const libraryDirty = this.libraryDirty
    this.libraryDirty = false

    await Promise.all(
      pageIds.map(async (id) => {
        const page = this.deps.getPage(id)
        if (!page || this.deps.isBlocked(id)) return
        const result = await safeCall(() => window.inkling.savePage(page))
        if (result.status === 'error') {
          errors.push(result.message)
          this.dirtyPages.add(id)
        } else if (result.status === 'conflict') {
          this.deps.onConflict(id, result.conflictPath)
        }
      })
    )
    await Promise.all(
      noteIds.map(async (id) => {
        const note = this.deps.getNote(id)
        if (!note || this.deps.isBlocked(id)) return
        const result = await safeCall(() => window.inkling.saveNote(note))
        if (result.status === 'error') {
          errors.push(result.message)
          this.dirtyNotes.add(id)
        } else if (result.status === 'conflict') {
          this.deps.onConflict(id, result.conflictPath)
        }
      })
    )

    if (libraryDirty) {
      const library = this.deps.getLibrary()
      if (library) {
        const result = await safeCall(() => window.inkling.saveLibrary(library))
        if (result.status === 'error') {
          errors.push(result.message)
          this.libraryDirty = true
        } else if (result.status === 'conflict') {
          // Not retried: that would keep producing conflict copies.
          errors.push(`library.json was changed by another program. Your version was kept at ${result.conflictPath}.`)
        }
      }
    }

    if (errors.length) {
      this.deps.onStatus({ state: 'error', message: errors[0] })
      if (this.hasPending) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.run(), RETRY_DELAY)
      }
    } else if (!this.hasPending) {
      this.deps.onStatus({ state: 'saved' })
    }
  }
}

async function safeCall(fn: () => Promise<SaveResult>): Promise<SaveResult> {
  try {
    return await fn()
  } catch (err) {
    return { status: 'error', message: (err as Error).message }
  }
}
