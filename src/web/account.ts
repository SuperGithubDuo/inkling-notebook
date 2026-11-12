/**
 * Accounts in the web app. Signing in is optional: without it, notebooks live
 * in this browser only (the guest database). With it, they live in a database
 * for that account and sync through Supabase.
 *
 * Which database is open is decided once, when the page loads, from our own
 * record of who is signed in on this device — not from whether the session
 * could be refreshed — so the notebooks open offline and with an expired
 * session too (sync then waits). Sign-in, sign-out and the email code all end
 * in a page load, which keeps "which notebooks am I looking at" unambiguous.
 */
import type { AccountResult, AccountState, FlushResult, InklingApi } from '@shared/ipc'
import type { Library } from '@shared/schema'
import { LIBRARY_PATH, SyncEngine, autoSync, type SyncStatus } from '@shared/sync/engine'
import { assetRefs, checkDoc, countPages, parsePath, withoutPristine } from '@shared/sync/docs'
import { merge3 } from '@shared/sync/merge'
import { createSupabase, supabaseConfig, supabaseRemote, type SupabaseClient } from '@shared/sync/supabase'
import { ASSETS_DB, Db, GUEST_DB, accountDb, localAssets, localDocs, stateStore } from './idb'

const ACCOUNT_KEY = 'inkling.account'
const DECLINED_KEY = 'inkling.guestDeclined'
const DEVICE_KEY = 'inkling.device'

interface Who {
  id: string
  email: string | null
}

export type WebAccount = InklingApi['account'] & {
  onDocsChanged(handler: (paths: string[]) => void): () => void
  setFlush(handler: () => Promise<FlushResult>): void
}

export interface Session {
  db: Db
  assets: Db
  engine: SyncEngine
  account: WebAccount
  changed(): void
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
const readJson = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function deviceName(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = `web-${crypto.randomUUID().slice(0, 8)}`
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

/** The guest database's library, and the part of it the user has actually used (null: nothing used). */
async function guestContent(): Promise<{ full: Library; used: Library } | null> {
  if (!(await indexedDB.databases?.())?.some((d) => d.name === GUEST_DB)) return null
  const guest = await Db.open(GUEST_DB)
  try {
    const raw = await guest.get('docs', LIBRARY_PATH)
    const checked = raw === undefined ? null : checkDoc(LIBRARY_PATH, raw)
    if (!checked?.ok) return null
    const full = checked.data as Library
    const used = await withoutPristine(full, async (path) => (await guest.get('docs', path)) ?? null)
    return used.notebooks.length ? { full, used } : null
  } finally {
    guest.close()
  }
}

export async function startSession(appUrl: string): Promise<Session> {
  const config = supabaseConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
  const client: SupabaseClient | null = config ? createSupabase(config, { detectSessionInUrl: true }) : null

  // A failed sign-in comes back as ?error_description=…
  const params = new URLSearchParams(location.search)
  let message: string | undefined = params.get('error_description') ?? undefined
  if (message) history.replaceState(null, '', location.pathname)

  let who = readJson<Who>(ACCOUNT_KEY)
  const session = client ? ((await timeout(client.auth.getSession(), 5000))?.data.session ?? null) : null
  let first = false
  if (session && session.user.id !== who?.id) {
    who = { id: session.user.id, email: session.user.email ?? null }
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(who))
    first = true
  }
  if (who && !session && client && navigator.onLine) message ??= 'Your sign-in has expired. Sign in again to keep syncing; your notebooks are still on this device.'

  const [db, assets] = await Promise.all([Db.open(who ? accountDb(who.id) : GUEST_DB), Db.open(ASSETS_DB)])
  const stateListeners = new Set<(s: AccountState) => void>()
  const docListeners = new Set<(paths: string[]) => void>()
  let flush: () => Promise<FlushResult> = async () => ({ ok: true })
  let sync: SyncStatus = { state: 'off', pending: 0, lastSyncedAt: null, conflicts: [], skipped: 0 }
  let pendingMigration: AccountState['pendingMigration'] = null

  const state = (): AccountState => ({ available: !!client, user: who, pendingMigration, sync: message && sync.state === 'off' ? { ...sync, message } : sync })
  const emit = (): void => stateListeners.forEach((l) => l(state()))

  const engine = new SyncEngine({
    docs: localDocs(db),
    assets: localAssets(assets),
    state: stateStore(db),
    assetRefs,
    // Signing in on a device whose library is still the untouched starter set must not duplicate it in the account.
    firstMerge: async (path, local) => (path === LIBRARY_PATH ? withoutPristine(local as Library, async (p) => (await db.get('docs', p)) ?? null) : local),
    onChange: (paths) => docListeners.forEach((l) => l(paths)),
    onStatus: (s) => {
      sync = s
      emit()
    }
  })
  const auto = autoSync(engine)
  const changed = (): void => auto.poke()

  if (session && who && client) {
    await engine.link(supabaseRemote(client, who.id, deviceName()), who.id)
    // The first time on this device: fetch the account's notebooks before the app opens the library.
    if (first) await timeout(engine.sync(), 20_000)
    else auto.poke(0)
    if (localStorage.getItem(DECLINED_KEY) !== who.id) {
      const guest = await guestContent().catch(() => null)
      if (guest) pendingMigration = countPages(guest.used)
    }
    window.addEventListener('online', () => auto.poke(0))
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && auto.poke(0))
  }

