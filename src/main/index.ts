import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, promises as fs, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { ASSET_SCHEME, IPC, type AppCommand, type AppInfo, type FlushResult, type ImportImageResult, type LoadLibraryResult } from '@shared/ipc'
import { assetNameSchema, idSchema } from '@shared/schema'
import { createStarterLibrary } from '@shared/factory'
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_PDF_BYTES, Storage } from './storage'
import { exportMarkdownWithImages, importMarkdownImages } from './markdownFiles'
import { SearchIndex } from './searchIndex'
import type { Library } from '@shared/schema'
import { aiRequestSchema, apiKeySchema, betaTokenSchema, betaUrlSchema, providerIdSchema } from '@shared/ai'
import { AiConfig } from './ai/config'
import { AiService } from './ai/service'
import { GeminiProvider } from './ai/gemini'
import { OllamaProvider } from './ai/ollama'
import { adoptOrphans, hasNotebookFolders, recoverLibrary } from './recovery'
import { autoBackupIfDue, backupsDirFor, createBackup, listBackups, readBackup, restoreBackup } from './backup'
import { buildMenu } from './menu'
import { Updater } from './updater'
import { FEEDBACK_URL, RELEASES_URL, feedbackLink } from '@shared/product'

/**
 * One fixed data folder, whatever the build: `npm run dev` used to run as
 * "inkling" and an installed app runs as "Inkling", which on Linux are two
 * different folders. Pinning it (and moving an older lowercase folder over
 * once) means an update never opens an empty library.
 */
function pinUserData(): void {
  const appData = app.getPath('appData')
  const target = join(appData, 'Inkling')
  const legacy = join(appData, 'inkling')
  try {
    if (existsSync(legacy) && !existsSync(target)) renameSync(legacy, target)
    else if (existsSync(legacy) && existsSync(target) && realpathSync.native(legacy) !== realpathSync.native(target)) {
      console.warn(`Both ${legacy} and ${target} exist; using ${target}. The other folder is left untouched.`)
    }
  } catch (err) {
    console.warn('Could not move the old data folder:', (err as Error).message)
  }
  app.setPath('userData', target)
}
app.setName('Inkling')
pinUserData()

// Two copies of Inkling on the same notebooks would overwrite each other's saves.
// Right after a crash, the old copy's processes can hold the lock for a moment
// (seen on Windows), so retry briefly before deciding another copy is running.
function acquireSingleInstanceLock(): boolean {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (app.requestSingleInstanceLock()) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return false
}
if (!acquireSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024

const dataDir = process.env.INKLING_DATA_DIR ?? join(app.getPath('userData'), 'Library')
// Next to the library, never inside it. A custom data folder gets its own backups folder.
const backupsDir = process.env.INKLING_BACKUP_DIR ?? (process.env.INKLING_DATA_DIR ? `${dataDir}-backups` : backupsDirFor(dataDir))
const storage = new Storage(dataDir)
const index = new SearchIndex()
let indexReady: Promise<void> = Promise.resolve()

/**
 * Reads every page and note once at startup so search works across the whole
 * library. Saves and loads keep it current afterwards; anything they index
 * first is newer than what this pass would read, so it is left alone.
 */
async function buildIndex(library: Library): Promise<void> {
  index.setLibrary(library)
  for (const nb of library.notebooks) {
    for (const meta of nb.pages) {
      if (index.has(meta.id)) continue
      try {
        if (meta.kind === 'note') {
          const { note } = await storage.loadNote(nb.id, meta.id)
          if (note && !index.has(meta.id)) index.upsertNote(note)
        } else {
          const { page } = await storage.loadPage(nb.id, meta.id)
          if (page && !index.has(meta.id)) index.upsertPage(page)
        }
      } catch {
        /* unreadable files are reported when the page is opened */
      }
    }
  }
}
let mainWindow: BrowserWindow | null = null

// AI settings and the encrypted key live in the app's private config folder,
// never in the notebook library.
const configDir = process.env.INKLING_CONFIG_DIR ?? app.getPath('userData')
const testHooks = process.env.INKLING_TEST_HOOKS === '1'
// Tests point the SDK at a local fake Gemini server; ignored in normal runs.
const geminiBaseUrl = testHooks ? process.env.INKLING_GEMINI_BASE_URL : undefined
// ...and Ollama at a fake on another loopback port. Always loopback: OllamaProvider refuses anything else.
const ollamaBaseUrl = testHooks ? process.env.INKLING_OLLAMA_URL : undefined
// The cloud beta server: set when building a beta (MAIN_VITE_INKLING_BETA_URL), or with INKLING_BETA_URL when running.
const builtInBetaUrl = betaUrlSchema.safeParse(process.env.INKLING_BETA_URL ?? import.meta.env.MAIN_VITE_INKLING_BETA_URL ?? '').data ?? null
const aiConfig = new AiConfig(configDir, safeStorage, { builtInCloudUrl: builtInBetaUrl, defaultProvider: builtInBetaUrl ? 'cloud' : 'ollama' })
// Acceptance tests send many requests in a few seconds; they may relax the
// free-tier pacing (which unit tests cover). Ignored in normal runs.
const testLimits = testHooks && process.env.INKLING_AI_LIMITS ? (JSON.parse(process.env.INKLING_AI_LIMITS) as Record<string, number>) : undefined
const ai = new AiService({
  limits: testLimits,
  config: aiConfig,
  makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: geminiBaseUrl }),
  makeLocalProvider: () => new OllamaProvider({ baseUrl: ollamaBaseUrl }),
  emit: (event) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(IPC.aiEvent, event)
  }
})
const aiReady = aiConfig.load()

