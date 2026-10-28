import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type LoadLibraryResult } from '@shared/ipc'
import { idSchema } from '@shared/schema'
import { createStarterLibrary } from '@shared/factory'
import { Storage } from './storage'

const dataDir = process.env.INKLING_DATA_DIR ?? join(app.getPath('userData'), 'Library')
const storage = new Storage(dataDir)
let mainWindow: BrowserWindow | null = null

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
  handle(IPC.deletePageFile, z.tuple([idSchema, idSchema]), (nb, page) => storage.deletePageFile(nb, page))
  handle(IPC.deleteNotebookFiles, z.tuple([idSchema]), (nb) => storage.deleteNotebookFiles(nb))
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
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
