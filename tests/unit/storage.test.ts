import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '../../src/main/storage'
import { createNoteDoc, createPageDoc, createStarterLibrary } from '../../src/shared/factory'
import type { PageDoc } from '../../src/shared/schema'

let root: string
let storage: Storage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkling-test-'))
  storage = new Storage(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

function samplePage(): PageDoc {
  const lib = createStarterLibrary()
  const nb = lib.notebooks[0]!
  const page = createPageDoc(nb.id, nb.pages[0]!.id)
  page.objects.push({
    id: 'stroke-0001',
    type: 'stroke',
    author: 'user',
    createdAt: 1,
    tool: 'pen',
    color: '#1f2430',
    size: 4,
    opacity: 1,
    hasPressure: true,
    points: [[10, 10, 0.4], [20, 25, 0.6], [35, 30, 0.5]]
  })
  return page
}

describe('Storage', () => {
  it('round-trips a library and a page with full stroke data', async () => {
    const lib = createStarterLibrary()
    expect((await storage.saveLibrary(lib)).status).toBe('saved')
    expect((await storage.loadLibrary()).library).toEqual(lib)

    const page = samplePage()
    expect((await storage.savePage(page)).status).toBe('saved')
    const loaded = await storage.loadPage(page.notebookId, page.id)
    expect(loaded.page).toEqual(page)
    expect(loaded.recovered).toBe(false)
  })

  it('returns null for a page that was never saved', async () => {
    const page = samplePage()
    expect((await storage.loadPage(page.notebookId, page.id)).page).toBeNull()
  })

  it('refuses to write data that fails validation', async () => {
    const page = samplePage() as unknown as Record<string, unknown>
    page.objects = [{ type: 'stroke', id: 'x' }]
    const result = await storage.savePage(page as never)
    expect(result.status).toBe('error')
  })

  it('leaves no temp files behind and keeps a backup of the previous version', async () => {
    const page = samplePage()
    await storage.savePage(page)
    page.objects = []
    await storage.savePage(page)
    const dir = join(root, 'notebooks', page.notebookId, 'pages')
    const files = await readdir(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    const bak = JSON.parse(await readFile(join(dir, `${page.id}.json.bak`), 'utf8'))
    expect(bak.objects).toHaveLength(1)
  })

  it('recovers from a corrupted file using the backup', async () => {
    const page = samplePage()
    await storage.savePage(page)
    await storage.savePage({ ...page, updatedAt: page.updatedAt + 1 })
    const file = storage.pagePath(page.notebookId, page.id)
    await writeFile(file, '{"schemaVersion":1, "id": trunc')

    const fresh = new Storage(root)
    const loaded = await fresh.loadPage(page.notebookId, page.id)
    expect(loaded.recovered).toBe(true)
    expect(loaded.page?.objects).toHaveLength(1)
    const files = await readdir(join(root, 'notebooks', page.notebookId, 'pages'))
    expect(files.some((f) => f.includes('.corrupt-'))).toBe(true)
  })

  // The startup search-index pass reads every page in the background. If it reaches a
  // damaged page first, it repairs it; the user must still be told when the page opens.
  it('reports a repair made by a background read on the next real load, once', async () => {
    const page = samplePage()
    await storage.savePage(page)
    await storage.savePage({ ...page, updatedAt: page.updatedAt + 1 })
    await writeFile(storage.pagePath(page.notebookId, page.id), '{"schemaVersion":1, "id": trunc')

    const fresh = new Storage(root)
    const background = await fresh.loadPage(page.notebookId, page.id, { background: true })
    expect(background.page?.objects).toHaveLength(1)

    const opened = await fresh.loadPage(page.notebookId, page.id)
    expect(opened.recovered).toBe(true)
    expect(opened.page?.objects).toHaveLength(1)
    expect((await fresh.loadPage(page.notebookId, page.id)).recovered).toBe(false)
  })

  it('reports an unreadable page found by a background read instead of opening it blank silently', async () => {
    const page = samplePage()
    await storage.savePage(page) // first save: no .bak exists yet
    await writeFile(storage.pagePath(page.notebookId, page.id), '{"schemaVersion":1, "id": trunc')

    const fresh = new Storage(root)
    await fresh.loadPage(page.notebookId, page.id, { background: true })
    const opened = await fresh.loadPage(page.notebookId, page.id)
    expect(opened.page).toBeNull()
    expect(opened.recovered).toBe(true)
  })

  it('reports a note repaired by a background read too', async () => {
    const nb = createStarterLibrary().notebooks[0]!
    const note = createNoteDoc(nb.id, nb.pages[0]!.id)
    expect((await storage.saveNote(note)).status).toBe('saved')
    expect((await storage.saveNote({ ...note, updatedAt: note.updatedAt + 1 })).status).toBe('saved')
    await writeFile(storage.notePath(nb.id, note.id), '{"schemaVersion":1, trunc')

    const fresh = new Storage(root)
    await fresh.loadNote(nb.id, note.id, { background: true })
    const opened = await fresh.loadNote(nb.id, note.id)
    expect(opened.recovered).toBe(true)
    expect(opened.note?.id).toBe(note.id)
  })

  it('saves normally after recovering a page from its backup (no false conflict)', async () => {
    const page = samplePage()
    await storage.savePage(page)
    await storage.savePage({ ...page, updatedAt: page.updatedAt + 1 })
    await writeFile(storage.pagePath(page.notebookId, page.id), 'not json')

    const fresh = new Storage(root)
    const loaded = await fresh.loadPage(page.notebookId, page.id)
    expect(loaded.recovered).toBe(true)
    // Edit and save the recovered page in the same session.
    const edited = { ...loaded.page!, objects: [], updatedAt: 42 }
    expect((await fresh.savePage(edited)).status).toBe('saved')
    expect((await fresh.loadPage(page.notebookId, page.id)).page?.updatedAt).toBe(42)
  })

  it('saves normally after recovering a page whose main file went missing', async () => {
    const page = samplePage()
    await storage.savePage(page)
    await storage.savePage({ ...page, updatedAt: page.updatedAt + 1 })
    await rm(storage.pagePath(page.notebookId, page.id))

    const fresh = new Storage(root)
    expect((await fresh.loadPage(page.notebookId, page.id)).recovered).toBe(true)
    expect((await fresh.savePage({ ...page, updatedAt: 7 })).status).toBe('saved')
  })

  it('does not overwrite a file changed by another program', async () => {
    const page = samplePage()
    await storage.savePage(page)
    const file = storage.pagePath(page.notebookId, page.id)
    const external = { ...page, objects: [] }
    await writeFile(file, JSON.stringify(external))
    const future = new Date(Date.now() + 5000)
    await utimes(file, future, future)

    const result = await storage.savePage({ ...page, updatedAt: 99 })
    expect(result.status).toBe('conflict')
    expect(JSON.parse(await readFile(file, 'utf8')).objects).toHaveLength(0)
    if (result.status === 'conflict') {
      expect(JSON.parse(await readFile(result.conflictPath, 'utf8')).updatedAt).toBe(99)
    }
  })

  it('rejects path traversal in ids', () => {
    expect(() => storage.pagePath('../../etc', 'passwd')).toThrow()
  })
})
