/**
 * The desktop app (files on disk) and the web app (IndexedDB) syncing the same
 * account through the same engine, with real notebook data and the real
 * storage of each platform. The server is the in-memory stand-in.
 */
import 'fake-indexeddb/auto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Storage } from '../../src/main/storage'
import { fileAssets, fileDocs, fileState } from '../../src/main/account'
import { Db, localAssets, localDocs, stateStore } from '../../src/web/idb'
import { createPageDoc, createStarterLibrary } from '../../src/shared/factory'
import type { Library, PageDoc, StrokeObject } from '../../src/shared/schema'
import { LIBRARY_PATH, SyncEngine, pagePath } from '../../src/shared/sync/engine'
import { assetRefs, withoutPristine } from '../../src/shared/sync/docs'
import { FakeServer } from './syncHarness'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const stroke = (id: string): StrokeObject => ({ id, type: 'stroke', author: 'user', createdAt: 1, tool: 'pen', color: '#1f2430', size: 4, opacity: 1, hasPressure: false, points: [[1, 1], [2, 2]] })

let root: string
let storage: Storage
let n = 0

function desktop(): SyncEngine {
  const docs = fileDocs(storage, root)
  return new SyncEngine({
    docs,
    assets: fileAssets(storage, root),
    state: fileState(join(root, '..sync')),
    assetRefs,
    firstMerge: async (path, local) => (path === LIBRARY_PATH ? withoutPristine(local as Library, (p) => docs.read(p)) : local)
  })
}
async function web(): Promise<{ engine: SyncEngine; db: Db; assets: Db }> {
  const [db, assets] = [await Db.open(`inkling-u-test-${++n}`), await Db.open('inkling-assets')]
  const engine = new SyncEngine({
    docs: localDocs(db),
    assets: localAssets(assets),
    state: stateStore(db),
    assetRefs,
    firstMerge: async (path, local) => (path === LIBRARY_PATH ? withoutPristine(local as Library, async (p) => (await db.get('docs', p)) ?? null) : local)
  })
  return { engine, db, assets }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkling-sync-'))
  storage = new Storage(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('desktop and web on one account', () => {
  it('brings an existing desktop library, with its pictures, to the web app — and edits back', async () => {
    // A desktop library from before accounts existed.
    const library = createStarterLibrary()
    const nb = library.notebooks[0]!
    nb.updatedAt += 1 // used
    const page = createPageDoc(nb.id, nb.pages[0]!.id)
    const asset = await storage.saveAsset(nb.id, PNG)
    page.objects.push(stroke('desk-0001'), { id: 'image-0001', type: 'image', author: 'user', createdAt: 1, asset, x: 0, y: 0, width: 10, height: 10, rotation: 0, naturalWidth: 10, naturalHeight: 10 })
    await storage.saveLibrary(library)
    await storage.savePage(page)

    const server = new FakeServer()
    const d = desktop()
    await d.link(server.remote(), 'user-1')
    await d.sync()
    expect(server.docs.get(LIBRARY_PATH)?.rev).toBe(1)
    expect(server.assets.has(`${nb.id}/${asset}`)).toBe(true)

    // The web app signs in to the same account (empty browser).
    const w = await web()
    await w.engine.link(server.remote(), 'user-1')
    await w.engine.sync()
    const webLibrary = (await w.engine.load(LIBRARY_PATH)) as Library
    // Only the used notebook came from this desktop; untouched starter notebooks came along as part of its library.
    expect(webLibrary.notebooks.map((x) => x.name)).toEqual(library.notebooks.map((x) => x.name))
    const path = pagePath(nb.id, page.id)
    expect(((await w.engine.load(path)) as PageDoc).objects.map((o) => o.id)).toEqual(['desk-0001', 'image-0001'])
    expect(await w.assets.get('assets', `${nb.id}/${asset}`)).toEqual(PNG)

    // Both write on the same page while apart.
    const onWeb = (await w.engine.load(path)) as PageDoc
    await w.engine.save(path, { ...onWeb, objects: [...onWeb.objects, stroke('web-00001')] })
    const onDesk = (await d.load(path)) as PageDoc
    await d.save(path, { ...onDesk, objects: [...onDesk.objects, stroke('desk-0002')] })
    await w.engine.sync()
    await d.sync()
    await w.engine.sync()

    // The desktop's file is still an ordinary, valid Inkling page with everyone's ink on it.
    const onDisk = JSON.parse(await readFile(storage.pagePath(nb.id, page.id), 'utf8')) as PageDoc
    expect(onDisk.objects.map((o) => o.id).sort()).toEqual(['desk-0001', 'desk-0002', 'image-0001', 'web-00001'])
    expect((await new Storage(root).loadPage(nb.id, page.id)).page?.objects).toHaveLength(4)
    expect(((await w.engine.load(path)) as PageDoc).objects.map((o) => o.id).sort()).toEqual(onDisk.objects.map((o) => o.id).sort())
    expect(d.current.conflicts).toEqual([])
  })

  it('does not copy an untouched starter library into an account that already has notebooks', async () => {
    const server = new FakeServer()
    const w = await web()
    await w.engine.link(server.remote(), 'user-1')
    const mine = createStarterLibrary()
    mine.notebooks = [{ ...mine.notebooks[0]!, name: 'Real work', updatedAt: mine.notebooks[0]!.createdAt + 5 }]
    await w.engine.save(LIBRARY_PATH, mine)
    await w.engine.sync()

    // A freshly installed desktop app: five empty starter notebooks, then sign-in.
    await storage.saveLibrary(createStarterLibrary())
    const d = desktop()
    await d.link(server.remote(), 'user-1')
    await d.sync()
    expect((await storage.loadLibrary()).library?.notebooks.map((x) => x.name)).toEqual(['Real work'])
    expect((server.docs.get(LIBRARY_PATH)?.content as Library).notebooks).toHaveLength(1)
  })

  it('refuses to store a page from a newer Inkling instead of damaging it, and keeps syncing the rest', async () => {
    const server = new FakeServer()
    const w = await web()
    await w.engine.link(server.remote(), 'user-1')
    const lib = createStarterLibrary()
    const nb = lib.notebooks[0]!
    const good = createPageDoc(nb.id, nb.pages[0]!.id)
    await w.engine.save(pagePath(nb.id, good.id), good)
    await w.engine.sync()
    // Another device running a future version writes a page this one can't read.
    await server.remote().push('page/notebook-future/page-future', 0, { schemaVersion: 99, future: true }, false, false)
    await w.engine.save(pagePath(nb.id, good.id), { ...good, objects: [stroke('mine-0001')] })
    await w.engine.sync()
    expect(w.engine.current.state).toBe('error')
    expect(w.engine.current.message).toMatch(/newer version/)
    expect(await w.db.get('docs', 'page/notebook-future/page-future')).toBeUndefined()
    // Our own edit still went up.
    expect((server.docs.get(pagePath(nb.id, good.id))?.content as PageDoc).objects).toHaveLength(1)
  })

  it('after a desktop backup restore, the restored pages win and what they replace stays in the account’s history', async () => {
    const server = new FakeServer()
    const lib = createStarterLibrary()
    const nb = lib.notebooks[0]!
    nb.updatedAt += 1
    const page = createPageDoc(nb.id, nb.pages[0]!.id)
    page.objects.push(stroke('old-00001'))
    await storage.saveLibrary(lib)
    await storage.savePage(page)
    let d = desktop()
    await d.link(server.remote(), 'user-1')
    await d.sync()
    const path = pagePath(nb.id, page.id)
    await d.save(path, { ...page, objects: [stroke('old-00001'), stroke('new-00001')] })
    await d.sync()

    // Restore: the files go back to the earlier state behind the engine's back, then the app restarts.
    await storage.loadPage(nb.id, page.id)
    await storage.savePage(page)
    d = desktop()
    await d.markAllDirty()
    await d.link(server.remote(), 'user-1')
    await d.sync()
    expect(((await d.load(path)) as PageDoc).objects.map((o) => o.id)).toEqual(['old-00001'])
    expect((server.docs.get(path)?.content as PageDoc).objects.map((o) => o.id)).toEqual(['old-00001'])
    // Without the restart marker the account's newer copy would have silently undone the restore; and what it
    // replaced is recoverable.
    const kept = server.history.filter((h) => h.path === path).map((h) => (h.content as PageDoc).objects.map((o) => o.id))
    expect(kept).toContainEqual(['old-00001', 'new-00001'])
  })
})
