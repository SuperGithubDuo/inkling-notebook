/**
 * Local-first storage. Layout under the data directory:
 *
 *   library.json                          notebooks, folders, page order (versioned)
 *   notebooks/<notebookId>/pages/<id>.json  one editable vector page each (versioned)
 *
 * Guarantees:
 *  - Writes are atomic (temp file + fsync + rename), so a crash mid-save leaves
 *    either the old or the new file, never a torn one.
 *  - The previous good version is kept as `<file>.bak` and used automatically if
 *    the main file is unreadable or fails schema validation.
 *  - If a file was modified by another program since we last read or wrote it,
 *    we do not overwrite it; our version goes to a `.conflict-<time>.json` copy.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { migratePage } from '@shared/migrate'
import {
  assetNameSchema,
  LIBRARY_SCHEMA_VERSION,
  idSchema,
  librarySchema,
  pageDocSchema,
  type Library,
  type PageDoc
} from '@shared/schema'
import type { SaveResult } from '@shared/ipc'

const pageFileSchema = z.preprocess(migratePage, pageDocSchema) as unknown as ZodType<PageDoc>

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** Identifies an image by its leading bytes; we never trust file extensions. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif'
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export class Storage {
  /** mtime of each file as of our last read or write, for conflict detection. */
  private readonly stamps = new Map<string, number>()
  /** Serialises writes per file so concurrent saves can't interleave. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(readonly root: string) {}

  libraryPath(): string {
    return join(this.root, 'library.json')
  }

  notebookDir(notebookId: string): string {
    return join(this.root, 'notebooks', idSchema.parse(notebookId))
  }

  pagePath(notebookId: string, pageId: string): string {
    return join(this.notebookDir(notebookId), 'pages', `${idSchema.parse(pageId)}.json`)
  }

  async loadLibrary(): Promise<{ library: Library | null; recovered: boolean }> {
    const { data, recovered } = await this.readValidated(this.libraryPath(), librarySchema)
    return { library: data, recovered }
  }

  saveLibrary(library: Library): Promise<SaveResult> {
    return this.writeValidated(this.libraryPath(), librarySchema, library)
  }

  async loadPage(notebookId: string, pageId: string): Promise<{ page: PageDoc | null; recovered: boolean }> {
    const { data, recovered } = await this.readValidated(this.pagePath(notebookId, pageId), pageFileSchema)
    return { page: data, recovered }
  }

  savePage(page: PageDoc): Promise<SaveResult> {
    return this.writeValidated(this.pagePath(page.notebookId, page.id), pageDocSchema, page)
  }

  assetPath(notebookId: string, asset: string): string {
    return join(this.notebookDir(notebookId), 'assets', assetNameSchema.parse(asset))
  }

  /**
   * Stores image bytes as an immutable asset and returns its file name.
   * Assets are content we own: pages reference them by name, never by a
   * temporary browser URL or the user's original path.
   */
  async saveAsset(notebookId: string, bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image is larger than 30 MB.')
    const kind = sniffImage(bytes)
    if (!kind) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.')
    const name = `${randomBytes(12).toString('hex')}.${kind}`
    const file = this.assetPath(notebookId, name)
    await this.atomicWrite(file, bytes)
    return name
  }

  async readAsset(notebookId: string, asset: string): Promise<Buffer> {
    return fs.readFile(this.assetPath(notebookId, asset))
  }

  /**
   * Makes an asset of one notebook available in another (cross-notebook
   * paste). Asset names are random and their content never changes, so an
   * existing file with the same name is already the same asset.
   */
  async copyAsset(fromNotebookId: string, toNotebookId: string, asset: string): Promise<void> {
    const target = this.assetPath(toNotebookId, asset)
    if (fromNotebookId === toNotebookId) return
    if (await fs.stat(target).then(() => true, () => false)) return
    const bytes = await this.readAsset(fromNotebookId, asset)
    await this.enqueue(target, () => this.atomicWrite(target, bytes))
  }

  async deletePageFile(notebookId: string, pageId: string): Promise<void> {
    const file = this.pagePath(notebookId, pageId)
    await this.enqueue(file, async () => {
      await fs.rm(file, { force: true })
      await fs.rm(`${file}.bak`, { force: true })
      this.stamps.delete(file)
    })
  }

  async deleteNotebookFiles(notebookId: string): Promise<void> {
    const dir = this.notebookDir(notebookId)
    for (const key of this.stamps.keys()) if (key.startsWith(dir)) this.stamps.delete(key)
    await fs.rm(dir, { recursive: true, force: true })
  }

  static emptyLibrary(): Library {
    return { schemaVersion: LIBRARY_SCHEMA_VERSION, notebooks: [], folders: [] }
  }

  private async readValidated<T>(file: string, schema: ZodType<T>): Promise<{ data: T | null; recovered: boolean }> {
    const primary = await this.tryRead(file, schema)
    if (primary.ok) {
      this.stamps.set(file, primary.mtime)
      return { data: primary.data, recovered: false }
    }
    if (primary.reason === 'missing') {
      // A missing main file with a surviving backup means an interrupted
      // first-time rename; fall through to the backup in that case too.
      const backup = await this.tryRead(`${file}.bak`, schema)
      return backup.ok ? this.restoreFromBackup(file, backup.data) : { data: null, recovered: false }
    }
    const backup = await this.tryRead(`${file}.bak`, schema)
    // Keep the damaged file for inspection rather than destroying it.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined)
    if (!backup.ok) return { data: null, recovered: true }
    return this.restoreFromBackup(file, backup.data)
  }

  private async restoreFromBackup<T>(file: string, data: T): Promise<{ data: T; recovered: boolean }> {
    // Serialised with other writes to this file, and the new mtime is recorded
    // so the next save is not mistaken for an external change.
    await this.enqueue(file, async () => {
      this.stamps.set(file, await this.atomicWrite(file, JSON.stringify(data, null, 1)))
    })
    return { data, recovered: true }
  }

  private async tryRead<T>(
    file: string,
    schema: ZodType<T>
  ): Promise<{ ok: true; data: T; mtime: number } | { ok: false; reason: 'missing' | 'invalid' }> {
    let raw: string
    let mtime: number
    try {
      raw = await fs.readFile(file, 'utf8')
      mtime = (await fs.stat(file)).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' }
      return { ok: false, reason: 'invalid' }
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      return parsed.success ? { ok: true, data: parsed.data, mtime } : { ok: false, reason: 'invalid' }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  private writeValidated<T>(file: string, schema: ZodType<T>, value: unknown): Promise<SaveResult> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      return Promise.resolve({ status: 'error', message: `Refused to save invalid data: ${parsed.error.issues[0]?.message ?? 'unknown'}` })
    }
    const body = JSON.stringify(parsed.data, null, 1)
    return this.enqueue(file, async (): Promise<SaveResult> => {
      try {
        const current = await fs.stat(file).catch(() => null)
        const known = this.stamps.get(file)
        if (current && current.mtimeMs !== known) {
          const conflictPath = file.replace(/\.json$/, `.conflict-${Date.now()}.json`)
          await this.atomicWrite(conflictPath, body)
          return { status: 'conflict', conflictPath }
        }
        if (current) await fs.copyFile(file, `${file}.bak`)
        this.stamps.set(file, await this.atomicWrite(file, body))
        return { status: 'saved' }
      } catch (err) {
        return { status: 'error', message: (err as Error).message }
      }
    })
  }

  /** Writes via temp file + fsync + rename. Returns the new file's mtime. */
  private async atomicWrite(file: string, body: string | Uint8Array): Promise<number> {
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, file)
    return (await fs.stat(file)).mtimeMs
  }

  private enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(file) ?? Promise.resolve()
    const next = prev.then(task, task)
    this.queues.set(
      file,
      next.catch(() => undefined)
    )
    return next
  }
}

/** On Windows a rename can briefly fail with EPERM/EBUSY while antivirus or
 * indexers hold the target open; retry a few times before giving up. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.rm(from, { force: true })
        throw err
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
    }
  }
}
