import type { Library, PageDoc } from './schema'

/** Outcome of a save. `conflict` means the file changed on disk since we last
 * read it; our version was written to a side-by-side conflict copy instead. */
export type SaveResult =
  | { status: 'saved' }
  | { status: 'conflict'; conflictPath: string }
  | { status: 'error'; message: string }

export type LoadLibraryResult = { library: Library; recovered: string[]; dataDir: string }
export type LoadPageResult = { page: PageDoc | null; recovered: boolean }

/** The complete, deliberately narrow API exposed to the renderer. */
export interface InklingApi {
  loadLibrary(): Promise<LoadLibraryResult>
  saveLibrary(library: Library): Promise<SaveResult>
  loadPage(notebookId: string, pageId: string): Promise<LoadPageResult>
  savePage(page: PageDoc): Promise<SaveResult>
  deletePageFile(notebookId: string, pageId: string): Promise<void>
  deleteNotebookFiles(notebookId: string): Promise<void>
  exportPng(suggestedName: string, dataUrl: string): Promise<{ saved: boolean; path?: string }>
  showDataFolder(): Promise<void>
  /** Main asks the renderer to flush pending saves before the window closes. */
  onFlushRequest(handler: () => Promise<void>): void
}

export const IPC = {
  loadLibrary: 'library:load',
  saveLibrary: 'library:save',
  loadPage: 'page:load',
  savePage: 'page:save',
  deletePageFile: 'page:delete',
  deleteNotebookFiles: 'notebook:delete',
  exportPng: 'export:png',
  showDataFolder: 'app:show-data-folder',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done'
} as const
