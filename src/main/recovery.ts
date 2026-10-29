/**
 * Rebuilding the library when library.json can't be used.
 *
 * library.json is only the index: the notebooks themselves are folders of
 * page and note files. So a damaged index must never mean "no notebooks".
 * In order, recovery uses:
 *   1. the newest automatic or manual snapshot whose library.json is valid
 *      (names, colours, page order and titles come back from it), then
 *   2. the notebook folders on disk: every page or note file the index
 *      doesn't list is added back, in its own notebook folder, under a
 *      "Recovered" title, so nothing on disk stays invisible.
 *
 * Nothing is deleted or overwritten here; the caller saves the result as the
 * new library.json (the damaged one was already kept as `.corrupt-<time>`).
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { LIBRARY_SCHEMA_VERSION, idSchema, type Library, type NotebookMeta, type PageMeta } from '@shared/schema'
import { parseLibraryJson } from './storage'

const PAGE_FILE = /^([A-Za-z0-9_-]{1,64})\.json$/

export interface RecoveryResult {
  library: Library
  /** Where the notebook list came from. */
  source: 'snapshot' | 'folders'
  snapshot?: string
  /** Pages and notes added back from the folders because no index listed them. */
  adopted: number
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}

/** Ids of the page (canvas) and note files in a notebook folder, with their modification times. */
async function filesIn(notebookDir: string): Promise<Array<{ id: string; kind: 'canvas' | 'note'; mtime: number }>> {
  const out: Array<{ id: string; kind: 'canvas' | 'note'; mtime: number }> = []
  for (const [sub, kind] of [
    ['pages', 'canvas'],
    ['notes', 'note']
  ] as const) {
    for (const name of await listDir(join(notebookDir, sub))) {
      const m = PAGE_FILE.exec(name)
      if (!m || !idSchema.safeParse(m[1]).success) continue
      const stat = await fs.stat(join(notebookDir, sub, name)).catch(() => null)
      if (stat?.isFile()) out.push({ id: m[1]!, kind, mtime: stat.mtimeMs })
    }
  }
  return out
}

/** True if the data folder holds any notebook content (so a missing library.json is not a first run). */
export async function hasNotebookFolders(dataDir: string): Promise<boolean> {
  for (const id of await listDir(join(dataDir, 'notebooks'))) {
    if ((await filesIn(join(dataDir, 'notebooks', id))).length) return true
  }
  return false
}

/** The newest valid library.json among snapshot folders (newest first). */
async function fromSnapshots(snapshotDirs: string[]): Promise<{ library: Library; dir: string } | null> {
  for (const dir of snapshotDirs) {
    const raw = await fs.readFile(join(dir, 'library.json'), 'utf8').catch(() => null)
    const library = raw ? parseLibraryJson(raw) : null
    if (library) return { library, dir }
  }
  return null
}

/**
 * Adds every page and note file on disk that `library` doesn't list. Pages
 * keep their notebook folder (so their images and PDFs still resolve);
 * folders the library doesn't know become "Recovered notebook" entries.
 * Returns how many were added.
 */
export async function adoptOrphans(dataDir: string, library: Library, now = Date.now()): Promise<number> {
  const listed = new Set(library.notebooks.flatMap((nb) => nb.pages.map((p) => p.id)))
  let adopted = 0
  let unnamed = 0
  for (const notebookId of (await listDir(join(dataDir, 'notebooks'))).sort()) {
    if (!idSchema.safeParse(notebookId).success) continue
    const files = (await filesIn(join(dataDir, 'notebooks', notebookId))).filter((f) => !listed.has(f.id)).sort((a, b) => a.mtime - b.mtime)
    if (!files.length) continue
    let nb = library.notebooks.find((n) => n.id === notebookId)
    if (!nb) {
      nb = {
        id: notebookId,
        name: `Recovered notebook ${++unnamed}`,
        color: '#7b8494',
        icon: 'book',
        favorite: false,
        folderId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        pages: []
      } satisfies NotebookMeta
      library.notebooks.push(nb)
    }
    for (const f of files) {
      const page: PageMeta = { id: f.id, kind: f.kind, title: f.kind === 'note' ? 'Recovered note' : 'Recovered page', tags: [], createdAt: f.mtime, updatedAt: f.mtime, deletedAt: null }
      nb.pages.push(page)
      listed.add(f.id)
      adopted++
    }
    nb.updatedAt = now
  }
  return adopted
}

export async function recoverLibrary(dataDir: string, snapshotDirs: string[]): Promise<RecoveryResult> {
  const snap = await fromSnapshots(snapshotDirs)
  const library: Library = snap?.library ?? { schemaVersion: LIBRARY_SCHEMA_VERSION, notebooks: [], folders: [] }
  if (snap) {
    // The snapshot may be older than the folders: drop what was permanently deleted since (its files are gone).
    for (const nb of library.notebooks) {
      const onDisk = new Set((await filesIn(join(dataDir, 'notebooks', nb.id))).map((f) => f.id))
      nb.pages = nb.pages.filter((p) => onDisk.has(p.id))
    }
    library.notebooks = library.notebooks.filter((nb) => nb.pages.length > 0)
  }
  const adopted = await adoptOrphans(dataDir, library)
  return { library, source: snap ? 'snapshot' : 'folders', ...(snap ? { snapshot: snap.dir } : {}), adopted }
}
