/**
 * Regression tests for moving notebooks made before sign-in into an account
 * (src/web/migrate.ts). The bug: the originals were deleted as soon as they had
 * been copied into the account's local database — before anything had reached
 * the server — and a failure part-way left no record of what was going on.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db, GUEST_DB, localAssets, localDocs, stateStore } from '../../src/web/idb'
import { MIGRATION_KEY, abandonMigration, copyGuest, guestContent, migrating, settleMigration } from '../../src/web/migrate'
import { createPageDoc, createStarterLibrary } from '../../src/shared/factory'
import type { Library, PageDoc, StrokeObject } from '../../src/shared/schema'
import { LIBRARY_PATH, SyncEngine, pagePath, type LocalDocs } from '../../src/shared/sync/engine'
import { assetRefs } from '../../src/shared/sync/docs'
import { FakeServer } from './syncHarness'

const USER = 'user-1'
const stroke = (id: string): StrokeObject => ({ id, type: 'stroke', author: 'user', createdAt: 1, tool: 'pen', color: '#1f2430', size: 4, opacity: 1, hasPressure: false, points: [[1, 1], [2, 2]] })
const guestExists = async (): Promise<boolean> => (await indexedDB.databases()).some((d) => d.name === GUEST_DB)
let n = 0
let store: Storage
let paths: string[]
let library: Library

/** A browser used without an account: two notebooks written in, three untouched. */
async function guestWithWork(): Promise<void> {
  const guest = await Db.open(GUEST_DB)
  library = createStarterLibrary()
  paths = []
  for (const nb of library.notebooks.slice(0, 2)) {
    nb.updatedAt += 1
    const page = createPageDoc(nb.id, nb.pages[0]!.id)
    page.objects.push(stroke(`ink-${nb.name.slice(0, 4)}-1`))
    paths.push(pagePath(nb.id, page.id))
    await guest.put('docs', paths.at(-1)!, page)
  }
  await guest.put('docs', LIBRARY_PATH, library)
  guest.close()
}

async function account(failAfter = Infinity): Promise<{ db: Db; assets: Db; engine: SyncEngine }> {
  const [db, assets] = [await Db.open(`inkling-u-mig-${++n}`), await Db.open('inkling-assets')]
  const docs = localDocs(db)
  let writes = 0
  const flaky: LocalDocs = { ...docs, write: async (p, c) => (++writes > failAfter ? { status: 'error', message: 'This browser’s storage is full.' } : docs.write(p, c)) }
  return { db, assets, engine: new SyncEngine({ docs: flaky, assets: localAssets(assets), state: stateStore(db), assetRefs }) }
}

beforeEach(async () => {
  const map = new Map<string, string>()
  store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) } as Storage
  await Db.delete(GUEST_DB)
  await guestWithWork()
})