// Image assets are served from the notebook folder through a read-only scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// pdf.js loads standard fonts, CMaps and decoders at runtime. They ship with
// pdfjs-dist; only these folders and plain file names are served.
const PDFJS_DIRS = new Set(['standard_fonts', 'cmaps', 'wasm', 'iccs'])
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const PDFJS_TYPES: Record<string, string> = { '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/octet-stream' }

async function servePdfjsResource(pathname: string): Promise<Response> {
  const [dir, file, ...rest] = pathname.split('/').filter(Boolean)
  if (!dir || !file || rest.length || !PDFJS_DIRS.has(dir) || !/^[A-Za-z0-9_.-]+$/.test(file) || file.startsWith('.')) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const bytes = await fs.readFile(join(pdfjsRoot, dir, file))
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': PDFJS_TYPES[extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host === 'pdfjs') return servePdfjsResource(url.pathname)
      const [notebookId, asset] = url.pathname.split('/').filter(Boolean)
      if (url.host !== 'asset' || !notebookId || !asset) return new Response('Not found', { status: 404 })
      const bytes = await storage.readAsset(idSchema.parse(notebookId), asset)
      const ext = asset.slice(asset.lastIndexOf('.') + 1)
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': IMAGE_MIME[ext] ?? 'application/octet-stream',
          // Lets the canvas export pages with images without being tainted.
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'max-age=31536000, immutable'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

async function storeImage(notebookId: string, read: () => Promise<Uint8Array>): Promise<ImportImageResult> {
  try {
    return { asset: await storage.saveAsset(notebookId, await read()) }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1536,
    height: 960,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#fbfaf8',
    title: 'Inkling',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // Acceptance tests get read access to the assistant context API.
      additionalArguments: testHooks ? ['--inkling-test-hooks'] : []
    }
  })
  mainWindow = win

  win.once('ready-to-show', () => win.show())

  // The renderer is a local app: never navigate away or open new windows.
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Save unsaved edits before the window goes away. If saving fails, say so
  // and let the user choose, instead of closing over unsaved work.
  let closing = false
  win.on('close', (event) => {
    if (closing || win.webContents.isDestroyed()) return
    // Holding the window open to save also cancels a quit in progress (⌘Q, Quit from the menu);
    // remember it, so the app still quits once saving is done. On macOS closing the last window
    // doesn't quit by itself, so without this ⌘Q left Inkling running with no window.
    const quitting = quitRequested
    event.preventDefault()
    void (async () => {
      const result = await flushRenderer(win)
      if (!result.ok) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Some changes are not saved',
          message: 'Inkling couldn’t save your latest changes.',
          detail: `${result.message}\n\nIf you quit now, the changes since the last save will be lost.`,
          buttons: ['Try Again', 'Quit Without Saving', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        })
        if (response === 0) return quitting ? app.quit() : win.close()
        if (response === 2) {
          quitRequested = false
          return
        }
      }
      closing = true
      if (!win.isDestroyed()) win.close()
      if (quitting) app.quit()
    })()
  })

  // A crashed or frozen page: offer to reopen it. Saves happen half a second after
  // each edit, so at most the very latest strokes can be missing.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || closing) return
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Inkling stopped unexpectedly',
        message: 'Inkling’s window stopped working and needs to reopen.',
        detail: 'Your notebooks are saved automatically half a second after each change, so at most your very latest edit may be missing. Automatic backups are in Settings → Storage.',
        buttons: ['Reopen', 'Quit'],
        defaultId: 0
      })
      .then(({ response }) => {
        if (response === 0 && !win.isDestroyed()) win.webContents.reload()
        else app.quit()
      })
  })
  win.on('unresponsive', () => {
    void dialog
      .showMessageBox(win, { type: 'warning', title: 'Inkling isn’t responding', message: 'Inkling isn’t responding.', detail: 'You can wait for it, or reopen the window (unsaved changes from the last moment may be lost).', buttons: ['Wait', 'Reopen'], defaultId: 0 })
      .then(({ response }) => {
        if (response === 1 && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer()
      })
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Set while the app is quitting (⌘Q, menu Quit, updater, tests), so a window that holds the quit to save can resume it. */
let quitRequested = false

/** Asks the renderer to write every pending edit; resolves with whether it all reached the disk. */
function flushRenderer(win: BrowserWindow, timeoutMs = 10_000): Promise<FlushResult> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return resolve({ ok: true })
    const timer = setTimeout(() => {
      ipcMain.removeListener(IPC.flushDone, onDone)
      resolve({ ok: false, message: 'Saving took too long.' })
    }, timeoutMs)
    const onDone = (event: Electron.IpcMainEvent, result?: FlushResult): void => {
      if (event.sender !== win.webContents) return
      clearTimeout(timer)
      ipcMain.removeListener(IPC.flushDone, onDone)
      resolve(result && typeof result === 'object' && 'ok' in result ? result : { ok: true })
    }
    ipcMain.on(IPC.flushDone, onDone)
    win.webContents.send(IPC.flushRequest)
  })
}

