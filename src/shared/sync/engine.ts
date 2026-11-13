/**
 * Local-first sync, shared by the web app and the desktop app. Notebooks are
 * always read from and written to local storage first (IndexedDB on the web,
 * files on the desktop); this engine sits between the app and that storage,
 * remembers what changed, and reconciles with the account's copy when online.
 *
 * Model: every document (the library, each page, each note) has a server
 * revision. Locally we keep its content, the revision it is based on, whether
 * it changed since (dirty), and — only while dirty — the content at that
 * revision (the base), which is what makes a three-way merge possible.
 *
 * Guarantees:
 *  - Offline edits are queued (dirty) and pushed when the server is reachable.
 *  - A push only succeeds against the revision it was based on. Otherwise the
 *    server's version is merged with ours (merge.ts) and the result is pushed.
 *  - Where both sides changed the same thing, ours stays in the document and
 *    the server keeps theirs in the document's version history. Nothing is
 *    dropped silently: such conflicts are listed in the status.
 *  - A save from the app that was based on content sync has since replaced is
 *    merged, never written over it.
 *  - Deleted on one device and edited on another: the edit is kept.
 *
 * No Supabase, browser or Electron imports: storage and the server are passed in.
 */
import type { SaveResult } from '../ipc'
import { merge3, same } from './merge'

export const LIBRARY_PATH = 'library'
export const pagePath = (notebookId: string, pageId: string): string => `page/${notebookId}/${pageId}`
export const notePath = (notebookId: string, pageId: string): string => `note/${notebookId}/${pageId}`

/** Local documents, by path. Content is validated by the store when written. */
export interface LocalDocs {
  read(path: string): Promise<unknown | null>
  write(path: string, content: unknown): Promise<SaveResult>
  remove(path: string): Promise<void>
  list(): Promise<string[]>
}

/** Local image and PDF files, by `<notebookId>/<assetName>`. They never change once written. */
export interface LocalAssets {
  has(key: string): Promise<boolean>
  read(key: string): Promise<Uint8Array>
  write(key: string, bytes: Uint8Array): Promise<void>
  list(): Promise<string[]>
}

export interface DocState {
  /** Server revision our content is based on (0: the server has never seen it). */
  rev: number
  dirty: boolean
  /** Deleted here; the deletion still has to reach the server. */
  deleted?: boolean
  /** Our next push replaces a version we conflicted with: the server must keep that one in the history. */
  keep?: boolean
}

export interface SyncConflict {
  path: string
  at: number
}

export interface SyncState {
  /** The account these notebooks sync with. */
  owner: string | null
  /** Server sequence number up to which changes have been applied. */
  cursor: number
  docs: Record<string, DocState>
  /** Assets still to upload / to download. */
  assetsUp: string[]
  assetsDown: string[]
  /** Assets that can't sync (too large for the plan), with the reason. They stay on this device. */
  skipped: Record<string, string>
  conflicts: SyncConflict[]
}

export interface StateStore {
  load(): Promise<SyncState | null>
  save(state: SyncState): Promise<void>
  readBase(path: string): Promise<unknown | null>
  /** null removes it. */
  writeBase(path: string, content: unknown | null): Promise<void>
}

export interface RemoteDoc {
  path: string
  rev: number
  seq: number
  deleted: boolean
  content: unknown | null
}

export interface RemoteVersion {
  id: string
  rev: number
  createdAt: string
  device: string | null
}

export type RemoteHead = Omit<RemoteDoc, 'content'>

export type PushResult = { ok: true; rev: number } | { ok: false; current: RemoteDoc | null }

/** The account's copy. Throws on network or server failure (the engine retries later). */
export interface Remote {
  /** Which documents (other than the library) changed after `sinceSeq`, oldest first, at most one page of them. No content. */
  pull(sinceSeq: number): Promise<RemoteHead[]>
  get(path: string): Promise<RemoteDoc | null>
  /** Writes only if the server is still at `baseRev`. `keepVersion` forces the replaced content into the history. */
  push(path: string, baseRev: number, content: unknown | null, deleted: boolean, keepVersion: boolean): Promise<PushResult>
  /** `too_large`: over the storage plan's file size limit. */
  uploadAsset(key: string, bytes: Uint8Array): Promise<'ok' | 'too_large'>
  downloadAsset(key: string): Promise<Uint8Array | null>
  versions(path: string): Promise<RemoteVersion[]>
  version(id: string): Promise<unknown | null>
}

