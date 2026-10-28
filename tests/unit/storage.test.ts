import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '../../src/main/storage'
import { createPageDoc, createStarterLibrary } from '../../src/shared/factory'
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
