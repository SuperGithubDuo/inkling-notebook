/**
 * Moving notebooks made before sign-in (the guest database) into an account.
 *
 * The originals are never the only copy until the server has confirmed it holds them:
 *
 *   1. copy    guest → the account's database. The guest database is only read. Safe to repeat:
 *              a page the account already has is merged with, never replaced.
 *   2. sync    the ordinary sync pushes the copies.
 *   3. settle  only after a sync that completed with nothing left to send is the guest database deleted.
 *
 * A marker in localStorage records that a move is under way, so a closed tab, a crash, a full disk
 * or a lost connection at any point resumes at the next start instead of asking again or losing track.
 * Signing out first simply leaves the originals where they were.
 */
import type { Library } from '@shared/schema'
import { LIBRARY_PATH, type SyncEngine } from '@shared/sync/engine'
import { checkDoc, parsePath, withoutPristine } from '@shared/sync/docs'
import { merge3, same } from '@shared/sync/merge'
import { Db, GUEST_DB } from './idb'

export const MIGRATION_KEY = 'inkling.guestMigration'
type Marker = { user: string; copied: boolean }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const marker = (store: Store): Marker | null => {
  try {
    return JSON.parse(store.getItem(MIGRATION_KEY) ?? 'null') as Marker | null
  } catch {
    return null
  }
}
/** A move into this user's account was started and isn't finished. */
export const migrating = (user: string, store: Store = localStorage): boolean => marker(store)?.user === user
/** Forget an unfinished move (sign-out). The guest database is left exactly as it is. */
export const abandonMigration = (store: Store = localStorage): void => store.removeItem(MIGRATION_KEY)

/** The guest database's library, and the part of it the user has actually used (null: nothing used). */
export async function guestContent(): Promise<{ full: Library; used: Library } | null> {
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

/**
 * Step 1. Copies the guest's notebooks into the account's database through the engine, so they are
 * queued for upload. Throws if anything can't be written; whatever was copied stays, and a retry completes it.
 */
export async function copyGuest(user: string, account: Db, assets: Db, engine: SyncEngine, store: Store = localStorage): Promise<void> {
  const theirs = await guestContent()
  if (!theirs) return abandonMigration(store)
  store.setItem(MIGRATION_KEY, JSON.stringify({ user, copied: false } satisfies Marker))
  const read = async (path: string): Promise<unknown | null> => (await account.get('docs', path)) ?? null
  const mine = (await engine.load(LIBRARY_PATH)) as Library | null
  const have = new Set(mine?.notebooks.map((n) => n.id))
  let target: Library
  if (mine && theirs.used.notebooks.every((n) => have.has(n.id))) target = mine // a repeat: the list is already combined
  else {
    // An account with notebooks of its own gets the used guest notebooks added. An account with nothing yet
    // (just this browser's fresh starter shelf) takes over the guest's shelf as it was.
    const mineUsed = mine ? await withoutPristine(mine, read) : null
    target = mineUsed?.notebooks.length ? merge3(undefined, mineUsed, theirs.used).merged : theirs.full
  }
  const moving = new Set(theirs.full.notebooks.map((n) => n.id).filter((id) => target.notebooks.some((n) => n.id === id)))
  const put = async (path: string, content: unknown): Promise<void> => {
    const existing = await read(path)
    // Already in the account (an earlier, interrupted move; perhaps edited since): add to it, never replace it.
    const next = existing === null ? content : merge3(undefined, existing, content).merged
    if (existing !== null && same(next, existing)) return
    const saved = await engine.save(path, next)
    if (saved.status !== 'saved') throw new Error(saved.status === 'error' ? saved.message : 'Could not copy a page.')
  }
  const guest = await Db.open(GUEST_DB)
  try {
    for (const path of await guest.keys('docs')) {
      const p = parsePath(path)
      if (p && p.kind !== 'library' && moving.has(p.notebookId)) await put(path, await guest.get('docs', path))
    }
  } finally {
    guest.close()
  }
  for (const key of await assets.keys('assets')) if (moving.has(key.split('/')[0]!)) await engine.assetAdded(key)
  // The list last: it never names a page that isn't in the account's database yet.
  if (target !== mine) {
    const saved = await engine.save(LIBRARY_PATH, target)
    if (saved.status !== 'saved') throw new Error(saved.status === 'error' ? saved.message : 'Could not update the notebook list.')
  }
  store.setItem(MIGRATION_KEY, JSON.stringify({ user, copied: true } satisfies Marker))
}

/**
 * Step 3. Deletes the guest database once the server holds everything: the copy finished, and a sync
 * has completed since with nothing left to send. Until then it does nothing. Returns true when done.
 */
export async function settleMigration(user: string, engine: SyncEngine, store: Store = localStorage): Promise<boolean> {
  const m = marker(store)
  if (m?.user !== user || !m.copied) return false
  const s = engine.current
  if (s.state !== 'idle' || s.lastSyncedAt === null || engine.pendingCount() > 0) return false
  await Db.delete(GUEST_DB)
  store.removeItem(MIGRATION_KEY)
  return true
}