export interface SyncStatus {
  /** off: no account. */
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'
  /** Local changes not yet on the server (documents and files). */
  pending: number
  lastSyncedAt: number | null
  message?: string
  conflicts: SyncConflict[]
  /** Files that stay on this device only. */
  skipped: number
}

export interface EngineOptions {
  docs: LocalDocs
  assets: LocalAssets
  state: StateStore
  /** Documents whose local content was replaced by sync; the app reloads the ones it has open. */
  onChange?: (paths: string[]) => void
  onStatus?: (status: SyncStatus) => void
  /** Finds the asset keys a document refers to. */
  assetRefs?: (path: string, content: unknown) => string[]
  /**
   * Called with this device's copy the first time it meets the account's copy of the same document
   * (no common ancestor). Returns what to merge in: lets the app leave out untouched starter notebooks.
   */
  firstMerge?: (path: string, local: unknown) => Promise<unknown>
  now?: () => number
}

const emptyState = (): SyncState => ({ owner: null, cursor: 0, docs: {}, assetsUp: [], assetsDown: [], skipped: {}, conflicts: [] })
const MAX_CONFLICTS = 50

export class SyncEngine {
  private state: SyncState = emptyState()
  private remote: Remote | null = null
  private loaded: Promise<void> | null = null
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Bumped by every local write, so a push can tell whether the document changed meanwhile. */
  private readonly gens = new Map<string, number>()
  /** What the app last had for a document sync has since replaced: the ancestor for merging its next save. */
  private readonly stale = new Map<string, unknown>()
  private running: Promise<void> | null = null
  private again = false
  private status: SyncStatus = { state: 'off', pending: 0, lastSyncedAt: null, conflicts: [], skipped: 0 }
  private readonly now: () => number

  constructor(private readonly o: EngineOptions) {
    this.now = o.now ?? Date.now
  }

  private ready(): Promise<void> {
    return (this.loaded ??= this.o.state.load().then((s) => {
      if (s) this.state = { ...emptyState(), ...s }
    }))
  }

  get current(): SyncStatus {
    return this.status
  }
  get owner(): string | null {
    return this.state.owner
  }

  // ---------------------------------------------------------------- the app's side

  /** Reads a document for the app. */
  async load(path: string): Promise<unknown | null> {
    await this.ready()
    return this.enqueue(path, async () => {
      this.stale.delete(path)
      return this.o.docs.read(path)
    })
  }

  /** Saves a document from the app. */
  async save(path: string, content: unknown): Promise<SaveResult> {
    await this.ready()
    return this.enqueue(path, async () => {
      let next = content
      if (this.stale.has(path)) {
        // The app's copy predates a change sync brought in: merge its edits onto the current content.
        const stored = await this.o.docs.read(path)
        if (stored !== null) next = merge3(this.stale.get(path), content, stored).merged
        this.stale.set(path, content)
        if (!same(next, content)) queueMicrotask(() => this.o.onChange?.([path]))
      }
      if (this.state.owner) await this.markDirty(path)
      const result = await this.o.docs.write(path, next)
      this.bump(path)
      if (result.status === 'saved' && this.state.owner && this.o.assetRefs) await this.want(this.o.assetRefs(path, next))
      this.report()
      return result
    })
  }

  /** Deletes a document for good (emptying the Trash). */
  async remove(path: string): Promise<void> {
    await this.ready()
    await this.enqueue(path, async () => {
      this.stale.delete(path)
      if (this.state.owner) {
        const d = this.state.docs[path]
        // Never reached the server: nothing to tell it.
        if (!d || d.rev === 0) delete this.state.docs[path]
        else this.state.docs[path] = { rev: d.rev, dirty: true, deleted: true }
        await this.o.state.writeBase(path, null)
        await this.persist()
      }
      await this.o.docs.remove(path)
      this.bump(path)
      this.report()
    })
  }

  /** A new image or PDF was stored locally. */
  async assetAdded(key: string): Promise<void> {
    await this.ready()
    if (!this.state.owner || this.state.assetsUp.includes(key)) return
    this.state.assetsUp.push(key)
    await this.persist()
    this.report()
  }

  // ---------------------------------------------------------------- account

