import type { Library, NoteDoc, PageDoc } from './schema'
import type { Connections, GraphData, SearchHit } from './search'
import type { AiEvent, AiModelId, AiProviderId, AiRequest, AiStartResult, AiStatus, AiTestResult, AiError, ModelAvailability } from './ai'

/** Outcome of a save. `conflict` means the file changed on disk since we last
 * read it; our version was written to a side-by-side conflict copy instead. */
export type SaveResult =
  | { status: 'saved' }
  | { status: 'conflict'; conflictPath: string }
  | { status: 'error'; message: string }

export type LoadLibraryResult = { library: Library; recovered: string[]; dataDir: string }
export type ImportImageResult = { asset: string } | { canceled: true } | { error: string }
export type ImportPdfResult = { asset: string; name: string } | { canceled: true } | { error: string }

/** URL the renderer uses to display a stored image asset. */
export const ASSET_SCHEME = 'inkling-asset'
export const assetUrl = (notebookId: string, asset: string): string => `${ASSET_SCHEME}://asset/${notebookId}/${asset}`
/** Base URL of pdf.js runtime resources (fonts, CMaps, decoders) served by the main process. */
export const PDFJS_RESOURCE_URL = `${ASSET_SCHEME}://pdfjs/`

/** `newer`: the file was saved by a newer version of Inkling; it was left untouched and must not be overwritten. */
export type LoadPageResult = { page: PageDoc | null; recovered: boolean; newer?: boolean }
export type LoadNoteResult = { note: NoteDoc | null; recovered: boolean; newer?: boolean }

/** Commands from the application menu (and the system) that the renderer carries out. */
export type AppCommand = 'about' | 'settings' | 'backup' | 'restore' | 'welcome' | 'feedback' | 'privacy'

export interface BackupSummary {
  path: string
  kind: 'auto' | 'manual' | 'before-restore' | 'before-update'
  createdAt: string
  appVersion: string
  notebooks: number
  pages: number
}

export interface UpdateState {
  /** False in development and unpackaged builds, or where updates are switched off. */
  enabled: boolean
  /** Why updates aren't enabled, or what the last check found. */
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  message?: string
  /** macOS builds without a Developer ID signature can't install updates themselves: download from the release page instead. */
  manualDownloadUrl?: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  electron: string
  chrome: string
  /** An installed build, not `npm run dev` / `npm start`. */
  packaged: boolean
  dataDir: string
  backupsDir: string
  /** Release notes / downloads page. */
  releasesUrl: string
  /** Set by acceptance tests of other features (INKLING_SKIP_WELCOME=1). */
  skipWelcome: boolean
}

/** Result of flushing unsaved edits (Ctrl+S, quitting). */
export type FlushResult = { ok: true } | { ok: false; message: string }
export type ImportMarkdownResult = { name: string; markdown: string } | { canceled: true } | { error: string }

/** The complete, deliberately narrow API exposed to the renderer. */
export interface InklingApi {
  /** True only when launched by the acceptance tests (INKLING_TEST_HOOKS=1). */
  testHooks: boolean
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
  /** Picks a PDF and stores it, unchanged, as an asset of the notebook. */
  importPdf(notebookId: string): Promise<ImportPdfResult>
  /** Saves PDF bytes produced by the renderer through a save dialog. */
  exportPdf(suggestedName: string, bytes: Uint8Array): Promise<{ saved: boolean; path?: string; error?: string }>
  exportPng(suggestedName: string, dataUrl: string): Promise<{ saved: boolean; path?: string }>
  /** Full-text search over titles, tags, notes, canvas text and links. */
  search(query: string, options?: { notebookId?: string; limit?: number }): Promise<SearchHit[]>
  /** Outgoing links, backlinks and related pages of a page. */
  connections(pageId: string): Promise<Connections>
  /** Pages and links for the knowledge graph. */
  graph(options?: { notebookId?: string }): Promise<GraphData>
  showDataFolder(): Promise<void>
  appInfo(): Promise<AppInfo>
  /** Opens the feedback page or email with the app version and system filled in. Never includes notebook content. */
  openFeedback(): Promise<void>
  backups: {
    /** Automatic snapshots (newest first) and where they are kept. */
    list(): Promise<{ dir: string; backups: BackupSummary[] }>
    /** Saves a full copy of the library into a folder the user picks. */
    backupNow(): Promise<{ saved: true; path: string } | { saved: false; error?: string }>
    /** Restores a backup (an automatic one by path, or one the user picks when null), then restarts Inkling. */
    restore(path: string | null): Promise<{ restored: false; error?: string } | { restored: true }>
    showFolder(): Promise<void>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    /** Restarts into a downloaded update, after saving. */
    install(): Promise<void>
    onState(handler: (state: UpdateState) => void): () => void
  }
  /** Menu commands for the renderer; returns an unsubscribe function. */
  onCommand(handler: (command: AppCommand) => void): () => void
  /** AI tutor (cloud, local Ollama or Gemini). A Gemini key stays in the main process; only its last 4 characters come back. */
  ai: {
    status(): Promise<AiStatus>
    setKey(key: string): Promise<AiStatus | { error: string }>
    clearKey(): Promise<AiStatus>
    /** Switches between the cloud AI, local Ollama and Gemini. */
    setProvider(provider: AiProviderId): Promise<AiStatus>
    /** Model of the active provider. */
    setModel(model: AiModelId): Promise<AiStatus>
    setConsent(accepted: boolean): Promise<AiStatus>
    test(): Promise<AiTestResult>
    refreshModels(): Promise<{ ok: true; models: ModelAvailability[] } | { ok: false; error: AiError }>
    start(request: AiRequest): Promise<AiStartResult>
    cancel(requestId: string): Promise<void>
    /** Subscribes to streamed answers; returns an unsubscribe function. */
    onEvent(handler: (event: AiEvent) => void): () => void
  }
  /** Main asks the renderer to flush pending saves before the window closes. */
  onFlushRequest(handler: () => Promise<FlushResult>): void
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
  importPdf: 'pdf:import',
  exportPdf: 'pdf:export',
  exportPng: 'export:png',
  search: 'index:search',
  connections: 'index:connections',
  graph: 'index:graph',
  showDataFolder: 'app:show-data-folder',
  aiStatus: 'ai:status',
  aiSetKey: 'ai:set-key',
  aiClearKey: 'ai:clear-key',
  aiSetModel: 'ai:set-model',
  aiSetProvider: 'ai:set-provider',
  aiSetConsent: 'ai:set-consent',
  aiTest: 'ai:test',
  aiRefreshModels: 'ai:refresh-models',
  aiStart: 'ai:start',
  aiCancel: 'ai:cancel',
  aiEvent: 'ai:event',
  appInfo: 'app:info',
  openFeedback: 'app:feedback',
  appCommand: 'app:command',
  backupList: 'backup:list',
  backupNow: 'backup:now',
  backupRestore: 'backup:restore',
  backupShowFolder: 'backup:show-folder',
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done'
} as const
