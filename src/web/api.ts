/**
 * Inkling in a browser: the same `window.inkling` API the desktop app's
 * preload script provides, implemented with browser storage instead of files
 * and IPC. The renderer (UI, canvas, notebook logic) is the same code on both.
 *
 *   notebooks      IndexedDB (idb.ts), through the sync engine
 *   images, PDFs   IndexedDB, served to the page by the service worker (sw.ts)
 *   search         the desktop's search index, built in the page
 *   AI tutor       the desktop's AI service, with only Inkling's cloud AI
 *   account, sync  Supabase (account.ts)
 *   files          the browser's file picker and downloads
 */
import { ASSET_SCHEME, type AppCommand, type FlushResult, type ImportImageResult, type InklingApi, type LoadLibraryResult, type SaveResult } from '@shared/ipc'
import type { Library, NoteDoc, PageDoc } from '@shared/schema'
import { createStarterLibrary } from '@shared/factory'
import { FEEDBACK_URL, RELEASES_URL, feedbackLink } from '@shared/product'
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_PDF_BYTES, assetKind } from '@shared/assets'
import { CLOUD_CONSENT_VERSION, CLOUD_MODEL, betaUrlSchema, type AiEvent } from '@shared/ai'
import { LIBRARY_PATH, notePath, pagePath, type SyncEngine } from '@shared/sync/engine'
import { checkDoc, parsePath } from '@shared/sync/docs'
import { merge3 } from '@shared/sync/merge'
import { SearchIndex } from '../main/searchIndex'
import { AiService, type AiConfigApi } from '../main/ai/service'
import type { Db } from './idb'
import type { WebAccount } from './account'

declare const __APP_VERSION__: string

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024
const BACKUP_FORMAT = 'inkling-backup'

export interface WebDeps {
  db: Db
  assets: Db
  engine: SyncEngine
  account: WebAccount
  /** Called after every local change, to schedule a sync. */
  changed(): void
}

const randomName = (): string => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Asks for one file with the browser's picker; null if the user cancels. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    document.body.append(input)
    input.click()
    input.remove()
  })
}