  /**
   * Starts syncing with an account. Everything already on this device that
   * the account hasn't seen is queued to be merged in (never to overwrite).
   */
  async link(remote: Remote, userId: string): Promise<void> {
    await this.ready()
    if (this.state.owner !== userId) {
      for (const path of Object.keys(this.state.docs)) await this.o.state.writeBase(path, null)
      this.state = { ...emptyState(), owner: userId }
    }
    for (const path of await this.o.docs.list()) this.state.docs[path] ??= { rev: 0, dirty: true }
    const known = new Set(this.state.assetsUp)
    for (const key of await this.o.assets.list()) if (!known.has(key) && !this.state.skipped[key]) this.state.assetsUp.push(key)
    await this.persist()
    this.remote = remote
    this.setStatus({ state: 'idle' })
  }

  /** The app is about to read this document straight from storage: its copy will be current. */
  seen(path: string): void {
    this.stale.delete(path)
  }

  /**
   * Local storage was replaced wholesale (a backup was restored): what is here now is the user's
   * choice, so all of it is queued as changes. Where the account hasn't moved on since, the restored
   * content replaces the account's (which goes into the history); where it has, the two are merged.
   */
  async markAllDirty(): Promise<void> {
    await this.ready()
    if (!this.state.owner) return
    const here = new Set(await this.o.docs.list())
    for (const path of Object.keys(this.state.docs)) {
      await this.o.state.writeBase(path, null)
      if (!here.has(path)) delete this.state.docs[path]
    }
    // keep: the account's current version of each goes into its history before the restored one replaces it.
    for (const path of here) this.state.docs[path] = { rev: this.state.docs[path]?.rev ?? 0, dirty: true, keep: true }
    await this.persist()
    this.report()
  }

  /** Stops syncing. Local notebooks and the record of unsynced changes stay. */
  unlink(): void {
    this.remote = null
    this.setStatus({ state: 'off', message: undefined })
  }

  /** Changes on this device that the server doesn't have yet. */
  pendingCount(): number {
    return Object.values(this.state.docs).filter((d) => d.dirty).length + this.state.assetsUp.length
  }

  // ---------------------------------------------------------------- sync

