import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type InklingApi } from '@shared/ipc'

const api: InklingApi = {
  loadLibrary: () => ipcRenderer.invoke(IPC.loadLibrary),
  saveLibrary: (library) => ipcRenderer.invoke(IPC.saveLibrary, library),
  loadPage: (notebookId, pageId) => ipcRenderer.invoke(IPC.loadPage, notebookId, pageId),
  savePage: (page) => ipcRenderer.invoke(IPC.savePage, page),
  deletePageFile: (notebookId, pageId) => ipcRenderer.invoke(IPC.deletePageFile, notebookId, pageId),
  deleteNotebookFiles: (notebookId) => ipcRenderer.invoke(IPC.deleteNotebookFiles, notebookId),
  importImage: (notebookId) => ipcRenderer.invoke(IPC.importImage, notebookId),
  saveImageBytes: (notebookId, bytes) => ipcRenderer.invoke(IPC.saveImageBytes, notebookId, bytes),
  copyAssets: (from, to, assets) => ipcRenderer.invoke(IPC.copyAssets, from, to, assets),
  exportPng: (name, dataUrl) => ipcRenderer.invoke(IPC.exportPng, name, dataUrl),
  showDataFolder: () => ipcRenderer.invoke(IPC.showDataFolder),
  onFlushRequest: (handler) => {
    ipcRenderer.on(IPC.flushRequest, () => {
      void handler().finally(() => ipcRenderer.send(IPC.flushDone))
    })
  }
}

contextBridge.exposeInMainWorld('inkling', api)
