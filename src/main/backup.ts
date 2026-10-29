/**
 * Backups of the whole notebook library.
 *
 * - Automatic snapshots: once a day (checked at startup and every few hours),
 *   into the app's Backups folder, keeping the newest 7. Page, note and
 *   library files are copied; images and PDFs are hard-linked where the file
 *   system allows (they are never modified after they are written, so a link
 *   is as safe as a copy and costs no space), and copied otherwise.
 * - "Back up now": a full copy into a folder the user picks (e.g. a USB
 *   drive or a cloud-synced folder), never links.
 * - Restore: the current library is first snapshotted ("before restore"),
 *   then replaced by the backup. Nothing is deleted until that snapshot is
 *   written and verified.
 *
 * Each backup folder has an `inkling-backup.json` manifest. Temporary files
 * (`*.tmp`) and `.bak` copies are skipped; conflict and damaged-file copies
 * are kept, since they may hold someone's work.
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseLibraryJson } from './storage'

export const MANIFEST = 'inkling-backup.json'
export const AUTO_KEEP = 7
export const AUTO_INTERVAL_MS = 20 * 60 * 60 * 1000

export type BackupKind = 'auto' | 'manual' | 'before-restore' | 'before-update'

export interface BackupInfo {
  path: string
  kind: BackupKind
  createdAt: string
  appVersion: string
  notebooks: number
  pages: number
}

interface Manifest {
  format: 1
  kind: BackupKind
  createdAt: string
  appVersion: string
  notebooks: number
  pages: number
}

const skip = (name: string): boolean => name.endsWith('.tmp') || name.endsWith('.bak')
const stamp = (d: Date): string => d.toISOString().replace('T', ' ').replace(/:/g, '-').slice(0, 19)

async function copyTree(from: string, to: string, opts: { link: boolean }, counts: { files: number }): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyTree(src, dst, opts, counts)
    } else if (entry.isFile()) {
      // Assets are immutable: a hard link is a free, safe copy. JSON files are always copied.
      const linkable = opts.link && basename(from) === 'assets'
      if (linkable) {
        try {
          await fs.link(src, dst)
          counts.files++
          continue
        } catch {
          /* another drive, or links not supported: copy */
        }
      }
      await fs.copyFile(src, dst)
      counts.files++
    }
  }
}

/**
 * Copies the library at `dataDir` into a new folder inside `parentDir` and
 * returns its info. Throws if there is no valid library to back up.
 */
export async function createBackup(dataDir: string, parentDir: string, opts: { kind: BackupKind; appVersion: string; now?: Date; link?: boolean }): Promise<BackupInfo> {
  const raw = await fs.readFile(join(dataDir, 'library.json'), 'utf8')
  const library = parseLibraryJson(raw)
  if (!library) throw new Error('The library index could not be read, so there is nothing reliable to back up.')
  const now = opts.now ?? new Date()
  const label = opts.kind === 'manual' ? 'Inkling backup' : opts.kind
  let dir = join(parentDir, `${stamp(now)} ${label}`)
  for (let i = 2; await exists(dir); i++) dir = join(parentDir, `${stamp(now)} ${label} ${i}`)
  const tmp = `${dir}.partial`
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  const counts = { files: 0 }
  if (await exists(join(dataDir, 'notebooks'))) await copyTree(join(dataDir, 'notebooks'), join(tmp, 'notebooks'), { link: opts.link ?? false }, counts)
  // The index goes in last, as read at the start, so it never lists pages the copy lacks.
  await fs.writeFile(join(tmp, 'library.json'), raw)
  const manifest: Manifest = {
    format: 1,
    kind: opts.kind,
    createdAt: now.toISOString(),
    appVersion: opts.appVersion,
    notebooks: library.notebooks.filter((n) => n.deletedAt === null).length,
    pages: library.notebooks.reduce((n, nb) => n + nb.pages.filter((p) => p.deletedAt === null).length, 0)
  }
  await fs.writeFile(join(tmp, MANIFEST), JSON.stringify(manifest, null, 2))
  // Only a complete backup gets its final name.
  await fs.rename(tmp, dir)
  return { path: dir, ...manifestInfo(manifest) }
}