  /** Pulls, merges and pushes. Safe to call at any time; concurrent calls share one run. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.cycle()
        } while (this.again && this.remote)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async cycle(): Promise<void> {
    await this.ready()
    const remote = this.remote
    if (!remote) return
    this.setStatus({ state: 'syncing', message: undefined })
    try {
      const changed: string[] = []
      let pullError: unknown = null
      try {
        // Pages and notes first, the library last: a library never lists a page this device doesn't have yet.
        for (;;) {
          const batch = await remote.pull(this.state.cursor)
          if (!batch.length) break
          for (const head of batch) {
            if ((this.state.docs[head.path]?.rev ?? 0) >= head.rev) continue
            const doc = head.deleted ? { ...head, content: null } : await remote.get(head.path)
            if (doc && (await this.apply(doc))) changed.push(doc.path)
          }
          this.state.cursor = Math.max(this.state.cursor, ...batch.map((d) => d.seq))
          await this.persist()
        }
        const lib = await remote.get(LIBRARY_PATH)
        if (lib && lib.rev !== (this.state.docs[LIBRARY_PATH]?.rev ?? 0) && (await this.apply(lib))) changed.push(LIBRARY_PATH)
      } catch (err) {
        // One document this device can't take (say, from a newer Inkling) must not stop its own work going up.
        if ((err as { offline?: boolean }).offline) throw err
        pullError = err
      }
      if (changed.length) this.o.onChange?.(changed)

      const dirty = Object.keys(this.state.docs).filter((p) => this.state.docs[p]!.dirty)
      for (const path of dirty.sort((a, b) => Number(a === LIBRARY_PATH) - Number(b === LIBRARY_PATH))) {
        if (await this.push(remote, path)) this.o.onChange?.([path])
      }
      // Files last: a large upload never holds back the notes themselves.
      await this.transferAssets(remote)
      if (pullError) throw pullError
      this.setStatus({ state: 'idle', lastSyncedAt: this.now(), message: undefined })
    } catch (err) {
      const offline = (err as { offline?: boolean }).offline === true
      this.setStatus({ state: offline ? 'offline' : 'error', message: offline ? undefined : (err as Error).message })
    }
  }

  /** Applies one server document locally. Returns true if local content changed. */
  private apply(doc: RemoteDoc): Promise<boolean> {
    return this.enqueue(doc.path, async () => {
      const path = doc.path
      const d = this.state.docs[path]
      if (d && d.rev >= doc.rev) return false
      const local = d?.deleted ? null : await this.o.docs.read(path)
      const finish = async (dirty: boolean, keep = false): Promise<void> => {
        if (!dirty) await this.o.state.writeBase(path, null)
        this.state.docs[path] = { rev: doc.rev, dirty, ...(dirty && keep ? { keep } : {}) }
        await this.persist()
      }
      if (doc.deleted || doc.content === null) {
        if (d?.dirty && local !== null) {
          // Deleted there, edited here: the edit is kept and goes back up.
          await this.o.state.writeBase(path, null)
          await finish(true)
          return false
        }
        if (local !== null) {
          this.remember(path, local)
          await this.o.docs.remove(path)
        }
        await finish(false)
        return local !== null
      }
      if (local === null || !d?.dirty) {
        // Nothing of ours to keep (also: deleted here but changed there — their change is kept).
        if (local !== null && same(local, doc.content)) {
          await finish(false)
          return false
        }
        const written = await this.o.docs.write(path, doc.content)
        if (written.status !== 'saved') throw new Error(`Could not store ${path}: ${written.status === 'error' ? written.message : 'the file was changed by another program'}`)
        this.remember(path, local)
        await this.want(this.o.assetRefs?.(path, doc.content) ?? [])
        await finish(false)
        return true
      }
      // Changed on both sides.
      const base = d.rev === 0 ? undefined : await this.o.state.readBase(path)
      const mine = d.rev === 0 && this.o.firstMerge ? await this.o.firstMerge(path, local) : local
      const { merged, conflicts } = merge3(base, mine, doc.content)
      if (conflicts.length) this.noteConflict(path)
      const keep = conflicts.length > 0 || !!d.keep
      const changed = !same(merged, local)
      if (changed) {
        const written = await this.o.docs.write(path, merged)
        if (written.status !== 'saved') throw new Error(`Could not store ${path}: ${written.status === 'error' ? written.message : 'the file was changed by another program'}`)
        this.remember(path, local)
        this.bump(path)
        await this.want(this.o.assetRefs?.(path, merged) ?? [])
      }
      const dirty = !same(merged, doc.content)
      if (dirty) await this.o.state.writeBase(path, doc.content)
      await finish(dirty, keep)
      return changed
    })
  }

