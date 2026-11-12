/**
 * Accounts and sync in the desktop app. The notebooks stay where they always
 * were — files in the library folder (storage.ts) — and the same sync engine
 * the web app uses keeps them in step with the account.
 *
 * Signing in is optional and changes nothing on disk by itself. Notebooks
 * that were on this computer before are only added to the account after the
 * user confirms (pendingMigration); they are merged in, never replaced.
 *
 * The session is kept encrypted with the operating system's keychain
 * (Electron safeStorage); without one it lasts until Inkling is closed.
 */
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AccountResult, AccountState, SaveResult } from '@shared/ipc'
import type { Library, NoteDoc, PageDoc } from '@shared/schema'
import { LIBRARY_PATH, SyncEngine, autoSync, type LocalAssets, type LocalDocs, type StateStore, type SyncState, type SyncStatus } from '@shared/sync/engine'
import { assetRefs, checkDoc, countPages, parsePath, withoutPristine } from '@shared/sync/docs'
import { createSupabase, supabaseRemote, type SupabaseClient, type SupabaseConfig } from '@shared/sync/supabase'
import type { Storage } from './storage'

/** Google sends the browser back here after sign-in. Must be listed in Supabase → Authentication → URL Configuration. */
export const OAUTH_PORT = 48213
const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`
const OAUTH_TIMEOUT_MS = 5 * 60_000
const NEWER = 'This was saved by a newer version of Inkling. Update Inkling on this computer to sync it.'

interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface AccountOptions {
  config: SupabaseConfig | null
  storage: Storage
  dataDir: string
  /** Private folder for the session and the sync state: outside the library, so restoring a backup doesn't rewind it. */
  dir: string
  cipher: Cipher
  openExternal: (url: string) => Promise<void>
  flush: () => Promise<unknown>
  onState: (state: AccountState) => void
  onDocsChanged: (paths: string[]) => void
}

async function atomicWrite(file: string, body: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, body, { mode: 0o600 })
  await fs.rename(tmp, file)
}
const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}
const ID = /^[A-Za-z0-9_-]{6,64}$/
const names = (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => [])

/** The library folder as the sync engine sees it. */
export function fileDocs(storage: Storage, dataDir: string): LocalDocs {
  return {
    async read(path) {
      const p = parsePath(path)
      if (!p) return null
      const r = p.kind === 'library' ? await storage.loadLibrary() : p.kind === 'page' ? await storage.loadPage(p.notebookId, p.pageId, { background: true }) : await storage.loadNote(p.notebookId, p.pageId, { background: true })
      // Never treat a file from a newer Inkling as missing: it would be written over.
      if (r.newer) throw new Error(NEWER)
      return ('library' in r ? r.library : 'page' in r ? r.page : r.note) ?? null
    },
    async write(path, content): Promise<SaveResult> {
      const p = parsePath(path)
      const checked = checkDoc(path, content)
      if (!p || !checked.ok) return { status: 'error', message: checked.ok ? 'Unknown document' : checked.message }
      if (p.kind === 'library') return storage.saveLibrary(checked.data as Library)
      return p.kind === 'page' ? storage.savePage(checked.data as PageDoc) : storage.saveNote(checked.data as NoteDoc)
    },
    async remove(path) {
      const p = parsePath(path)
      if (!p || p.kind === 'library') return
      const file = p.kind === 'page' ? storage.pagePath(p.notebookId, p.pageId) : storage.notePath(p.notebookId, p.pageId)
      await fs.rm(file, { force: true })
      await fs.rm(`${file}.bak`, { force: true })
    },
    async list() {
      const out: string[] = []
      if (await fs.stat(storage.libraryPath()).then(() => true, () => false)) out.push(LIBRARY_PATH)
      for (const nb of await names(join(dataDir, 'notebooks'))) {
        if (!ID.test(nb)) continue
        for (const [folder, kind] of [['pages', 'page'], ['notes', 'note']] as const) {
          for (const file of await names(join(dataDir, 'notebooks', nb, folder))) {
            const id = file.endsWith('.json') ? file.slice(0, -5) : ''
            if (ID.test(id)) out.push(`${kind}/${nb}/${id}`)
          }
        }
      }
      return out
    }
  }
}

export function fileAssets(storage: Storage, dataDir: string): LocalAssets {
  const split = (key: string): [string, string] => key.split('/') as [string, string]
  return {
    has: (key) => fs.stat(storage.assetPath(...split(key))).then(() => true, () => false),
    read: async (key) => new Uint8Array(await storage.readAsset(...split(key))),
    write: (key, bytes) => storage.writeAsset(...split(key), bytes),
    async list() {
      const out: string[] = []
      for (const nb of await names(join(dataDir, 'notebooks'))) {
        if (!ID.test(nb)) continue
        for (const file of await names(join(dataDir, 'notebooks', nb, 'assets'))) if (/^[A-Za-z0-9_-]{6,64}\.(png|jpg|jpeg|gif|webp|pdf)$/.test(file)) out.push(`${nb}/${file}`)
      }
      return out
    }
  }
}

export function fileState(dir: string): StateStore {
  const base = (path: string): string => join(dir, 'base', `${path.replaceAll('/', '~')}.json`)
  return {
    load: () => readJson<SyncState>(join(dir, 'state.json')),
    async save(state) {
      await fs.mkdir(dir, { recursive: true })
      await atomicWrite(join(dir, 'state.json'), JSON.stringify(state))
    },
    readBase: (path) => readJson(base(path)),
    async writeBase(path, content) {
      if (content === null) return fs.rm(base(path), { force: true })
      await fs.mkdir(join(dir, 'base'), { recursive: true })
      await atomicWrite(base(path), JSON.stringify(content))
    }
  }
}

export class Account {
  readonly engine: SyncEngine
  private readonly client: SupabaseClient | null
  private readonly auto: { poke(delayMs?: number): void; stop(): void }
  private who: { id: string; email: string | null } | null = null
  private pending: AccountState['pendingMigration'] = null
  private message: string | undefined
  private sync: SyncStatus = { state: 'off', pending: 0, lastSyncedAt: null, conflicts: [], skipped: 0 }
  private oauth: Server | null = null
  private readonly sessionFile: string
  private memorySession = new Map<string, string>()

  constructor(private readonly o: AccountOptions) {
    this.sessionFile = join(o.dir, 'session.bin')
    this.engine = new SyncEngine({
      docs: fileDocs(o.storage, o.dataDir),
      assets: fileAssets(o.storage, o.dataDir),
      state: fileState(o.dir),
      assetRefs,
      firstMerge: async (path, local) => (path === LIBRARY_PATH ? withoutPristine(local as Library, (p) => fileDocs(o.storage, o.dataDir).read(p)) : local),
      onChange: (paths) => o.onDocsChanged(paths),
      onStatus: (s) => {
        this.sync = s
        this.emit()
      }
    })
    this.auto = autoSync(this.engine)
    this.client = o.config
      ? createSupabase(o.config, {
          detectSessionInUrl: false,
          storage: { getItem: (k) => this.readSession().then((s) => s[k] ?? null), setItem: (k, v) => this.writeSession(k, v), removeItem: (k) => this.writeSession(k, null) }
        })
      : null
    this.client?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && this.who) {
        this.engine.unlink()
        this.message = 'You were signed out. Sign in again to keep syncing; your notebooks are still on this computer.'
        this.emit()
      }
    })
  }

  // The session (a refresh token) is as sensitive as a password for this account: encrypted, or not written at all.
  private async readSession(): Promise<Record<string, string>> {
    if (!this.o.cipher.isEncryptionAvailable()) return Object.fromEntries(this.memorySession)
    try {
      return JSON.parse(this.o.cipher.decryptString(await fs.readFile(this.sessionFile))) as Record<string, string>
    } catch {
      return {}
    }
  }
  private async writeSession(key: string, value: string | null): Promise<void> {
    if (!this.o.cipher.isEncryptionAvailable()) {
      if (value === null) this.memorySession.delete(key)
      else this.memorySession.set(key, value)
      return
    }
    const all = await this.readSession()
    if (value === null) delete all[key]
    else all[key] = value
    await fs.mkdir(this.o.dir, { recursive: true })
    await atomicWrite(this.sessionFile, this.o.cipher.encryptString(JSON.stringify(all)))
  }

  state(): AccountState {
    return { available: !!this.client, user: this.who, pendingMigration: this.pending, sync: this.message && this.sync.state === 'off' ? { ...this.sync, message: this.message } : this.sync }
  }
  private emit(): void {
    this.o.onState(this.state())
  }
  /** Something was saved locally: sync soon. */
  changed(): void {
    if (this.who) this.auto.poke()
  }
  /** The computer woke up or the window came back. */
  wake(): void {
    if (this.who) this.auto.poke(0)
  }

  /** At launch: pick up where the last session left off. */
  async start(): Promise<void> {
    await fs.mkdir(this.o.dir, { recursive: true })
    // A backup was restored just before this launch: what is on disk now is to be merged in, not overwritten.
    const marker = join(this.o.dir, 'restored')
    if (await fs.stat(marker).then(() => true, () => false)) {
      await this.engine.markAllDirty()
      await fs.rm(marker, { force: true })
    }
    this.who = await readJson(join(this.o.dir, 'account.json'))
    if (!this.client || !this.who) return this.emit()
    const session = (await this.client.auth.getSession().catch(() => null))?.data.session
    if (session?.user.id === this.who.id) await this.link()
    else this.message = 'Your sign-in has expired. Sign in again to keep syncing; your notebooks are still on this computer.'
    this.emit()
  }

  /** Call before restoring a backup over the library. */
  async noteRestore(): Promise<void> {
    await fs.mkdir(this.o.dir, { recursive: true })
    await fs.writeFile(join(this.o.dir, 'restored'), '')
  }

  private async link(): Promise<void> {
    if (!this.client || !this.who) return
    let device = (await readJson<{ id: string }>(join(this.o.dir, 'device.json')))?.id
    if (!device) {
      device = `desktop-${process.platform}-${randomBytes(4).toString('hex')}`
      await atomicWrite(join(this.o.dir, 'device.json'), JSON.stringify({ id: device }))
    }
    await this.engine.link(supabaseRemote(this.client, this.who.id, device), this.who.id)
    this.message = undefined
    this.auto.poke(0)
  }

  /** A session exists for this user: sync right away, or ask first if this computer has notebooks of its own. */
  private async signedIn(user: { id: string; email?: string | null }): Promise<void> {
    const who = { id: user.id, email: user.email ?? null }
    const owner = this.engine.owner
    if (owner !== who.id) {
      const library = (await this.o.storage.loadLibrary()).library
      const used = library ? await withoutPristine(library, (p) => fileDocs(this.o.storage, this.o.dataDir).read(p).catch(() => null)) : null
      if (used?.notebooks.length || owner) {
        this.who = who
        this.pending = { ...countPages(used ?? { schemaVersion: 2, notebooks: [], folders: [] }), ...(owner ? { otherAccount: true } : {}) }
        return this.emit()
      }
    }
    this.who = who
    await atomicWrite(join(this.o.dir, 'account.json'), JSON.stringify(who))
    await this.link()
    this.emit()
  }

  async confirmMigration(accept: boolean): Promise<AccountState> {
    if (!this.pending || !this.who) return this.state()
    this.pending = null
    if (!accept) return this.signOut()
    await this.o.flush()
    await atomicWrite(join(this.o.dir, 'account.json'), JSON.stringify(this.who))
    await this.link()
    this.emit()
    return this.state()
  }

  private async guard(fn: (client: SupabaseClient) => Promise<AccountResult>): Promise<AccountResult> {
    if (!this.client) return { error: 'Accounts aren’t set up in this copy of Inkling.' }
    try {
      return await fn(this.client)
    } catch (err) {
      const m = (err as Error).message
      return { error: /fetch|network/i.test(m) ? 'Couldn’t reach the sign-in server. Check your internet connection.' : m }
    }
  }

  signInWithEmail(email: string): Promise<AccountResult> {
    return this.guard(async (client) => {
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
      return error ? { error: error.message } : { ok: true }
    })
  }

  verifyEmailCode(email: string, code: string): Promise<AccountResult> {
    return this.guard(async (client) => {
      const { data, error } = await client.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
      if (error || !data.user) return { error: error?.message ?? 'That code didn’t work.' }
      await this.signedIn(data.user)
      return { ok: true }
    })
  }

  /** Opens the browser for Google and waits for it to come back to this computer (127.0.0.1 only). */
  signInWithGoogle(): Promise<AccountResult> {
    return this.guard(async (client) => {
      const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: true } })
      if (error || !data.url) return { error: error?.message ?? 'Could not start signing in.' }
      const code = await this.waitForCode(data.url)
      if ('error' in code) return code
      const exchanged = await client.auth.exchangeCodeForSession(code.code)
      if (exchanged.error || !exchanged.data.user) return { error: exchanged.error?.message ?? 'Signing in didn’t complete.' }
      await this.signedIn(exchanged.data.user)
      return { ok: true }
    })
  }

  private waitForCode(url: string): Promise<{ code: string } | { error: string }> {
    this.oauth?.close()
    return new Promise((resolve) => {
      const page = (text: string): string => `<!doctype html><meta charset="utf-8"><title>Inkling</title><body style="font:16px system-ui;padding:48px;text-align:center"><p>${text}</p>`
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', OAUTH_REDIRECT)
        if (u.pathname !== '/callback') return void res.writeHead(404).end()
        const code = u.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(page(code ? 'You’re signed in. You can close this tab and go back to Inkling.' : 'Signing in didn’t complete. Go back to Inkling and try again.'))
        finish(code ? { code } : { error: u.searchParams.get('error_description') ?? 'Signing in was cancelled.' })
      })
      const timer = setTimeout(() => finish({ error: 'Signing in took too long. Try again.' }), OAUTH_TIMEOUT_MS)
      const finish = (result: { code: string } | { error: string }): void => {
        clearTimeout(timer)
        server.close()
        if (this.oauth === server) this.oauth = null
        resolve(result)
      }
      server.on('error', () => finish({ error: `Inkling couldn’t listen for the sign-in on this computer (port ${OAUTH_PORT} is in use). Sign in with an email code instead.` }))
      // Loopback only: nothing else on the network can reach it.
      server.listen(OAUTH_PORT, '127.0.0.1', () => void this.o.openExternal(url).catch(() => finish({ error: 'Could not open the browser.' })))
      this.oauth = server
    })
  }

  /** Stops syncing. The notebooks stay on this computer and in the account. */
  async signOut(): Promise<AccountState> {
    this.engine.unlink()
    await this.client?.auth.signOut({ scope: 'local' }).catch(() => undefined)
    await fs.rm(join(this.o.dir, 'account.json'), { force: true })
    await fs.rm(this.sessionFile, { force: true })
    this.memorySession.clear()
    this.who = null
    this.pending = null
    this.message = undefined
    this.emit()
    return this.state()
  }

  async syncNow(): Promise<AccountState> {
    await this.o.flush()
    await this.engine.sync()
    return this.state()
  }
}