  const reload = async (): Promise<void> => {
    await flush()
    location.reload()
  }
  client?.auth.onAuthStateChange((event, next) => {
    // Signed in without leaving the page (the email code), or as someone else in another tab: start over as them.
    if (event === 'SIGNED_IN' && next && next.user.id !== who?.id) void reload()
    if (event === 'SIGNED_OUT' && who && session) {
      engine.unlink()
      message = 'You were signed out. Sign in again to keep syncing; your notebooks are still on this device.'
      emit()
    }
  })

  const guard = async (fn: () => Promise<{ error: { message: string } | null }>): Promise<AccountResult> => {
    if (!client) return { error: 'Accounts aren’t set up in this copy of Inkling.' }
    if (!navigator.onLine) return { error: 'You’re offline. Connect to the internet to sign in.' }
    try {
      const { error } = await fn()
      return error ? { error: error.message } : { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  const account: WebAccount = {
    state: async () => state(),
    signInWithGoogle: () =>
      guard(async () => {
        await flush()
        return client!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl } })
      }),
    signInWithEmail: (email) => guard(() => client!.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl, shouldCreateUser: true } })),
    verifyEmailCode: (email, code) => guard(() => client!.auth.verifyOtp({ email, token: code.trim(), type: 'email' })),

    async confirmMigration(accept) {
      if (!who || !pendingMigration) return state()
      if (!accept) {
        // They stay in the guest database, untouched, and are there again after signing out.
        localStorage.setItem(DECLINED_KEY, who.id)
        pendingMigration = null
        emit()
        return state()
      }
      const theirs = await guestContent()
      if (theirs) {
        await flush()
        // An account with notebooks of its own gets the used guest notebooks added. An account with nothing yet
        // (just this browser's fresh starter shelf) takes over the guest's shelf as it was.
        const mine = (await engine.load(LIBRARY_PATH)) as Library | null
        const mineUsed = mine ? await withoutPristine(mine, async (p) => (await db.get('docs', p)) ?? null) : null
        const target = mineUsed?.notebooks.length ? merge3(undefined, mineUsed, theirs.used).merged : theirs.full
        const moving = new Set((mineUsed?.notebooks.length ? theirs.used : theirs.full).notebooks.map((n) => n.id))
        const guest = await Db.open(GUEST_DB)
        for (const path of await guest.keys('docs')) {
          const p = parsePath(path)
          if (!p || p.kind === 'library' || !moving.has(p.notebookId)) continue
          const saved = await engine.save(path, await guest.get('docs', path))
          if (saved.status !== 'saved') throw new Error(saved.status === 'error' ? saved.message : 'Could not copy a page.')
        }
        for (const key of await assets.keys('assets')) if (moving.has(key.split('/')[0]!)) await engine.assetAdded(key)
        const saved = await engine.save(LIBRARY_PATH, target)
        if (saved.status !== 'saved') throw new Error(saved.status === 'error' ? saved.message : 'Could not update the notebook list.')
        guest.close()
        // Only now that every page is in the account's database does the guest copy go.
        await Db.delete(GUEST_DB)
        // Start afresh on the combined library; the notebook that was open before signing in opens again.
        location.reload()
        return state()
      }
      pendingMigration = null
      emit()
      return state()
    },

    async signOut() {
      await flush()
      if (client && navigator.onLine && session) await timeout(engine.sync(), 10_000)
      const unsynced = engine.pendingCount()
      const library = (await db.get<Library>('docs', LIBRARY_PATH)) ?? null
      await client?.auth.signOut({ scope: 'local' }).catch(() => undefined)
      localStorage.removeItem(ACCOUNT_KEY)
      localStorage.removeItem(DECLINED_KEY)
      auto.stop()
      if (who && unsynced === 0) {
        // Everything is in the account: leave nothing of it in this browser.
        const mine = new Set(library?.notebooks.map((n) => n.id))
        for (const key of await assets.keys('assets')) if (mine.has(key.split('/')[0]!)) await assets.del('assets', key)
        db.close()
        await Db.delete(accountDb(who.id)).catch(() => undefined)
      }
      // Otherwise the unsynced changes stay in the account's database and go up at the next sign-in.
      location.reload()
      return state()
    },
    async syncNow() {
      await flush()
      await engine.sync()
      return state()
    },
    versions: async (path) => engine.versions(path).catch((err: Error) => ({ error: err.message })),
    async restoreVersion(path, id) {
      await flush()
      const result = await engine.restoreVersion(path, id)
      changed()
      return result
    },
    dismissConflict: async (path) => engine.dismissConflict(path),
    onState: (handler) => {
      stateListeners.add(handler)
      return () => stateListeners.delete(handler)
    },
    onDocsChanged: (handler) => {
      docListeners.add(handler)
      return () => docListeners.delete(handler)
    },
    setFlush: (handler) => {
      flush = handler
    }
  }
  return { db, assets, engine, account, changed }
}
