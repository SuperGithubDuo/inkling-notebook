/**
 * Release-critical data safety: newer-version files are left alone, a
 * damaged or missing library index is rebuilt instead of reset, and
 * backups/restores never lose a notebook.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '../../src/main/storage'
import { adoptOrphans, hasNotebookFolders, recoverLibrary } from '../../src/main/recovery'
import { AUTO_KEEP, MANIFEST, autoBackupIfDue, createBackup, listBackups, readBackup, restoreBackup } from '../../src/main/backup'
import { createNoteDoc, createNotebook, createPageDoc, createPageMeta } from '../../src/shared/factory'
import { LIBRARY_SCHEMA_VERSION, type Library } from '../../src/shared/schema'
import { feedbackLink } from '../../src/shared/product'

let root: string
let data: string
let backups: string
let storage: Storage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkling-safety-'))
  data = join(root, 'Library')
  backups = join(root, 'Backups')
  storage = new Storage(data)
})

/** A library with one notebook of two pages (one canvas with a stroke, one note) saved to disk, plus an image asset. */
async function seed(): Promise<{ library: Library; nbId: string; canvasId: string; noteId: string }> {
  const nb = createNotebook('Algebra', '#3b6fe0', 'sigma')
  const canvas = nb.pages[0]!
  canvas.title = 'Quadratics'
  const note = createPageMeta('Formulas', 'note')
  nb.pages.push(note)
  const library: Library = { schemaVersion: LIBRARY_SCHEMA_VERSION, folders: [], notebooks: [nb] }
  const page = createPageDoc(nb.id, canvas.id)
  page.objects.push({ id: 'stroke-1', createdAt: 1, type: 'stroke', author: 'user', color: '#111111', size: 3, opacity: 1, hasPressure: false, tool: 'pen', points: [[1, 2], [3, 4]] })
  expect((await storage.savePage(page)).status).toBe('saved')
  expect((await storage.saveNote(createNoteDoc(nb.id, note.id))).status).toBe('saved')
  expect((await storage.saveLibrary(library)).status).toBe('saved')
  await mkdir(join(data, 'notebooks', nb.id, 'assets'), { recursive: true })
  await writeFile(join(data, 'notebooks', nb.id, 'assets', 'aaaaaaaaaaaaaaaaaaaaaaaa.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  return { library, nbId: nb.id, canvasId: canvas.id, noteId: note.id }
}

describe('files from a newer version of Inkling', () => {
  it('are reported as newer and left exactly as they are', async () => {
    const { nbId, canvasId } = await seed()
    const file = storage.pagePath(nbId, canvasId)
    const future = JSON.stringify({ schemaVersion: 99, id: canvasId, notebookId: nbId, somethingNew: true })
    await writeFile(file, future)
    const fresh = new Storage(data)
    const r = await fresh.loadPage(nbId, canvasId)
    expect(r).toEqual({ page: null, recovered: false, newer: true })
    expect(await readFile(file, 'utf8')).toBe(future)
    expect((await readdir(join(data, 'notebooks', nbId, 'pages'))).some((f) => f.includes('.corrupt-'))).toBe(false)
    // And this version won't overwrite it.
    const save = await fresh.savePage(createPageDoc(nbId, canvasId))
    expect(save.status).toBe('conflict')
    expect(await readFile(file, 'utf8')).toBe(future)
  })

  it('a newer library is detected without touching it', async () => {
    await seed()
    await writeFile(storage.libraryPath(), JSON.stringify({ schemaVersion: 7, notebooks: [] }))
    expect(await new Storage(data).libraryIsNewer()).toBe(true)
    expect((await new Storage(data).loadLibrary()).newer).toBe(true)
    expect(JSON.parse(await readFile(storage.libraryPath(), 'utf8')).schemaVersion).toBe(7)
  })
})

describe('library recovery', () => {
  it('rebuilds the notebook list from the folders when library.json and its backup are damaged', async () => {
    const { nbId, canvasId, noteId } = await seed()
    await writeFile(storage.libraryPath(), '{ "schemaVersion": 2, "notebooks": [ broken')
    await writeFile(`${storage.libraryPath()}.bak`, 'also broken')
    const fresh = new Storage(data)
    const loaded = await fresh.loadLibrary()
    expect(loaded.library).toBeNull()
    expect(loaded.recovered).toBe(true)
    // The damaged file is kept, not destroyed.
    expect((await readdir(data)).some((f) => f.startsWith('library.json.corrupt-'))).toBe(true)
    const r = await recoverLibrary(data, [])
    expect(r.source).toBe('folders')
    expect(r.adopted).toBe(2)
    const nb = r.library.notebooks.find((n) => n.id === nbId)!
    expect(nb.name).toBe('Recovered notebook 1')
    expect(nb.pages.map((p) => [p.id, p.kind]).sort()).toEqual([[canvasId, 'canvas'], [noteId, 'note']].sort())
    // The rebuilt index loads the original page content.
    expect((await fresh.saveLibrary(r.library)).status).toBe('saved')
    expect((await new Storage(data).loadPage(nbId, canvasId)).page?.objects).toHaveLength(1)
  })

  it('prefers the newest valid snapshot (names, titles, order), then adds pages it lacks', async () => {
    const { library, nbId } = await seed()
    const snap = await createBackup(data, backups, { kind: 'auto', appVersion: 'test' })
    // A page created after the snapshot:
    const later = createPageMeta('After the snapshot')
    library.notebooks[0]!.pages.push(later)
    await storage.savePage(createPageDoc(nbId, later.id))
    await storage.saveLibrary(library)
    await rm(storage.libraryPath())
    await rm(`${storage.libraryPath()}.bak`)
    expect(await hasNotebookFolders(data)).toBe(true)
    const r = await recoverLibrary(data, [snap.path])
    expect(r.source).toBe('snapshot')
    const nb = r.library.notebooks[0]!
    expect(nb.name).toBe('Algebra')
    expect(nb.pages.map((p) => p.title)).toEqual(['Quadratics', 'Formulas', 'Recovered page'])
    expect(nb.pages[2]!.id).toBe(later.id)
  })

  it('drops pages from an old snapshot that were permanently deleted since', async () => {
    const { nbId, noteId } = await seed()
    const snap = await createBackup(data, backups, { kind: 'auto', appVersion: 'test' })
    await storage.deletePageFile(nbId, noteId)
    const r = await recoverLibrary(data, [snap.path])
    expect(r.library.notebooks[0]!.pages.map((p) => p.id)).not.toContain(noteId)
  })

  it('adopting orphans leaves a complete library unchanged', async () => {
    const { library } = await seed()
    const before = JSON.stringify(library)
    expect(await adoptOrphans(data, library)).toBe(0)
    expect(JSON.stringify(library)).toBe(before)
  })

  it('a first run has no notebook folders', async () => {
    expect(await hasNotebookFolders(data)).toBe(false)
  })
})

describe('backups', () => {
  it('a backup holds the library, pages, notes and assets, with a manifest; never temp or .bak files', async () => {
    const { nbId, canvasId } = await seed()
    await writeFile(join(data, 'notebooks', nbId, 'pages', 'x.json.123.tmp'), 'partial')
    const info = await createBackup(data, backups, { kind: 'manual', appVersion: '0.2.0' })
    expect(info).toMatchObject({ kind: 'manual', appVersion: '0.2.0', notebooks: 1, pages: 2 })
    expect(info.path).toMatch(/Inkling backup$/)
    const files = await readdir(join(info.path, 'notebooks', nbId, 'pages'))
    expect(files).toEqual([`${canvasId}.json`])
    expect((await stat(join(info.path, 'notebooks', nbId, 'assets', 'aaaaaaaaaaaaaaaaaaaaaaaa.png'))).size).toBe(7)
    expect(JSON.parse(await readFile(join(info.path, MANIFEST), 'utf8')).format).toBe(1)
    expect((await readdir(backups)).some((f) => f.endsWith('.partial'))).toBe(false)
  })

  it('automatic snapshots hard-link assets, run once a day and keep the newest 7', async () => {
    const { nbId } = await seed()
    const day = 24 * 60 * 60 * 1000
    const t0 = Date.UTC(2026, 9, 1, 12)
    const first = await autoBackupIfDue(data, backups, 't', new Date(t0))
    expect(first).not.toBeNull()
    const asset = join('notebooks', nbId, 'assets', 'aaaaaaaaaaaaaaaaaaaaaaaa.png')
    const [a, b] = [await stat(join(data, asset)), await stat(join(first!.path, asset))]
    if (process.platform !== 'win32') expect(b.ino).toBe(a.ino) // the same file, no extra space
    expect(await autoBackupIfDue(data, backups, 't', new Date(t0 + 60_000))).toBeNull()
    for (let i = 1; i <= 9; i++) await autoBackupIfDue(data, backups, 't', new Date(t0 + i * day))
    const autos = (await listBackups(backups)).filter((x) => x.kind === 'auto')
    expect(autos).toHaveLength(AUTO_KEEP)
    expect(Date.parse(autos[0]!.createdAt)).toBe(t0 + 9 * day)
  })

  it('a manual backup is never pruned by automatic ones', async () => {
    await seed()
    await createBackup(data, backups, { kind: 'manual', appVersion: 't', now: new Date(Date.UTC(2020, 0, 1)) })
    for (let i = 0; i < 9; i++) await autoBackupIfDue(data, backups, 't', new Date(Date.UTC(2026, 0, 1 + i)))
    expect((await listBackups(backups)).filter((x) => x.kind === 'manual')).toHaveLength(1)
  })

  it('restore replaces the library and keeps the previous one as a "before restore" backup', async () => {
    const { library, nbId, canvasId } = await seed()
    const backup = await createBackup(data, backups, { kind: 'manual', appVersion: 't' })
    // Work after the backup: a renamed notebook and a new page.
    library.notebooks[0]!.name = 'Algebra (renamed)'
    const extra = createPageMeta('New page')
    library.notebooks[0]!.pages.push(extra)
    await storage.savePage(createPageDoc(nbId, extra.id))
    await storage.saveLibrary(library)

    const safety = await restoreBackup(data, backup.path, backups, 't')
    const restored = (await new Storage(data).loadLibrary()).library!
    expect(restored.notebooks[0]!.name).toBe('Algebra')
    expect((await new Storage(data).loadPage(nbId, canvasId)).page?.objects).toHaveLength(1)
    // The post-backup work is in the safety snapshot.
    expect(safety?.kind).toBe('before-restore')
    const kept = JSON.parse(await readFile(join(safety!.path, 'library.json'), 'utf8')) as Library
    expect(kept.notebooks[0]!.name).toBe('Algebra (renamed)')
    expect(await readdir(join(safety!.path, 'notebooks', nbId, 'pages'))).toContain(`${extra.id}.json`)
    // No stray folders left next to the library.
    expect((await readdir(root)).sort()).toEqual(['Backups', 'Library'])
  })

  it('refuses a folder that is not a backup, and changes nothing', async () => {
    await seed()
    const bogus = join(root, 'not-a-backup')
    await mkdir(bogus)
    await expect(readBackup(bogus)).rejects.toThrow(/not an Inkling backup/)
    await expect(restoreBackup(data, bogus, backups, 't')).rejects.toThrow()
    expect((await new Storage(data).loadLibrary()).library?.notebooks[0]?.name).toBe('Algebra')
  })

  it('will not back up a library whose index is unreadable', async () => {
    await seed()
    await writeFile(join(data, 'library.json'), 'nope')
    await expect(createBackup(data, backups, { kind: 'auto', appVersion: 't' })).rejects.toThrow(/could not be read/)
  })
})

describe('feedback link', () => {
  it('carries version and system, nothing else', () => {
    const url = new URL(feedbackLink('https://github.com/x/y/issues/new', { version: '0.2.0-beta.1', platform: 'win32', arch: 'x64' }))
    expect(url.searchParams.get('body')).toMatch(/Inkling 0\.2\.0-beta\.1 on Windows \(x64\)/)
    const mail = feedbackLink('mailto:beta@example.com', { version: '1.0.0', platform: 'darwin', arch: 'arm64' })
    expect(mail).toMatch(/^mailto:beta@example\.com\?subject=Inkling%20feedback%20\(1\.0\.0\)&body=.*macOS/)
  })
})