  /** Pushes one dirty document; on a revision mismatch merges and tries again. Returns true if local content changed. */
  private async push(remote: Remote, path: string): Promise<boolean> {
    let changed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.enqueue(path, async () => {
        const d = this.state.docs[path]
        if (!d?.dirty) return null
        return { d, gen: this.gens.get(path) ?? 0, content: d.deleted ? null : await this.o.docs.read(path) }
      })
      if (!snapshot) return changed
      const { d, gen, content } = snapshot
      if (!d.deleted && content === null) {
        // Marked changed but no longer here (removed outside the app): nothing to send.
        await this.enqueue(path, async () => {
          delete this.state.docs[path]
          await this.persist()
        })
        return changed
      }
      const result = await remote.push(path, d.rev, content, !!d.deleted, !!d.keep)
      if (result.ok) {
        await this.enqueue(path, async () => {
          const still = (this.gens.get(path) ?? 0) !== gen
          // Edited again while this was on its way: what we sent becomes the base of the next push.
          if (still) await this.o.state.writeBase(path, content)
          else await this.o.state.writeBase(path, null)
          if (d.deleted && !still) delete this.state.docs[path]
          else this.state.docs[path] = { ...(still ? this.state.docs[path]! : {}), rev: result.rev, dirty: still, keep: undefined }
          await this.persist()
        })
        return changed
      }
      if (!result.current) throw new Error(`The server refused ${path}.`)
      if (await this.apply(result.current)) changed = true
    }
    throw new Error(`${path} keeps changing on the server; it will be retried.`)
  }

  private async transferAssets(remote: Remote): Promise<void> {
    for (const key of [...this.state.assetsUp]) {
      if (await this.o.assets.has(key)) {
        const outcome = await remote.uploadAsset(key, await this.o.assets.read(key))
        if (outcome === 'too_large') this.state.skipped[key] = 'too large to sync'
      }
      this.state.assetsUp = this.state.assetsUp.filter((k) => k !== key)
      await this.persist()
      this.report()
    }
    for (const key of [...this.state.assetsDown]) {
      if (!(await this.o.assets.has(key))) {
        const bytes = await remote.downloadAsset(key)
        // Not uploaded yet by the device that has it: asked for again next time.
        if (!bytes) continue
        await this.o.assets.write(key, bytes)
      }
      this.state.assetsDown = this.state.assetsDown.filter((k) => k !== key)
      await this.persist()
    }
  }

  // ---------------------------------------------------------------- history

  async versions(path: string): Promise<RemoteVersion[]> {
    if (!this.remote) throw new Error('Sign in to see earlier versions.')
    return this.remote.versions(path)
  }

  /** Brings an earlier version back as the current content (itself a normal, synced edit). */
  async restoreVersion(path: string, versionId: string): Promise<SaveResult> {
    if (!this.remote) return { status: 'error', message: 'Sign in to restore earlier versions.' }
    const content = await this.remote.version(versionId)
    if (content === null) return { status: 'error', message: 'That version is no longer available.' }
    await this.ready()
    const result = await this.enqueue(path, async () => {
      const local = await this.o.docs.read(path)
      await this.markDirty(path)
      const written = await this.o.docs.write(path, content)
      if (written.status === 'saved') {
        this.remember(path, local)
        this.bump(path)
        await this.want(this.o.assetRefs?.(path, content) ?? [])
      }
      return written
    })
    if (result.status === 'saved') {
      this.dismissConflict(path)
      this.o.onChange?.([path])
    }
    return result
  }

  dismissConflict(path: string): void {
    this.state.conflicts = this.state.conflicts.filter((c) => c.path !== path)
    void this.persist()
    this.report()
  }

  // ---------------------------------------------------------------- internals

  /** First local change since the last sync: keep the synced content as the merge base. */
  private async markDirty(path: string): Promise<void> {
    const d = this.state.docs[path]
    if (d?.dirty && !d.deleted) return
    if (d && d.rev > 0 && !d.deleted) await this.o.state.writeBase(path, await this.o.docs.read(path))
    this.state.docs[path] = { rev: d?.rev ?? 0, dirty: true }
    await this.persist()
  }

  private remember(path: string, previous: unknown | null): void {
    if (previous !== null && !this.stale.has(path)) this.stale.set(path, previous)
  }

  private async want(keys: string[]): Promise<void> {
    let added = false
    for (const key of keys) {
      if (this.state.assetsDown.includes(key) || (await this.o.assets.has(key))) continue
      this.state.assetsDown.push(key)
      added = true
    }
    if (added) await this.persist()
  }

  private noteConflict(path: string): void {
    this.state.conflicts = [...this.state.conflicts.filter((c) => c.path !== path), { path, at: this.now() }].slice(-MAX_CONFLICTS)
  }

  private bump(path: string): void {
    this.gens.set(path, (this.gens.get(path) ?? 0) + 1)
  }

  private saving: Promise<void> = Promise.resolve()
  /** One write at a time, each with the state as it is when its turn comes. */
  private persist(): Promise<void> {
    const run = (): Promise<void> => this.o.state.save(this.state)
    return (this.saving = this.saving.then(run, run))
  }

  private report(): void {
    this.setStatus({})
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const next: SyncStatus = {
      ...this.status,
      ...patch,
      pending: this.pendingCount(),
      conflicts: this.state.conflicts,
      skipped: Object.keys(this.state.skipped).length
    }
    if (!this.remote) next.state = 'off'
    if (same(next, this.status)) return
    this.status = next
    this.o.onStatus?.(next)
  }

  private enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(path) ?? Promise.resolve()
    const next = prev.then(task, task)
    this.queues.set(
      path,
      next.catch(() => undefined)
    )
    return next
  }
}

/**
 * Keeps an engine in step without being asked: shortly after each local change, every minute,
 * and whenever the caller says the network or the window came back (`poke(0)`).
 */
export function autoSync(engine: SyncEngine, intervalMs = 60_000): { poke(delayMs?: number): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const poke = (delayMs = 2000): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void engine.sync()
    }, delayMs)
  }
  const interval = setInterval(() => void engine.sync(), intervalMs)
  return {
    poke,
    stop() {
      if (timer) clearTimeout(timer)
      clearInterval(interval)
    }
  }
}
