import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type InklingApi } from '@shared/ipc'

const api: InklingApi = {
  testHooks: process.argv.includes('--inkling-test-hooks'),
  loadLibrary: () => ipcRenderer.invoke(IPC.loadLibrary),
  saveLibrary: (library) => ipcRenderer.invoke(IPC.saveLibrary, library),
  loadPage: (notebookId, pageId) => ipcRenderer.invoke(IPC.loadPage, notebookId, pageId),
  savePage: (page) => ipcRenderer.invoke(IPC.savePage, page),
  loadNote: (notebookId, pageId) => ipcRenderer.invoke(IPC.loadNote, notebookId, pageId),
  saveNote: (note) => ipcRenderer.invoke(IPC.saveNote, note),
  importMarkdown: (notebookId) => ipcRenderer.invoke(IPC.importMarkdown, notebookId),
  exportMarkdown: (name, markdown) => ipcRenderer.invoke(IPC.exportMarkdown, name, markdown),
  deletePageFile: (notebookId, pageId) => ipcRenderer.invoke(IPC.deletePageFile, notebookId, pageId),
  deleteNotebookFiles: (notebookId) => ipcRenderer.invoke(IPC.deleteNotebookFiles, notebookId),
  importImage: (notebookId) => ipcRenderer.invoke(IPC.importImage, notebookId),
  saveImageBytes: (notebookId, bytes) => ipcRenderer.invoke(IPC.saveImageBytes, notebookId, bytes),
  copyAssets: (from, to, assets) => ipcRenderer.invoke(IPC.copyAssets, from, to, assets),
  importPdf: (notebookId) => ipcRenderer.invoke(IPC.importPdf, notebookId),
  exportPdf: (name, bytes) => ipcRenderer.invoke(IPC.exportPdf, name, bytes),
  exportPng: (name, dataUrl) => ipcRenderer.invoke(IPC.exportPng, name, dataUrl),
  search: (query, options) => ipcRenderer.invoke(IPC.search, query, options ?? {}),
  connections: (pageId) => ipcRenderer.invoke(IPC.connections, pageId),
  graph: (options) => ipcRenderer.invoke(IPC.graph, options ?? {}),
  showDataFolder: () => ipcRenderer.invoke(IPC.showDataFolder),
  ai: {
    status: () => ipcRenderer.invoke(IPC.aiStatus),
    setKey: (key) => ipcRenderer.invoke(IPC.aiSetKey, key),
    clearKey: () => ipcRenderer.invoke(IPC.aiClearKey),
    setProvider: (provider) => ipcRenderer.invoke(IPC.aiSetProvider, provider),
    setModel: (model) => ipcRenderer.invoke(IPC.aiSetModel, model),
    setConsent: (accepted) => ipcRenderer.invoke(IPC.aiSetConsent, accepted),
    test: () => ipcRenderer.invoke(IPC.aiTest),
    refreshModels: () => ipcRenderer.invoke(IPC.aiRefreshModels),
    start: (request) => ipcRenderer.invoke(IPC.aiStart, request),
    cancel: (requestId) => ipcRenderer.invoke(IPC.aiCancel, requestId),
    onEvent: (handler) => {
      const listener = (_e: unknown, event: Parameters<typeof handler>[0]): void => handler(event)
      ipcRenderer.on(IPC.aiEvent, listener)
      return () => ipcRenderer.removeListener(IPC.aiEvent, listener)
    }
  },
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openFeedback: () => ipcRenderer.invoke(IPC.openFeedback),
  backups: {
    list: () => ipcRenderer.invoke(IPC.backupList),
    backupNow: () => ipcRenderer.invoke(IPC.backupNow),
    restore: (path) => ipcRenderer.invoke(IPC.backupRestore, path),
    showFolder: () => ipcRenderer.invoke(IPC.backupShowFolder)
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updateState),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onState: (handler) => {
      const listener = (_e: unknown, state: Parameters<typeof handler>[0]): void => handler(state)
      ipcRenderer.on(IPC.updateChanged, listener)
      return () => ipcRenderer.removeListener(IPC.updateChanged, listener)
    }
  },
  onCommand: (handler) => {
    const listener = (_e: unknown, command: Parameters<typeof handler>[0]): void => handler(command)
    ipcRenderer.on(IPC.appCommand, listener)
    return () => ipcRenderer.removeListener(IPC.appCommand, listener)
  },
  onFlushRequest: (handler) => {
    ipcRenderer.on(IPC.flushRequest, () => {
      handler().then(
        (result) => ipcRenderer.send(IPC.flushDone, result),
        (err: Error) => ipcRenderer.send(IPC.flushDone, { ok: false, message: err?.message ?? String(err) })
      )
    })
  }
}

contextBridge.exposeInMainWorld('inkling', api)
