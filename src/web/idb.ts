/**
 * The web app's local storage: IndexedDB. One database per account (and one
 * for use without an account), so signing in or out never mixes notebooks;
 * image and PDF files share one database, which the service worker serves
 * them from.
 *
 * Writes are transactions: a crash or a closed tab leaves the old or the new
 * value, never a torn one.
 */
import type { SaveResult } from '@shared/ipc'
import type { LocalAssets, LocalDocs, StateStore, SyncState } from '@shared/sync/engine'
import { checkDoc } from '@shared/sync/docs'

export const ASSETS_DB = 'inkling-assets'
export const GUEST_DB = 'inkling-guest'
export const accountDb = (userId: string): string => `inkling-u-${userId}`

const STORES: Record<string, string[]> = { [ASSETS_DB]: ['assets'] }
const DOC_STORES = ['docs', 'sync', 'kv']

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Storage error'))
  })

export class Db {
  private constructor(
    readonly name: string,
    private readonly db: IDBDatabase
  ) {}

  static async open(name: string): Promise<Db> {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      for (const store of STORES[name] ?? DOC_STORES) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store)
    }
    const db = await done(req)
    // Another tab upgrading or deleting the database must not be blocked by this one.
    db.onversionchange = () => db.close()
    return new Db(name, db)
  }

  static async delete(name: string): Promise<void> {
    await done(indexedDB.deleteDatabase(name))
  }

  get<T>(store: string, key: string): Promise<T | undefined> {
    return done(this.db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>)
  }
  keys(store: string): Promise<string[]> {
    return done(this.db.transaction(store).objectStore(store).getAllKeys()) as Promise<string[]>
  }
  /** Resolves once the write is durable (the transaction completed), not merely requested. */
  private write(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not save to this browser’s storage.'))
      fn(tx.objectStore(store))
    })
  }
  put(store: string, key: string, value: unknown): Promise<void> {
    return this.write(store, (s) => s.put(value, key))
  }
  del(store: string, key: string): Promise<void> {
    return this.write(store, (s) => s.delete(key))
  }
  close(): void {
    this.db.close()
  }
}

export function localDocs(db: Db): LocalDocs {
  return {
    read: async (path) => (await db.get('docs', path)) ?? null,
    async write(path, content): Promise<SaveResult> {
      const checked = checkDoc(path, content)
      if (!checked.ok) return { status: 'error', message: checked.message }
      try {
        await db.put('docs', path, checked.data)
        return { status: 'saved' }
      } catch (err) {
        const e = err as Error
        return { status: 'error', message: e.name === 'QuotaExceededError' ? 'This browser’s storage is full. Free some space, or export a backup.' : e.message }
      }
    },
    remove: (path) => db.del('docs', path),
    list: () => db.keys('docs')
  }
}

export function localAssets(db: Db): LocalAssets {
  return {
    has: async (key) => (await db.get('assets', key)) !== undefined,
    read: async (key) => {
      const bytes = await db.get<Uint8Array>('assets', key)
      if (!bytes) throw new Error(`Missing file ${key}`)
      return bytes
    },
    write: (key, bytes) => db.put('assets', key, bytes),
    list: () => db.keys('assets')
  }
}

export function stateStore(db: Db): StateStore {
  return {
    load: async () => (await db.get<SyncState>('sync', 'state')) ?? null,
    save: (state) => db.put('sync', 'state', state),
    readBase: async (path) => (await db.get('sync', `base:${path}`)) ?? null,
    writeBase: (path, content) => (content === null ? db.del('sync', `base:${path}`) : db.put('sync', `base:${path}`, content))
  }
}
