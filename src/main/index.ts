import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { ASSET_SCHEME, IPC, type ImportImageResult, type LoadLibraryResult } from '@shared/ipc'
import { assetNameSchema, idSchema } from '@shared/schema'
import { createStarterLibrary } from '@shared/factory'
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_PDF_BYTES, Storage } from './storage'
import { exportMarkdownWithImages, importMarkdownImages } from './markdownFiles'
import { SearchIndex } from './searchIndex'
import type { Library } from '@shared/schema'

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024

const dataDir = process.env.INKLING_DATA_DIR ?? join(app.getPath('userData'), 'Library')
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
      additionalArguments: process.env.INKLING_TEST_HOOKS === '1' ? ['--inkling-test-hooks'] : []
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

  // Ask the renderer to flush unsaved edits before the window goes away.
  let flushed = false
  win.on('close', (event) => {
    if (flushed || win.webContents.isDestroyed()) return
    event.preventDefault()
    const finish = (): void => {
      flushed = true
      if (!win.isDestroyed()) win.close()
    }
    const timer = setTimeout(finish, 4000)
    ipcMain.once(IPC.flushDone, () => {
      clearTimeout(timer)
      finish()
    })
    win.webContents.send(IPC.flushRequest)
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
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
    const { library, recovered } = await storage.loadLibrary()
    if (library) {
      indexReady = buildIndex(library)
      return { library, recovered: recovered ? ['library.json'] : [], dataDir }
    }
    // First run (or unrecoverable library): start fresh and persist immediately.
    const fresh = createStarterLibrary()
    await storage.saveLibrary(fresh)
    index.setLibrary(fresh)
    return { library: fresh, recovered: recovered ? ['library.json (reset: no valid backup)'] : [], dataDir }
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
  handle(IPC.showDataFolder, z.tuple([]), async () => {
    await fs.mkdir(dataDir, { recursive: true })
    await shell.openPath(dataDir)
  })
}

app.whenReady().then(() => {
  registerAssetProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