describe('guest notebooks → account', () => {
  it('keeps the originals until a sync has delivered everything, then removes them', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    server.online = false
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    await a.engine.sync()

    // Copied locally, nothing on the server: the originals must still be there.
    expect(server.docs.size).toBe(0)
    expect(await settleMigration(USER, a.engine, store)).toBe(false)
    expect((await guestContent())?.used.notebooks).toHaveLength(2)
    expect(migrating(USER, store)).toBe(true)

    server.online = true
    await a.engine.sync()
    expect(await settleMigration(USER, a.engine, store)).toBe(true)
    expect(await guestExists()).toBe(false)
    expect(store.getItem(MIGRATION_KEY)).toBeNull()
    for (const p of paths) expect((server.docs.get(p)?.content as PageDoc).objects).toHaveLength(1)
    expect((server.docs.get(LIBRARY_PATH)?.content as Library).notebooks.map((x) => x.id)).toEqual(library.notebooks.map((x) => x.id))
  })

  it('is not settled by a sync that happened before the copy finished', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    await a.engine.sync() // idle, nothing pending — but nothing has been copied yet
    store.setItem(MIGRATION_KEY, JSON.stringify({ user: USER, copied: false }))
    expect(await settleMigration(USER, a.engine, store)).toBe(false)
    expect(await guestExists()).toBe(true)
  })

  it('survives a failure part-way: originals intact, and a retry completes without duplicates', async () => {
    const server = new FakeServer()
    const broken = await account(1) // storage fails after the first page
    await broken.engine.link(server.remote(), USER)
    await expect(copyGuest(USER, broken.db, broken.assets, broken.engine, store)).rejects.toThrow(/storage is full/)
    await broken.engine.sync()
    expect(await settleMigration(USER, broken.engine, store)).toBe(false)
    expect((await guestContent())?.used.notebooks).toHaveLength(2)
    expect(migrating(USER, store)).toBe(true) // resumed at the next start

    // The next start: same database, working storage.
    const db = await Db.open(broken.db.name)
    const engine = new SyncEngine({ docs: localDocs(db), assets: localAssets(broken.assets), state: stateStore(db), assetRefs })
    await engine.link(server.remote(), USER)
    await copyGuest(USER, db, broken.assets, engine, store)
    await copyGuest(USER, db, broken.assets, engine, store) // and again: harmless
    await engine.sync()
    expect(await settleMigration(USER, engine, store)).toBe(true)
    const lib = server.docs.get(LIBRARY_PATH)?.content as Library
    expect(lib.notebooks.map((x) => x.id)).toEqual(library.notebooks.map((x) => x.id))
    for (const p of paths) expect((server.docs.get(p)?.content as PageDoc).objects.map((o) => o.id)).toHaveLength(1)
  })

  it('adds to a page the account already has instead of replacing it', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    // The user keeps writing on the copy in their account before the move is settled…
    const copy = (await a.engine.load(paths[0]!)) as PageDoc
    await a.engine.save(paths[0]!, { ...copy, objects: [...copy.objects, stroke('later-0001')] })
    // …and the copy runs again (a restart).
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    expect(((await a.engine.load(paths[0]!)) as PageDoc).objects.map((o) => o.id)).toEqual([copy.objects[0]!.id, 'later-0001'])
  })

  it('joins an account that has notebooks without touching them, leaving untouched starter notebooks behind', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    const mine = createStarterLibrary()
    mine.notebooks = [{ ...mine.notebooks[0]!, name: 'Already mine', updatedAt: mine.notebooks[0]!.createdAt + 9 }]
    await a.engine.save(LIBRARY_PATH, mine)
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    const merged = (await a.engine.load(LIBRARY_PATH)) as Library
    expect(merged.notebooks.map((x) => x.name)).toEqual(['Already mine', library.notebooks[0]!.name, library.notebooks[1]!.name])
  })

  it('replaces a brand-new account’s untouched starter shelf rather than doubling it', async () => {
    // Regression: the account's database already holds the fresh starter notebooks the app made when it opened.
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    await a.engine.save(LIBRARY_PATH, createStarterLibrary())
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    const merged = (await a.engine.load(LIBRARY_PATH)) as Library
    expect(merged.notebooks.map((x) => x.id)).toEqual(library.notebooks.map((x) => x.id))
  })

  it('signing out before the move is confirmed leaves the originals exactly as they were', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    server.online = false
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    abandonMigration(store)
    server.online = true
    await a.engine.sync()
    // Synced, but the user signed out of the move: nothing is deleted behind their back.
    expect(await settleMigration(USER, a.engine, store)).toBe(false)
    const guest = await Db.open(GUEST_DB)
    expect(((await guest.get('docs', paths[0]!)) as PageDoc).objects).toHaveLength(1)
    guest.close()
  })

  it('never settles another user’s move', async () => {
    const server = new FakeServer()
    const a = await account()
    await a.engine.link(server.remote(), USER)
    await copyGuest(USER, a.db, a.assets, a.engine, store)
    await a.engine.sync()
    expect(await settleMigration('someone-else', a.engine, store)).toBe(false)
    expect(await guestExists()).toBe(true)
  })
})