const sendCommand = (command: AppCommand): void => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.webContents.send(IPC.appCommand, command)
  }
}

const updater = new Updater({
  onState: (state) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(IPC.updateChanged, state)
  },
  beforeInstall: async () => {
    if (!mainWindow) return true
    const saved = await flushRenderer(mainWindow)
    if (!saved.ok) {
      await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'Inkling couldn’t save your latest changes, so the update was not installed yet.', detail: saved.message })
      return false
    }
    // A snapshot of the library from just before the update, in case anything about it goes wrong.
    await createBackup(dataDir, backupsDir, { kind: 'before-update', appVersion: app.getVersion(), link: true }).catch((err) => console.warn('before-update backup failed', err))
    return true
  }
})

/** Takes the daily snapshot when due. Never throws. */
async function autoBackup(): Promise<void> {
  try {
    await autoBackupIfDue(dataDir, backupsDir, app.getVersion())
  } catch (err) {
    console.warn('automatic backup failed:', (err as Error).message)
  }
}

/** Only accept IPC from our own top-level window. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender')
  }
}

function handle<A extends unknown[], R>(channel: string, args: z.ZodType<A>, fn: (...a: A) => Promise<R>): void {
  ipcMain.handle(channel, async (event, ...raw) => {
    assertTrusted(event)
    return fn(...args.parse(raw))
  })
}

function registerIpc(): void {
  handle(IPC.loadLibrary, z.tuple([]), async (): Promise<LoadLibraryResult> => {
    const { library, recovered, newer } = await storage.loadLibrary()
    // Checked at startup too; never replace a newer library.
    if (newer) throw new Error('This library was saved by a newer version of Inkling. Update Inkling to open it.')
    if (library && !recovered) {
      indexReady = buildIndex(library)
      return { library, recovered: [], dataDir }
    }
    if (library) {
      // Restored from library.json.bak, which may be a save behind: add back any pages it doesn't list.
      const adopted = await adoptOrphans(dataDir, library)
      await storage.saveLibrary(library)
      indexReady = buildIndex(library)
      return { library, recovered: [`the notebook list (from its backup${adopted ? `, plus ${adopted} page${adopted === 1 ? '' : 's'} it didn’t list` : ''})`], dataDir }
    }
    if (recovered || (await hasNotebookFolders(dataDir))) {
      // The index is gone but notebooks are on disk: rebuild it rather than start over.
      const snapshots = (await listBackups(backupsDir)).map((b) => b.path)
      const r = await recoverLibrary(dataDir, snapshots)
      await storage.saveLibrary(r.library)
      indexReady = buildIndex(r.library)
      const from = r.source === 'snapshot' ? `the backup of ${new Date((await readBackup(r.snapshot!)).createdAt).toLocaleString()}` : 'the notebook folders'
      return { library: r.library, recovered: [`the notebook list, rebuilt from ${from}${r.adopted ? ` (${r.adopted} page${r.adopted === 1 ? '' : 's'} added back as “Recovered”)` : ''}`], dataDir }
    }
    // First run: start with the starter shelf and persist it immediately.
    const fresh = createStarterLibrary()
    await storage.saveLibrary(fresh)
    index.setLibrary(fresh)
    return { library: fresh, recovered: [], dataDir }
  })
  // Payloads are validated inside Storage against the full schemas.
  // The index follows whatever is actually on disk: saved data, or loaded data.
  handle(IPC.saveLibrary, z.tuple([z.unknown()]), async (library) => {
    const result = await storage.saveLibrary(library as never)
    if (result.status === 'saved') index.setLibrary(library as Library)
    return result
  })
  handle(IPC.loadPage, z.tuple([idSchema, idSchema]), async (nb, id) => {
    const result = await storage.loadPage(nb, id)
    if (result.page) index.upsertPage(result.page)
    return result
  })
  handle(IPC.savePage, z.tuple([z.unknown()]), async (page) => {
    const result = await storage.savePage(page as never)
    if (result.status === 'saved') index.upsertPage(page as never)
    return result
  })
  handle(IPC.loadNote, z.tuple([idSchema, idSchema]), async (nb, id) => {
    const result = await storage.loadNote(nb, id)
    if (result.note) index.upsertNote(result.note)
    return result
  })
  handle(IPC.saveNote, z.tuple([z.unknown()]), async (note) => {
    const result = await storage.saveNote(note as never)
    if (result.status === 'saved') index.upsertNote(note as never)
    return result
  })
  const searchOptions = z.object({ notebookId: idSchema.optional(), limit: z.number().int().min(1).max(200).optional() })
  handle(IPC.search, z.tuple([z.string().max(500), searchOptions]), async (query, options) => {
    await indexReady
    return index.search(query, options)
  })
  handle(IPC.connections, z.tuple([idSchema]), async (pageId) => {
    await indexReady
    return index.connections(pageId)
  })
  handle(IPC.graph, z.tuple([z.object({ notebookId: idSchema.optional() })]), async (options) => {
    await indexReady
    return index.graph(options)
  })
  handle(IPC.importMarkdown, z.tuple([idSchema]), async (notebookId) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import Markdown',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { canceled: true as const }
    try {
      if ((await fs.stat(path)).size > MAX_MARKDOWN_BYTES) throw new Error('File is larger than 10 MB.')
      const raw = await fs.readFile(path, 'utf8')
      const markdown = await importMarkdownImages(raw, path, notebookId, (bytes) => storage.saveAsset(notebookId, bytes))
      return { name: basename(path, extname(path)), markdown }
    } catch (err) {
      return { error: `Could not import: ${(err as Error).message}` }
    }
  })
  handle(IPC.exportMarkdown, z.tuple([z.string().max(200), z.string().max(MAX_MARKDOWN_BYTES)]), async (suggestedName, markdown) => {
    const safeName = suggestedName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'note'
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `${safeName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      await exportMarkdownWithImages(markdown, result.filePath, (nb, asset) => storage.readAsset(idSchema.parse(nb), asset))
      return { saved: true, path: result.filePath }
    } catch (err) {
      return { saved: false, error: (err as Error).message }
    }
  })
  handle(IPC.deletePageFile, z.tuple([idSchema, idSchema]), async (nb, page) => {
    index.remove(page)
    await storage.deletePageFile(nb, page)
  })
  handle(IPC.deleteNotebookFiles, z.tuple([idSchema]), async (nb) => {
    index.removeNotebook(nb)
    await storage.deleteNotebookFiles(nb)
  })
  handle(IPC.importImage, z.tuple([idSchema]), async (notebookId) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Insert image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { canceled: true }
    return storeImage(notebookId, async () => {
      const { size } = await fs.stat(path)
      if (size > MAX_IMAGE_BYTES) throw new Error('Image is larger than 30 MB.')
      return fs.readFile(path)
    })
  })
  handle(IPC.saveImageBytes, z.tuple([idSchema, z.instanceof(Uint8Array)]), (notebookId, bytes) =>
    storeImage(notebookId, async () => bytes)
  )
  handle(IPC.copyAssets, z.tuple([idSchema, idSchema, z.array(assetNameSchema).max(5000)]), async (from, to, assets) => {
    try {
      for (const asset of new Set(assets)) await storage.copyAsset(from, to, asset)
      return { ok: true as const }
    } catch (err) {
      return { error: `Could not copy an image between notebooks: ${(err as Error).message}` }
    }
  })
  handle(IPC.importPdf, z.tuple([idSchema]), async (notebookId) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { canceled: true as const }
    try {
      if ((await fs.stat(path)).size > MAX_PDF_BYTES) throw new Error('PDF is larger than 200 MB.')
      const asset = await storage.saveAsset(notebookId, new Uint8Array(await fs.readFile(path)), 'pdf')
      return { asset, name: basename(path, extname(path)) }
    } catch (err) {
      return { error: `Could not import PDF: ${(err as Error).message}` }
    }
  })
  handle(IPC.exportPdf, z.tuple([z.string().max(200), z.instanceof(Uint8Array)]), async (suggestedName, bytes) => {
    const safeName = suggestedName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'notebook'
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: `${safeName}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      await fs.writeFile(result.filePath, bytes)
      return { saved: true, path: result.filePath }
    } catch (err) {
      return { saved: false, error: (err as Error).message }
    }
  })
  handle(
    IPC.exportPng,
    z.tuple([z.string().max(200), z.string().startsWith('data:image/png;base64,').max(80_000_000)]),
    async (suggestedName, dataUrl) => {
      const safeName = suggestedName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'page'
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: `${safeName}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      await fs.writeFile(result.filePath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
      return { saved: true, path: result.filePath }
    }
  )
  handle(IPC.aiStatus, z.tuple([]), async () => {
    await aiReady
    return ai.freshStatus()
  })
  handle(IPC.aiSetProvider, z.tuple([providerIdSchema]), async (provider) => {
    await aiReady
    return ai.setProvider(provider)
  })
  handle(IPC.aiSetKey, z.tuple([z.string().max(300)]), async (raw) => {
    await aiReady
    const key = apiKeySchema.safeParse(raw)
    if (!key.success) return { error: key.error.issues[0]?.message ?? 'Invalid key' }
    return ai.setKey(key.data)
  })
  handle(IPC.aiClearKey, z.tuple([]), async () => ai.clearKey())
  // The access code is checked with the beta server before it is saved; only its last 4 characters come back.
  handle(IPC.aiSetBetaAccess, z.tuple([z.string().max(200), z.string().max(300).nullable()]), async (rawToken, rawUrl) => {
    await aiReady
    const token = betaTokenSchema.safeParse(rawToken)
    if (!token.success) return { error: { code: 'invalid_key' as const, message: token.error.issues[0]?.message ?? 'Invalid access code' } }
    let url: string | null = null
    if (rawUrl !== null && rawUrl.trim()) {
      const parsed = betaUrlSchema.safeParse(rawUrl)
      if (!parsed.success) return { error: { code: 'bad_request' as const, message: parsed.error.issues[0]?.message ?? 'Invalid server address' } }
      url = parsed.data
    }
    return ai.setBetaAccess(token.data, url)
  })
  handle(IPC.aiClearBetaAccess, z.tuple([]), async () => {
    await aiReady
    return ai.clearBetaAccess()
  })
  // The model name is validated against the active provider (Gemini's two free models, or an Ollama name).
  handle(IPC.aiSetModel, z.tuple([z.string().min(1).max(120)]), async (model) => {
    await aiReady
    return ai.setModel(model)
  })
  handle(IPC.aiSetConsent, z.tuple([z.boolean()]), async (accepted) => ai.setConsent(accepted))
  handle(IPC.aiTest, z.tuple([]), async () => {
    await aiReady
    return ai.test()
  })
  handle(IPC.aiRefreshModels, z.tuple([]), async () => ai.refreshModels())
  handle(IPC.aiStart, z.tuple([aiRequestSchema]), async (request) => {
    await aiReady
    return ai.start(request)
  })
  handle(IPC.aiCancel, z.tuple([z.string().uuid()]), async (id) => ai.cancel(id))
  handle(IPC.showDataFolder, z.tuple([]), async () => {
    await fs.mkdir(dataDir, { recursive: true })
    await shell.openPath(dataDir)
  })
  handle(IPC.appInfo, z.tuple([]), async (): Promise<AppInfo> => ({
    name: 'Inkling',
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    dataDir,
    backupsDir,
    releasesUrl: RELEASES_URL,
    skipWelcome: process.env.INKLING_SKIP_WELCOME === '1'
  }))
  handle(IPC.openFeedback, z.tuple([]), async () => {
    const base = import.meta.env.MAIN_VITE_INKLING_FEEDBACK_URL || FEEDBACK_URL
    if (!/^(https:|mailto:)/.test(base)) return
    await shell.openExternal(feedbackLink(base, { version: app.getVersion(), platform: process.platform, arch: process.arch }))
  })
  handle(IPC.backupList, z.tuple([]), async () => ({ dir: backupsDir, backups: await listBackups(backupsDir) }))
  handle(IPC.backupShowFolder, z.tuple([]), async () => {
    await fs.mkdir(backupsDir, { recursive: true })
    await shell.openPath(backupsDir)
  })
  handle(IPC.backupNow, z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose where to save the backup',
      buttonLabel: 'Back Up Here',
      properties: ['openDirectory', 'createDirectory']
    })
    const parent = result.filePaths[0]
    if (result.canceled || !parent) return { saved: false as const }
    if (parent === dataDir || parent.startsWith(dataDir + '/') || parent.startsWith(dataDir + '\\')) return { saved: false as const, error: 'Choose a folder outside Inkling’s own library folder.' }
    try {
      const saved = await flushRenderer(mainWindow!)
      if (!saved.ok) return { saved: false as const, error: `Your latest changes couldn’t be saved first: ${saved.message}` }
      const info = await createBackup(dataDir, parent, { kind: 'manual', appVersion: app.getVersion() })
      return { saved: true as const, path: info.path }
    } catch (err) {
      return { saved: false as const, error: (err as Error).message }
    }
  })
  handle(IPC.backupRestore, z.tuple([z.string().max(4096).nullable()]), async (chosen) => {
    let dir = chosen
    if (dir) {
      // Only an automatic backup can be named directly; anything else goes through the folder picker.
      const known = (await listBackups(backupsDir)).some((b) => b.path === dir)
      if (!known) return { restored: false as const, error: 'That backup is not in Inkling’s backups folder.' }
    } else {
      const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose an Inkling backup folder', buttonLabel: 'Restore', defaultPath: backupsDir, properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { restored: false as const }
      dir = result.filePaths[0]
    }
    try {
      const info = await readBackup(dir)
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title: 'Restore from backup',
        message: `Replace your library with the backup from ${new Date(info.createdAt).toLocaleString()}?`,
        detail: `The backup has ${info.notebooks} notebook${info.notebooks === 1 ? '' : 's'} and ${info.pages} page${info.pages === 1 ? '' : 's'}. Your current library is saved as a “before restore” backup first, so you can go back. Inkling restarts afterwards.`,
        buttons: ['Restore and Restart', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return { restored: false as const }
      const saved = await flushRenderer(mainWindow!)
      if (!saved.ok) return { restored: false as const, error: `Your latest changes couldn’t be saved first, so nothing was restored: ${saved.message}` }
      await restoreBackup(dataDir, dir, backupsDir, app.getVersion())
    } catch (err) {
      return { restored: false as const, error: (err as Error).message }
    }
    // Restart so every page is read fresh from the restored files.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
      // Tests relaunch the app themselves, so that no copy runs outside their control.
      if (!(testHooks && process.env.INKLING_NO_RELAUNCH === '1')) app.relaunch()
      app.exit(0)
    }, 100)
    return { restored: true as const }
  })
  handle(IPC.updateState, z.tuple([]), async () => updater.current)
  handle(IPC.updateCheck, z.tuple([]), async () => updater.check())
  handle(IPC.updateInstall, z.tuple([]), async () => updater.install())
}

app.whenReady().then(async () => {
  // A library saved by a newer Inkling must not be opened (and saved over) by this one.
  if (await storage.libraryIsNewer()) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Update Inkling',
      message: 'Your notebooks were last opened with a newer version of Inkling.',
      detail: `This version (${app.getVersion()}) can’t open them safely, so it will close without changing anything. Install the latest version from ${RELEASES_URL}.`,
      buttons: ['Close']
    })
    app.exit(0)
    return
  }
  Menu.setApplicationMenu(buildMenu({ send: sendCommand, dev: !app.isPackaged || testHooks, checkForUpdates: updater.current.enabled ? () => void updater.check().then(() => sendCommand('about')) : undefined }))
  registerAssetProtocol()
  registerIpc()
  createWindow()
  void updater.start()
  // The daily snapshot, shortly after startup and then every few hours while Inkling is open.
  setTimeout(() => void autoBackup(), Number(process.env.INKLING_AUTO_BACKUP_DELAY_MS) || 20_000)
  setInterval(() => void autoBackup(), 3 * 60 * 60 * 1000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitRequested = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
