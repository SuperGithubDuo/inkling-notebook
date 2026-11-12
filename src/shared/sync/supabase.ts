/**
 * The account's copy of the notebooks, in Supabase: documents in Postgres
 * (supabase/migrations), files in a private Storage bucket. Used by the web
 * app directly and by the desktop app's main process.
 *
 * The URL and anon key are public by design (they identify the project); what
 * a signed-in user can reach is decided by the database's row-level security.
 */
import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js'
import { IMAGE_MIME } from '../assets'
import type { PushResult, Remote, RemoteDoc, RemoteHead, RemoteVersion } from './engine'

export type { SupabaseClient }
export const ASSET_BUCKET = 'assets'
/** The Supabase free plan's per-file upload limit. */
export const MAX_SYNC_ASSET_BYTES = 50 * 1024 * 1024
const PAGE = 200

export interface SupabaseConfig {
  url: string
  anonKey: string
}

/** Reads the build's Supabase settings; null (accounts off) unless both are well-formed. */
export function supabaseConfig(url: string | undefined, anonKey: string | undefined): SupabaseConfig | null {
  if (!url || !anonKey || !/^https:\/\/[a-z0-9.-]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.replace(/\/+$/, ''))) return null
  return { url: url.replace(/\/+$/, ''), anonKey }
}

export function createSupabase(config: SupabaseConfig, options: { storage?: SupportedStorage; detectSessionInUrl: boolean }): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: options.detectSessionInUrl, ...(options.storage ? { storage: options.storage } : {}) }
  })
}

class SyncError extends Error {
  constructor(
    message: string,
    readonly offline: boolean
  ) {
    super(message)
  }
}

/** Turns a Supabase error into one the engine understands (offline: retry quietly). */
function fail(what: string, error: { message?: string; status?: number; code?: string } | null): never {
  const message = error?.message ?? 'unknown error'
  const offline = /fetch|network|load failed|timed? ?out/i.test(message) && !error?.code
  if (error?.status === 401 || error?.code === 'PGRST301' || /jwt/i.test(message)) throw new SyncError('Your sign-in has expired. Sign in again to keep syncing.', false)
  throw new SyncError(offline ? 'Offline' : `${what}: ${message}`, offline)
}

export function supabaseRemote(client: SupabaseClient, userId: string, device: string): Remote {
  const docs = () => client.from('docs')
  const object = (key: string): string => `${userId}/${key}`
  return {
    async pull(sinceSeq): Promise<RemoteHead[]> {
      const { data, error } = await docs().select('path,rev,seq,deleted').gt('seq', sinceSeq).neq('path', 'library').order('seq').limit(PAGE)
      if (error) fail('Could not check for changes', error)
      return (data ?? []) as RemoteHead[]
    },
    async get(path): Promise<RemoteDoc | null> {
      const { data, error } = await docs().select('path,rev,seq,deleted,content').eq('path', path).maybeSingle()
      if (error) fail('Could not download a page', error)
      return (data as RemoteDoc | null) ?? null
    },
    async push(path, baseRev, content, deleted, keepVersion): Promise<PushResult> {
      const { data, error } = await client.rpc('push_doc', { p_path: path, p_base_rev: baseRev, p_content: content, p_deleted: deleted, p_keep_version: keepVersion, p_device: device })
      if (error) fail('Could not upload a page', error)
      return data as PushResult
    },
    async uploadAsset(key, bytes) {
      if (bytes.byteLength > MAX_SYNC_ASSET_BYTES) return 'too_large'
      const ext = key.slice(key.lastIndexOf('.') + 1)
      const { error } = await client.storage.from(ASSET_BUCKET).upload(object(key), bytes, { contentType: IMAGE_MIME[ext] ?? 'application/octet-stream', upsert: false })
      if (!error) return 'ok'
      const e = error as { message?: string; statusCode?: string; status?: number }
      // Files never change, so "already there" is success.
      if (e.statusCode === '409' || e.status === 409 || /exists|duplicate/i.test(e.message ?? '')) return 'ok'
      if (e.statusCode === '413' || e.status === 413 || /exceeded the maximum|too large/i.test(e.message ?? '')) return 'too_large'
      return fail('Could not upload a file', e)
    },
    async downloadAsset(key) {
      const { data, error } = await client.storage.from(ASSET_BUCKET).download(object(key))
      if (error) {
        const e = error as { message?: string; status?: number; statusCode?: string; originalError?: { status?: number } }
        const status = e.status ?? e.originalError?.status ?? Number(e.statusCode)
        if (status === 404 || status === 400 || /not found/i.test(e.message ?? '')) return null
        return fail('Could not download a file', e)
      }
      return new Uint8Array(await data.arrayBuffer())
    },
    async versions(path): Promise<RemoteVersion[]> {
      const { data, error } = await client.from('doc_versions').select('id,rev,created_at,device').eq('path', path).order('created_at', { ascending: false }).limit(20)
      if (error) fail('Could not list earlier versions', error)
      return (data ?? []).map((v) => ({ id: v.id as string, rev: v.rev as number, createdAt: v.created_at as string, device: (v.device as string | null) ?? null }))
    },
    async version(id) {
      const { data, error } = await client.from('doc_versions').select('content').eq('id', id).maybeSingle()
      if (error) fail('Could not download that version', error)
      return (data?.content as unknown) ?? null
    }
  }
}