function download(name: string, parts: BlobPart[], type: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const safeName = (name: string, fallback: string): string => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || fallback

async function toBase64(bytes: Uint8Array): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(new Blob([bytes as BlobPart]))
  })
  return url.slice(url.indexOf(',') + 1)
}
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** AI settings in the browser: only Inkling's cloud AI, consent and the anonymous installation ID. */
function webAiConfig(cloudUrl: string | null): AiConfigApi {
  const KEY = 'inkling.ai'
  const read = (): { consent?: number; installId?: string } => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}')
    } catch {
      return {}
    }
  }
  const write = (patch: object): void => localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }))
  const unsupported = async (): Promise<never> => {
    throw new Error('Not available in the web app.')
  }
  return {
    provider: 'cloud',
    model: CLOUD_MODEL,
    apiKey: null,
    keyHint: null,
    keyProtection: null,
    consented: false,
    get cloudConsentVersion() {
      return read().consent ?? null
    },
    cloudUrl,
    cloudUrlFromBuild: !!cloudUrl,
    ollamaModel: '',
    get installId() {
      let id = read().installId
      if (!id) {
        id = `inst_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
        write({ installId: id })
      }
      return id
    },
    // The web app has one provider: Ollama and a user's own Gemini key stay desktop features.
    setProvider: async () => undefined,
    setKey: unsupported,
    clearKey: async () => undefined,
    setModel: unsupported,
    setConsent: async () => undefined,
    setCloudConsent: async (accepted) => write({ consent: accepted ? CLOUD_CONSENT_VERSION : undefined })
  }
}

export function createWebApi({ db, assets, engine, account, changed }: WebDeps): InklingApi {
  const index = new SearchIndex()
  let indexReady: Promise<void> = Promise.resolve()
  let flushHandler: (() => Promise<FlushResult>) | null = null
  const aiListeners = new Set<(e: AiEvent) => void>()
  const testHooks = localStorage.getItem('inkling.testHooks') === '1'

  const cloudUrl = betaUrlSchema.safeParse(import.meta.env.VITE_INKLING_BETA_URL ?? '').data ?? null
  const ai = new AiService({
    geminiEnabled: false,
    config: webAiConfig(cloudUrl),
    makeProvider: () => {
      throw new Error('Not available in the web app.')
    },
    account: account.ai,
    emit: (event) => aiListeners.forEach((l) => l(event))
  })
  // Signed out, or the session lapsed: none of the account's AI state may carry over.
  account.onState(() => ai.accountChanged())

  const read = async (path: string): Promise<{ data: unknown | null; recovered: boolean; newer?: boolean }> => {
    const raw = await engine.load(path)
    if (raw === null) return { data: null, recovered: false }
    const checked = checkDoc(path, raw)
    if (checked.ok) return { data: checked.data, recovered: false }
    if (checked.reason === 'newer') return { data: null, recovered: false, newer: true }
    // Unreadable: keep the damaged copy aside rather than let the next save destroy it.
    await db.put('kv', `corrupt:${path}:${Date.now()}`, raw).catch(() => undefined)
    return { data: null, recovered: true }
  }

  const save = async (path: string, value: unknown): Promise<SaveResult> => {
    const checked = checkDoc(path, value)
    if (!checked.ok) return { status: 'error', message: checked.message }
    const result = await engine.save(path, checked.data)
    if (result.status === 'saved') changed()
    return result
  }

  async function buildIndex(library: Library): Promise<void> {
    index.setLibrary(library)
    for (const path of await db.keys('docs')) {
      const p = parsePath(path)
      if (!p || p.kind === 'library' || index.has(p.pageId)) continue
      const checked = checkDoc(path, await db.get('docs', path))
      if (!checked.ok || index.has(p.pageId)) continue
      if (p.kind === 'note') index.upsertNote(checked.data as NoteDoc)
      else index.upsertPage(checked.data as PageDoc)
    }
  }

  async function storeAsset(notebookId: string, bytes: Uint8Array, type: 'image' | 'pdf' = 'image'): Promise<string> {
    const name = `${randomName()}.${assetKind(bytes, type)}`
    const key = `${notebookId}/${name}`
    await assets.put('assets', key, bytes)
    await engine.assetAdded(key)
    changed()
    return name
  }

  const storeImage = async (notebookId: string, bytes: () => Promise<Uint8Array>): Promise<ImportImageResult> => {
    try {
      return { asset: await storeAsset(notebookId, await bytes()) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  async function backupParts(): Promise<{ parts: BlobPart[]; notebooks: number }> {
    await flushHandler?.()
    const parts: BlobPart[] = [`{"format":"${BACKUP_FORMAT}","version":1,"createdAt":"${new Date().toISOString()}","appVersion":"${__APP_VERSION__}","docs":{`]
    let notebooks = 0
    const wanted = new Set<string>()
    let first = true
    for (const path of await db.keys('docs')) {
      const content = await db.get('docs', path)
      if (content === undefined) continue
      if (path === LIBRARY_PATH) for (const nb of (content as Library).notebooks) wanted.add(nb.id), notebooks++
      parts.push(`${first ? '' : ','}${JSON.stringify(path)}:${JSON.stringify(content)}`)
      first = false
    }
    parts.push('},"assets":{')
    first = true
    for (const key of await assets.keys('assets')) {
      if (!wanted.has(key.split('/')[0]!)) continue
      const bytes = await assets.get<Uint8Array>('assets', key)
      if (!bytes) continue
      // shortcut: files are base64 inside one JSON file, built in memory; move to a zip stream if libraries with many large PDFs need it.
      parts.push(`${first ? '' : ','}${JSON.stringify(key)}:"${await toBase64(bytes)}"`)
      first = false
    }
    parts.push('}}')
    return { parts, notebooks }
  }

  const api: InklingApi = {
    platform: 'web',
    testHooks,
    account,

    async loadLibrary(): Promise<LoadLibraryResult> {
      const { data, recovered, newer } = await read(LIBRARY_PATH)
      if (newer) throw new Error('These notebooks were saved by a newer version of Inkling. Reload the page to update Inkling.')
      let library = data as Library | null
      if (!library) {
        // First run in this browser (or for this account): start with the starter shelf.
        library = createStarterLibrary()
        const saved = await save(LIBRARY_PATH, library)
        if (saved.status === 'error') throw new Error(saved.message)
      }
      indexReady = buildIndex(library)
      return { library, recovered: recovered ? ['the notebook list (it was unreadable; a copy of the damaged data was kept)'] : [], dataDir: 'This browser' }
    },
    async saveLibrary(library) {
      const result = await save(LIBRARY_PATH, library)
      if (result.status === 'saved') index.setLibrary(library)
      return result
    },
    async loadPage(notebookId, pageId) {
      const { data, recovered, newer } = await read(pagePath(notebookId, pageId))
      if (data) index.upsertPage(data as PageDoc)
      return { page: data as PageDoc | null, recovered, ...(newer ? { newer } : {}) }
    },
    async savePage(page) {
      const result = await save(pagePath(page.notebookId, page.id), page)
      if (result.status === 'saved') index.upsertPage(page)
      return result
    },
    async loadNote(notebookId, pageId) {
      const { data, recovered, newer } = await read(notePath(notebookId, pageId))
      if (data) index.upsertNote(data as NoteDoc)
      return { note: data as NoteDoc | null, recovered, ...(newer ? { newer } : {}) }
    },
    async saveNote(note) {
      const result = await save(notePath(note.notebookId, note.id), note)
      if (result.status === 'saved') index.upsertNote(note)
      return result
    },
    async deletePageFile(notebookId, pageId) {
      index.remove(pageId)
      await engine.remove(pagePath(notebookId, pageId))
      await engine.remove(notePath(notebookId, pageId))
      changed()
    },
    async deleteNotebookFiles(notebookId) {
      index.removeNotebook(notebookId)
      for (const path of await db.keys('docs')) if (parsePath(path)?.notebookId === notebookId) await engine.remove(path)
      // Files stay on the account (another device may still show them); this device's copies go.
      for (const key of await assets.keys('assets')) if (key.startsWith(`${notebookId}/`)) await assets.del('assets', key)
      changed()
    },

    async importMarkdown() {
      const file = await pickFile('.md,.markdown,.txt,text/markdown,text/plain')
      if (!file) return { canceled: true }
      if (file.size > MAX_MARKDOWN_BYTES) return { error: 'Could not import: File is larger than 10 MB.' }
      // Pictures a Markdown file refers to by path can't be read by a web page; https images are kept.
      return { name: file.name.replace(/\.[^.]+$/, ''), markdown: await file.text() }
    },
    async exportMarkdown(suggestedName, markdown) {
      try {
        // Embed the note's own pictures, so the file is complete by itself.
        const re = new RegExp(`${ASSET_SCHEME}://asset/([A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]{6,64}\\.(png|jpg|jpeg|gif|webp))`, 'g')
        let out = markdown
        for (const m of new Set([...markdown.matchAll(re)].map((x) => x[1]!))) {
          const bytes = await assets.get<Uint8Array>('assets', m)
          if (bytes) out = out.replaceAll(`${ASSET_SCHEME}://asset/${m}`, `data:${IMAGE_MIME[m.slice(m.lastIndexOf('.') + 1)]};base64,${await toBase64(bytes)}`)
        }
        const name = `${safeName(suggestedName, 'note')}.md`
        download(name, [out], 'text/markdown')
        return { saved: true, path: name }
      } catch (err) {
        return { saved: false, error: (err as Error).message }
      }
    },
    async importImage(notebookId) {
      const file = await pickFile('image/png,image/jpeg,image/gif,image/webp')
      if (!file) return { canceled: true }
      if (file.size > MAX_IMAGE_BYTES) return { error: 'Image is larger than 30 MB.' }
      return storeImage(notebookId, async () => new Uint8Array(await file.arrayBuffer()))
    },
    saveImageBytes: (notebookId, bytes) => storeImage(notebookId, async () => bytes),
    async copyAssets(from, to, names) {
      try {
        for (const name of new Set(names)) {
          if (from === to || (await assets.get('assets', `${to}/${name}`)) !== undefined) continue
          const bytes = await assets.get<Uint8Array>('assets', `${from}/${name}`)
          if (!bytes) throw new Error(`${name} is missing`)
          await assets.put('assets', `${to}/${name}`, bytes)
          await engine.assetAdded(`${to}/${name}`)
        }
        changed()
        return { ok: true }
      } catch (err) {
        return { error: `Could not copy an image between notebooks: ${(err as Error).message}` }
      }
    },
    async importPdf(notebookId) {
      const file = await pickFile('application/pdf,.pdf')
      if (!file) return { canceled: true }
      try {
        if (file.size > MAX_PDF_BYTES) throw new Error('PDF is larger than 200 MB.')
        return { asset: await storeAsset(notebookId, new Uint8Array(await file.arrayBuffer()), 'pdf'), name: file.name.replace(/\.[^.]+$/, '') }
      } catch (err) {
        return { error: `Could not import PDF: ${(err as Error).message}` }
      }
    },
    async exportPdf(suggestedName, bytes) {
      const name = `${safeName(suggestedName, 'notebook')}.pdf`
      download(name, [bytes as BlobPart], 'application/pdf')
      return { saved: true, path: name }
    },
    async exportPng(suggestedName, dataUrl) {
      const name = `${safeName(suggestedName, 'page')}.png`
      download(name, [fromBase64(dataUrl.slice(dataUrl.indexOf(',') + 1)) as BlobPart], 'image/png')
      return { saved: true, path: name }
    },

    async search(query, options) {
      await indexReady
      return index.search(query.slice(0, 500), options ?? {})
    },
    async connections(pageId) {
      await indexReady
      return index.connections(pageId)
    },
    async graph(options) {
      await indexReady
      return index.graph(options ?? {})
    },

    showDataFolder: async () => undefined,
    appInfo: async () => ({
      name: 'Inkling',
      version: __APP_VERSION__,
      platform: 'web',
      arch: '',
      electron: '',
      chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '',
      packaged: true,
      dataDir: 'This browser',
      backupsDir: '',
      releasesUrl: RELEASES_URL,
      skipWelcome: testHooks
    }),
    async openFeedback() {
      window.open(feedbackLink(import.meta.env.VITE_INKLING_FEEDBACK_URL || FEEDBACK_URL, { version: __APP_VERSION__, platform: 'web', arch: navigator.userAgent.slice(0, 120) }), '_blank', 'noopener')
    },

    backups: {
      list: async () => ({ dir: '', backups: [] }),
      async backupNow() {
        try {
          const { parts } = await backupParts()
          const name = `Inkling backup ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.inkling.json`
          download(name, parts, 'application/json')
          return { saved: true, path: `your downloads folder (${name})` }
        } catch (err) {
          return { saved: false, error: (err as Error).message }
        }
      },
      async restore() {
        const file = await pickFile('.json,application/json')
        if (!file) return { restored: false }
        try {
          const backup = JSON.parse(await file.text()) as { format?: string; createdAt?: string; docs?: Record<string, unknown>; assets?: Record<string, string> }
          if (backup.format !== BACKUP_FORMAT || !backup.docs) throw new Error('That file is not an Inkling backup.')
          const docs = Object.entries(backup.docs).filter(([path, content]) => checkDoc(path, content).ok)
          const theirs = docs.find(([path]) => path === LIBRARY_PATH)?.[1] as Library | undefined
          if (!theirs) throw new Error('That backup has no notebook list.')
          const ok = window.confirm(
            `Restore the backup from ${new Date(backup.createdAt ?? 0).toLocaleString()}?\n\nIts ${theirs.notebooks.length} notebook(s) replace the same notebooks here; notebooks made since are kept. Your current notebooks are downloaded as a backup first.`
          )
          if (!ok) return { restored: false }
          const current = await api.backups.backupNow()
          if (!current.saved) throw new Error(`Your current notebooks couldn’t be backed up first, so nothing was restored: ${current.error ?? ''}`)
          for (const [key, data] of Object.entries(backup.assets ?? {})) {
            if (!/^[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9_-]{6,64}\.(png|jpg|jpeg|gif|webp|pdf)$/.test(key) || (await assets.get('assets', key)) !== undefined) continue
            await assets.put('assets', key, fromBase64(data))
            await engine.assetAdded(key)
          }
          for (const [path, content] of docs) if (path !== LIBRARY_PATH) await engine.save(path, content)
          // The backup's notebooks as they were, plus any notebook that only exists now.
          const mine = (await engine.load(LIBRARY_PATH)) as Library | null
          await engine.save(LIBRARY_PATH, mine ? merge3(undefined, theirs, mine).merged : theirs)
          changed()
        } catch (err) {
          return { restored: false, error: (err as Error).message }
        }
        setTimeout(() => location.reload(), 100)
        return { restored: true }
      },
      showFolder: async () => undefined
    },
    updates: {
      // The web app updates itself when it is reloaded (the service worker fetches the new version).
      state: async () => ({ enabled: false, status: 'disabled' }),
      check: async () => ({ enabled: false, status: 'disabled' }),
      install: async () => ({ enabled: false, status: 'disabled' }),
      setChannel: async () => ({ enabled: false, status: 'disabled' }),
      onState: () => () => undefined
    },
    onCommand: (_handler: (command: AppCommand) => void) => () => undefined,
    onDocsChanged: (handler) => account.onDocsChanged(handler),

    ai: {
      status: () => ai.freshStatus(),
      setKey: async () => ({ error: 'Google Gemini isn’t available in the web app.' }),
      clearKey: () => ai.clearKey(),
      setProvider: (provider) => ai.setProvider(provider),
      setModel: (model) => ai.setModel(model),
      setConsent: (accepted) => ai.setConsent(accepted),
      test: () => ai.test(),
      refreshModels: () => ai.refreshModels(),
      start: async (request) => ai.start(request),
      cancel: async (id) => ai.cancel(id),
      onEvent: (handler) => {
        aiListeners.add(handler)
        return () => aiListeners.delete(handler)
      }
    },
    onFlushRequest(handler) {
      flushHandler = handler
      account.setFlush(handler)
      // A hidden tab can be discarded without warning: write pending edits as soon as it is hidden.
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void handler())
      window.addEventListener('pagehide', () => void handler())
      // Closing the tab in the half second before an edit is written: ask the browser to hold on.
      window.addEventListener('beforeunload', (e) => {
        if (document.querySelector('[data-testid="save-status"][data-state="saving"]')) {
          void handler()
          e.preventDefault()
        }
      })
    }
  }
  return api
}
