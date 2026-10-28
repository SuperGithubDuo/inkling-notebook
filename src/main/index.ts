import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { ASSET_SCHEME, IPC, type ImportImageResult, type LoadLibraryResult } from '@shared/ipc'
import { assetNameSchema, idSchema } from '@shared/schema'
import { createStarterLibrary } from '@shared/factory'
import { IMAGE_MIME, MAX_IMAGE_BYTES, Storage } from './storage'
import { exportMarkdownWithImages, importMarkdownImages } from './markdownFiles'

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024

const dataDir = process.env.INKLING_DATA_DIR ?? join(app.getPath('userData'), 'Library')
const storage = new Storage(dataDir)
let mainWindow: BrowserWindow | null = null

// Image assets are served from the notebook folder through a read-only scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
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
      spellcheck: true
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
    if (library) return { library, recovered: recovered ? ['library.json'] : [], dataDir }
    // First run (or unrecoverable library): start fresh and persist immediately.
    const fresh = createStarterLibrary()
    await storage.saveLibrary(fresh)
    return { library: fresh, recovered: recovered ? ['library.json (reset: no valid backup)'] : [], dataDir }
  })
  // Payloads are validated inside Storage against the full schemas.
  handle(IPC.saveLibrary, z.tuple([z.unknown()]), (library) => storage.saveLibrary(library as never))
  handle(IPC.loadPage, z.tuple([idSchema, idSchema]), (nb, page) => storage.loadPage(nb, page))
  handle(IPC.savePage, z.tuple([z.unknown()]), (page) => storage.savePage(page as never))
  handle(IPC.loadNote, z.tuple([idSchema, idSchema]), (nb, page) => storage.loadNote(nb, page))
  handle(IPC.saveNote, z.tuple([z.unknown()]), (note) => storage.saveNote(note as never))
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
  handle(IPC.deletePageFile, z.tuple([idSchema, idSchema]), (nb, page) => storage.deletePageFile(nb, page))
  handle(IPC.deleteNotebookFiles, z.tuple([idSchema]), (nb) => storage.deleteNotebookFiles(nb))
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