const manifestInfo = (m: Manifest): Omit<BackupInfo, 'path'> => ({ kind: m.kind, createdAt: m.createdAt, appVersion: m.appVersion, notebooks: m.notebooks, pages: m.pages })

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  )
}

/** Reads a backup folder's manifest and checks its library index; throws with a readable reason. */
export async function readBackup(dir: string): Promise<BackupInfo> {
  const raw = await fs.readFile(join(dir, 'library.json'), 'utf8').catch(() => null)
  if (raw === null) throw new Error('This folder is not an Inkling backup (it has no library.json).')
  const library = parseLibraryJson(raw)
  if (!library) throw new Error('This backup’s library index is damaged or from a newer version of Inkling.')
  const m = (await fs
    .readFile(join(dir, MANIFEST), 'utf8')
    .then((t) => JSON.parse(t) as Manifest)
    .catch(() => null)) ?? {
    format: 1,
    kind: 'manual',
    createdAt: (await fs.stat(join(dir, 'library.json'))).mtime.toISOString(),
    appVersion: 'unknown',
    notebooks: library.notebooks.filter((n) => n.deletedAt === null).length,
    pages: library.notebooks.reduce((n, nb) => n + nb.pages.filter((p) => p.deletedAt === null).length, 0)
  }
  return { path: dir, ...manifestInfo(m) }
}

/** Backups in `parentDir`, newest first. Unreadable folders are skipped. */
export async function listBackups(parentDir: string): Promise<BackupInfo[]> {
  const names = await fs.readdir(parentDir).catch(() => [] as string[])
  const out: BackupInfo[] = []
  for (const name of names) {
    if (name.endsWith('.partial')) continue
    try {
      out.push(await readBackup(join(parentDir, name)))
    } catch {
      /* not a backup */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Takes the daily automatic snapshot if the last one is older than the interval; prunes old ones. */
export async function autoBackupIfDue(dataDir: string, backupsDir: string, appVersion: string, now = new Date()): Promise<BackupInfo | null> {
  const all = await listBackups(backupsDir)
  const autos = all.filter((b) => b.kind === 'auto')
  const last = autos[0]
  if (last && now.getTime() - Date.parse(last.createdAt) < AUTO_INTERVAL_MS) return null
  if (!(await exists(join(dataDir, 'library.json')))) return null
  const info = await createBackup(dataDir, backupsDir, { kind: 'auto', appVersion, now, link: true })
  for (const old of [info, ...autos].slice(AUTO_KEEP)) await fs.rm(old.path, { recursive: true, force: true })
  return info
}

/**
 * Replaces the library at `dataDir` with the backup at `backupDir`. The
 * current library is snapshotted into `backupsDir` first (kept like any
 * backup); returns that snapshot.
 */
export async function restoreBackup(dataDir: string, backupDir: string, backupsDir: string, appVersion: string): Promise<BackupInfo | null> {
  await readBackup(backupDir)
  let safety: BackupInfo | null = null
  if (await exists(join(dataDir, 'library.json'))) {
    safety = await createBackup(dataDir, backupsDir, { kind: 'before-restore', appVersion, link: true })
    await readBackup(safety.path)
  }
  const incoming = `${dataDir}.restoring`
  await fs.rm(incoming, { recursive: true, force: true })
  await copyTree(backupDir, incoming, { link: false }, { files: 0 })
  await fs.rm(join(incoming, MANIFEST), { force: true })
  const outgoing = `${dataDir}.replaced-${Date.now()}`
  if (await exists(dataDir)) await fs.rename(dataDir, outgoing)
  await fs.rename(incoming, dataDir)
  // The replaced library is in the verified "before restore" snapshot; an empty one had nothing to keep.
  if (await exists(outgoing)) {
    if (safety || !(await exists(join(outgoing, 'notebooks')))) await fs.rm(outgoing, { recursive: true, force: true })
  }
  return safety
}

/** Where automatic backups live: next to the library folder, never inside it. */
export const backupsDirFor = (dataDir: string): string => join(dirname(dataDir), 'Backups')
