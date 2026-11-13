/** In-memory stand-ins for local storage and the sync server, for the sync tests. */
import type { SaveResult } from '../../src/shared/ipc'
import { SyncEngine, type LocalAssets, type LocalDocs, type PushResult, type Remote, type RemoteDoc, type RemoteHead, type RemoteVersion, type StateStore, type SyncState, type SyncStatus } from '../../src/shared/sync/engine'

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** Behaves like supabase/migrations: optimistic revisions, a sequence, a version history. */
export class FakeServer {
  docs = new Map<string, RemoteDoc>()
  history: { id: string; path: string; rev: number; content: unknown }[] = []
  assets = new Map<string, Uint8Array>()
  seq = 0
  online = true
  maxAsset = Infinity
  pushes = 0

  remote(): Remote {
    const check = (): void => {
      if (!this.online) throw Object.assign(new Error('offline'), { offline: true })
    }
    return {
      pull: async (since): Promise<RemoteHead[]> => {
        check()
        return [...this.docs.values()]
          .filter((d) => d.seq > since && d.path !== 'library')
          .sort((a, b) => a.seq - b.seq)
          .slice(0, 3)
          .map(({ content: _c, ...head }) => head)
      },
      get: async (path) => {
        check()
        return clone(this.docs.get(path) ?? null)
      },
      push: async (path, baseRev, content, deleted, keepVersion): Promise<PushResult> => {
        check()
        this.pushes++
        const cur = this.docs.get(path)
        if ((cur?.rev ?? 0) !== baseRev) return { ok: false, current: clone(cur ?? null) }
        if (cur && cur.content !== null && keepVersion) this.history.push({ id: `v${this.history.length}`, path, rev: cur.rev, content: cur.content })
        const rev = baseRev + 1
        this.docs.set(path, { path, rev, seq: ++this.seq, deleted, content: deleted ? null : clone(content) })
        return { ok: true, rev }
      },
      uploadAsset: async (key, bytes) => {
        check()
        if (bytes.byteLength > this.maxAsset) return 'too_large'
        this.assets.set(key, bytes)
        return 'ok'
      },
      downloadAsset: async (key) => {
        check()
        return this.assets.get(key) ?? null
      },
      versions: async (path): Promise<RemoteVersion[]> => this.history.filter((h) => h.path === path).map((h) => ({ id: h.id, rev: h.rev, createdAt: '', device: null })),
      version: async (id) => clone(this.history.find((h) => h.id === id)?.content ?? null)
    }
  }
}

/** One device: its local storage survives "restarts" (a new engine over the same stores). */
export class Device {
  docs = new Map<string, unknown>()
  assets = new Map<string, Uint8Array>()
  saved: SyncState | null = null
  bases = new Map<string, unknown>()
  changed: string[] = []
  status: SyncStatus | null = null
  engine!: SyncEngine

  constructor(
    readonly server: FakeServer,
    readonly user = 'user-1'
  ) {
    this.restart()
  }

  restart(): void {
    const docs: LocalDocs = {
      read: async (p) => clone(this.docs.get(p) ?? null),
      write: async (p, c): Promise<SaveResult> => {
        this.docs.set(p, clone(c))
        return { status: 'saved' }
      },
      remove: async (p) => void this.docs.delete(p),
      list: async () => [...this.docs.keys()]
    }
    const assets: LocalAssets = {
      has: async (k) => this.assets.has(k),
      read: async (k) => this.assets.get(k)!,
      write: async (k, b) => void this.assets.set(k, b),
      list: async () => [...this.assets.keys()]
    }
    const state: StateStore = {
      load: async () => clone(this.saved),
      save: async (s) => void (this.saved = clone(s)),
      readBase: async (p) => clone(this.bases.get(p) ?? null),
      writeBase: async (p, c) => void (c === null ? this.bases.delete(p) : this.bases.set(p, clone(c)))
    }
    this.engine = new SyncEngine({
      docs,
      assets,
      state,
      onChange: (paths) => this.changed.push(...paths),
      onStatus: (s) => (this.status = s),
      assetRefs: (_p, c) => ((c as { assets?: string[] } | null)?.assets ?? [])
    })
  }

  async signIn(): Promise<void> {
    await this.engine.link(this.server.remote(), this.user)
    await this.engine.sync()
  }
  sync(): Promise<void> {
    return this.engine.sync()
  }
  async get<T = any>(path: string): Promise<T> {
    return (await this.engine.load(path)) as T
  }
  save(path: string, content: unknown): Promise<SaveResult> {
    return this.engine.save(path, content)
  }
}
