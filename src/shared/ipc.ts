import type { Library, NoteDoc, PageDoc } from './schema'

/** Outcome of a save. `conflict` means the file changed on disk since we last
 * read it; our version was written to a side-by-side conflict copy instead. */
export type SaveResult =
  | { status: 'saved' }
  | { status: 'conflict'; conflictPath: string }
  | { status: 'error'; message: string }

export type LoadLibraryResult = { library: Library; recovered: string[]; dataDir: string }
export type ImportImageResult = { asset: string } | { canceled: true } | { error: string }

/** URL the renderer uses to display a stored image asset. */
export const ASSET_SCHEME = 'inkling-asset'
export const assetUrl = (notebookId: string, asset: string): string => `${ASSET_SCHEME}://asset/${notebookId}/${asset}`

export type LoadPageResult = { page: PageDoc | null; recovered: boolean }
export type LoadNoteResult = { note: NoteDoc | null; recovered: boolean }
export type ImportMarkdownResult = { name: string; markdown: string } | { canceled: true } | { error: string }

/** The complete, deliberately narrow API exposed to the renderer. */
export interface InklingApi {
  loadLibrary(): Promise<LoadLibraryResult>
  saveLibrary(library: Library): Promise<SaveResult>
  loadPage(notebookId: string, pageId: string): Promise<LoadPageResult>
  savePage(page: PageDoc): Promise<SaveResult>
  loadNote(notebookId: string, pageId: string): Promise<LoadNoteResult>
  saveNote(note: NoteDoc): Promise<SaveResult>
  /** Picks a .md file; local images it references are copied into the notebook. */
  importMarkdown(notebookId: string): Promise<ImportMarkdownResult>
  /** Saves Markdown; images it references are copied into a sibling folder. */
  exportMarkdown(suggestedName: string, markdown: string): Promise<{ saved: boolean; path?: string; error?: string }>
  deletePageFile(notebookId: string, pageId: string): Promise<void>
  deleteNotebookFiles(notebookId: string): Promise<void>
  /** Opens a file picker and copies the chosen image into the notebook. */
  importImage(notebookId: string): Promise<ImportImageResult>
  /** Stores pasted or dropped image bytes in the notebook. */
  saveImageBytes(notebookId: string, bytes: Uint8Array): Promise<ImportImageResult>
  /** Copies assets into another notebook so pasted objects keep working. */
  copyAssets(fromNotebookId: string, toNotebookId: string, assets: string[]): Promise<{ ok: true } | { error: string }>
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
  loadNote: 'note:load',
  saveNote: 'note:save',
  importMarkdown: 'markdown:import',
  exportMarkdown: 'markdown:export',
  deletePageFile: 'page:delete',
  deleteNotebookFiles: 'notebook:delete',
  importImage: 'image:import',
  saveImageBytes: 'image:save-bytes',
  copyAssets: 'asset:copy',
  exportPng: 'export:png',
  showDataFolder: 'app:show-data-folder',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done'
} as const
