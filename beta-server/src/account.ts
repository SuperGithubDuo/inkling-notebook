/**
 * Signed-in requests: who is asking, and on which plan, as Supabase says.
 *
 * The app's Supabase access token is checked by Supabase itself: the Worker
 * calls my_entitlement() with it, and Supabase verifies the signature and
 * expiry, then RLS returns that account's row only. So the Worker holds no
 * service-role key and no JWT secret; its only Supabase settings are the
 * project URL and the public anon key. The plan is never taken from the client.
 *
 * Results are cached briefly per token (by its hash, in memory, never beyond
 * the token's own expiry) so a conversation doesn't add a Supabase call per answer.
 */
import { entitlementSchema, type Plan } from '../../src/shared/entitlements'

export interface Account {
  userId: string
  plan: Plan
}
/** 'invalid': the token isn't a live session (refuse). 'unavailable': Supabase couldn't be asked (refuse, retry soon). */
export type AccountResult = Account | 'invalid' | 'unavailable'
export type Accounts = (token: string) => Promise<AccountResult>

const CACHE_MS = 60_000
const CACHE_MAX = 2000
const TIMEOUT_MS = 5000

/** The JWT's claims, unverified: only used to refuse early and to bound the cache, never to grant anything. */
function claims(token: string): { exp?: number; iss?: string } | null {
  const part = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(token)?.[1]
  if (!part) return null
  try {
    const c = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    return c && typeof c === 'object' ? c : null
  } catch {
    return null
  }
}

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function supabaseAccounts(o: { url: string; anonKey: string; fetch?: typeof fetch; now?: () => number }): Accounts {
  const doFetch = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const base = o.url.replace(/\/+$/, '')
  const cache = new Map<string, { until: number; result: Account | 'invalid' }>()

  return async (token) => {
    if (token.length > 4096) return 'invalid'
    const c = claims(token)
    // Not a JWT from this project, or already expired: refuse without asking Supabase.
    if (!c || typeof c.exp !== 'number' || c.exp * 1000 <= now() || c.iss !== `${base}/auth/v1`) return 'invalid'
    const key = await hash(token)
    const hit = cache.get(key)
    if (hit && now() < hit.until) return hit.result

    let result: Account | 'invalid'
    try {
      const res = await doFetch(`${base}/rest/v1/rpc/my_entitlement`, {
        method: 'POST',
        headers: { apikey: o.anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 401 || res.status === 403) result = 'invalid'
      else if (!res.ok) return 'unavailable'
      else {
        const parsed = entitlementSchema.safeParse(await res.json().catch(() => undefined))
        // null (no session behind the token) or anything malformed: not a verified account.
        result = parsed.success ? { userId: parsed.data.user_id, plan: parsed.data.plan } : 'invalid'
      }
    } catch {
      return 'unavailable'
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(key, { until: Math.min(now() + CACHE_MS, c.exp * 1000), result })
    return result
  }
}
