/**
 * The app's AI tutor with an Inkling account: the real AiService, AiConfig and
 * CloudProvider against the real AI server code (fakeBeta) with account
 * verification on. The signed-in account is a stand-in for main/account.ts and
 * web/account.ts (their shared token getter, accessTokenFor, is tested at the end).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService, type AiAccount } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OllamaProvider } from '../../src/main/ai/ollama'
import { accessTokenFor, type SupabaseClient } from '../../src/shared/sync/supabase'
import { CLOUD_ANON_CONSENT_VERSION, CLOUD_CONSENT_VERSION, type AiEvent, type CloudQuota } from '../../src/shared/ai'
import { planLabel, quotaText } from '../../src/renderer/src/ai/AiSettings'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const REFRESH_SECRET = 'refresh-token-that-must-never-leave'

const cipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(s),
  decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false })
}

/**
 * Supabase as both sides see it: tokens the server accepts (and for which plan), and each
 * user's current session on this device. Refreshing issues a new access token.
 */
function accounts() {
  const valid = new Map<string, { userId: string; plan: 'free' | 'pro' }>()
  const session = new Map<string, string>()
  const plans = new Map<string, 'free' | 'pro'>()
  const s = { user: null as string | null, down: false, offline: false, refreshFails: false, gets: 0, refreshes: 0, n: 0 }
  const issue = (userId: string): string => {
    const t = `access-${userId.slice(0, 4)}-${++s.n}`
    valid.set(t, { userId, plan: plans.get(userId) ?? 'free' })
    session.set(userId, t)
    return t
  }
  const signIn = (userId: string, plan: 'free' | 'pro' = 'free'): string => {
    plans.set(userId, plan)
    s.user = userId
    return issue(userId)
  }
  const account: AiAccount = {
    userId: () => s.user,
    accessToken: async (userId, refresh) => {
      if (s.offline) throw new Error('Couldn’t reach the sign-in server.')
      if (refresh) s.refreshes++
      else s.gets++
      if (s.user !== userId || !session.has(userId)) return null
      if (!refresh) return session.get(userId)!
      if (s.refreshFails) {
        session.delete(userId)
        return null
      }
      return issue(userId)
    }
  }
  /** The server's verifier (beta-server/src/account.ts in production). */
  const verify = async (token: string) => (s.down ? ('unavailable' as const) : (valid.get(token) ?? ('invalid' as const)))
  return { s, valid, session, signIn, account, verify, expire: (t: string) => valid.delete(t) }
}

describe('the AI tutor with an account', () => {
  let server: BetaServer
  let service: AiService
  let config: AiConfig
  let acc: ReturnType<typeof accounts>
  let events: AiEvent[]

  const make = async (opts: { accountsOff?: boolean; consent?: number | null } = {}) => {
    acc = accounts()
    server = await startBetaServer({ ...(opts.accountsOff ? {} : { accounts: acc.verify }), limits: { pro: { daily: 2700 } } })
    config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-account-ai-')), cipher, { builtInCloudUrl: server.url, defaultProvider: 'cloud' })
    await config.load()
    const consent = opts.consent === undefined ? CLOUD_CONSENT_VERSION : opts.consent
    // As an earlier version would have saved it.
    ;(config as unknown as { settings: Record<string, unknown> }).settings.cloudConsent = consent === null ? null : { version: consent, acceptedAt: '2026-11-10T00:00:00.000Z' }
    events = []
    service = new AiService({
      config,
      account: acc.account,
      makeProvider: (k) => new GeminiProvider({ apiKey: k, baseUrl: 'http://127.0.0.1:9' }),
      makeLocalProvider: () => new OllamaProvider({ baseUrl: 'http://127.0.0.1:9' }),
      emit: (e) => events.push(e),
      limits: { duplicateWindowMs: 0, minIntervalMs: 0 }
    })
  }
  afterEach(async () => server?.close())

  const finish = async (id: string): Promise<AiEvent> => {
    for (;;) {
      const e = events.find((x) => x.requestId === id && x.type !== 'delta')
      if (e) return e
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const ask = async (text = 'hi'): Promise<AiEvent> => {
    const r = service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }] })
    if ('error' in r) return { type: 'error', requestId: '', error: r.error } as AiEvent
    return finish(r.requestId)
  }
  const tutorRequests = () => server.requests.filter((r) => r.path === '/v1/tutor')
  const authOf = (r: { headers: Record<string, unknown> }) => r.headers.authorization as string | undefined
  const quota = (): CloudQuota | null => service.status().cloud.quota

  it('signed out: anonymous as before, with no token, and the earlier (v4) agreement still counts', async () => {
    await make({ consent: CLOUD_ANON_CONSENT_VERSION })
    expect(service.status().consented).toBe(true)
    expect((await ask()).type).toBe('done')
    expect(authOf(tutorRequests()[0]!)).toBeUndefined()
    expect(quota()?.plan).toBeUndefined()
    expect(acc.s.gets + acc.s.refreshes).toBe(0)
  })

  it('signed in: sends the access token (never the refresh token) and shows the plan the server verified', async () => {
    await make()
    const token = acc.signIn(BOB, 'pro')
    service.accountChanged()
    expect((await ask()).type).toBe('done')
    const sent = tutorRequests()[0]!
    expect(authOf(sent)).toBe(`Bearer ${token}`)
    expect(quota()).toMatchObject({ plan: 'pro', installLimit: 2700 })
    expect(planLabel(quota()!)).toBe('Pro')
    expect(quotaText(quota()!)).toMatch(/left today on your account\.$/)
    // The status check carries the token too.
    await service.freshStatus()
    expect(server.requests.filter((r) => r.path === '/v1/status').every((r) => authOf(r) === `Bearer ${token}`)).toBe(true)
  })

  it('a plan in the request changes nothing: the server decides', async () => {
    await make()
    acc.signIn(ALICE, 'free')
    const r = service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }], plan: 'pro' } as never)
    if (!('error' in r)) await finish(r.requestId)
    expect(quota()).toMatchObject({ plan: 'free', installLimit: 900 })
  })

  it('consent: signed in with only the earlier agreement, nothing is sent until the new notice is accepted, then not asked again', async () => {
    await make({ consent: CLOUD_ANON_CONSENT_VERSION })
    acc.signIn(ALICE)
    service.accountChanged()
    expect(service.status().consented).toBe(false)
    const refused = await ask()
    expect(refused.type === 'error' && refused.error.code).toBe('consent_required')
    // Declining sends nothing, and keeps nothing.
    await service.setConsent(false)
    expect(server.requests).toHaveLength(0)
    expect(acc.s.gets).toBe(0)
    await service.setConsent(true)
    expect(config.cloudConsentVersion).toBe(CLOUD_CONSENT_VERSION)
    expect((await ask()).type).toBe('done')
    expect(authOf(tutorRequests()[0]!)).toMatch(/^Bearer access-/)
    // Saved: a restart doesn't ask again.
    const again = new AiConfig((config as unknown as { dir: string }).dir, cipher, { builtInCloudUrl: server.url, defaultProvider: 'cloud' })
    await again.load()
    expect(again.cloudConsentVersion).toBe(CLOUD_CONSENT_VERSION)
  })

  it('a refused token is refreshed once and the request sent again', async () => {
    await make()
    const stale = acc.signIn(ALICE)
    acc.expire(stale)
    expect((await ask()).type).toBe('done')
    expect(acc.s.refreshes).toBe(1)
    const auths = tutorRequests().map(authOf)
    expect(auths).toHaveLength(2)
    expect(auths[0]).toBe(`Bearer ${stale}`)
    expect(auths[1]).not.toBe(auths[0])
  })

  it('an expired session: one refresh, then “sign in again”, and never an anonymous request', async () => {
    await make()
    const stale = acc.signIn(ALICE)
    acc.expire(stale)
    acc.s.refreshFails = true
    const e = await ask()
    expect(e.type === 'error' && e.error).toMatchObject({ code: 'invalid_key', message: expect.stringMatching(/Sign in again/) })
    expect(tutorRequests()).toHaveLength(1)
    expect(server.requests.every((r) => !!authOf(r))).toBe(true)
    // No session at all (lapsed while closed): refused here, before anything is sent.
    const before = server.requests.length
    const again = await ask('another')
    expect(again.type === 'error' && again.error.code).toBe('invalid_key')
    expect(server.requests.length).toBe(before)
  })

  it('account switching: the previous account’s token, allowance and pauses never carry over', async () => {
    await make()
    acc.signIn(ALICE, 'free')
    service.accountChanged()
    expect((await ask()).type).toBe('done')
    expect(quota()?.plan).toBe('free')
    const bobToken = acc.signIn(BOB, 'pro')
    service.accountChanged()
    // Cleared at once; the new account's allowance is fetched with the new token.
    expect(service.status().cloud.quota?.plan ?? null).not.toBe('free')
    await server.settled()
    await new Promise((r) => setTimeout(r, 50))
    expect(quota()?.plan).toBe('pro')
    expect((await ask('bob')).type).toBe('done')
    expect(authOf(tutorRequests().at(-1)!)).toBe(`Bearer ${bobToken}`)
    // Signed out: anonymous again, and no account figures shown.
    acc.s.user = null
    service.accountChanged()
    expect(service.status().cloud.quota).toBeNull()
    expect((await ask('anon')).type).toBe('done')
    expect(authOf(tutorRequests().at(-1)!)).toBeUndefined()
    expect(quota()?.plan).toBeUndefined()
  })

  it('an answer in progress when the account changes is stopped, and its report doesn’t land on the new account', async () => {
    await make()
    acc.signIn(ALICE, 'free')
    server.ai.reply({ chunks: Array.from({ length: 20 }, () => 'word '), chunkDelayMs: 40 })
    const r = service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'slow' }] }] })
    if ('error' in r) throw new Error(r.error.message)
    await new Promise((res) => setTimeout(res, 120))
    acc.signIn(BOB, 'pro')
    service.accountChanged()
    const e = await finish(r.requestId)
    expect(e.type === 'error' && e.error.code).toBe('canceled')
    await server.settled()
    await new Promise((res) => setTimeout(res, 50))
    expect(quota()?.plan).toBe('pro')
  })

  it('a server without account verification: the token is sent, but no account allowance is shown', async () => {
    await make({ accountsOff: true })
    acc.signIn(ALICE)
    expect((await ask()).type).toBe('done')
    expect(quota()?.plan).toBeUndefined()
    expect(planLabel(quota()!)).toBeNull()
    expect(quotaText(quota()!)).toMatch(/on this computer/)
  })

  it('account verification unavailable: a retryable server error, no long pause, and the retry works', async () => {
    await make()
    acc.signIn(ALICE)
    acc.s.down = true
    const e = await ask()
    expect(e.type === 'error' && e.error).toMatchObject({ code: 'server', message: expect.stringMatching(/couldn’t check your account/) })
    expect(service.status().cooldown?.reason ?? null).not.toBe('daily_quota')
    acc.s.down = false
    expect((await ask('again')).type).toBe('done')
  })

  it('offline: a network error (not “sign in again”), and nothing reaches the server', async () => {
    await make()
    acc.signIn(ALICE)
    acc.s.offline = true
    const e = await ask()
    expect(e.type === 'error' && e.error.code).toBe('network')
    expect(server.requests).toHaveLength(0)
  })

  it('the local tutor (Ollama) never asks for a token', async () => {
    await make()
    acc.signIn(ALICE)
    await service.setProvider('ollama')
    await ask()
    await service.freshStatus()
    expect(acc.s.gets + acc.s.refreshes).toBe(0)
  })

  it('quota wording for accounts, exhaustion included', () => {
    const q: CloudQuota = { installUsed: 900, installLimit: 900, networkUsed: 900, networkLimit: 2700, globalUsed: 900, globalLimit: 9000, approxAnswersLeft: 0, resetAt: '2026-11-15T00:00:00Z', plan: 'free' }
    expect(quotaText(q)).toBe('Today’s free AI answers on your account are used up.')
    expect(quotaText({ ...q, plan: 'pro' })).toBe('Today’s AI answers on your account are used up.')
    expect(quotaText({ ...q, plan: undefined })).toBe('Today’s free AI answers on this computer are used up.')
    expect(quotaText({ ...q, installUsed: 0, approxAnswersLeft: 3, plan: 'pro' })).toBe('About 3 answers left today on your account.')
  })
})

describe('accessTokenFor (desktop and web)', () => {
  const client = (r: { data: { session: unknown }; error: unknown }, calls: string[] = []) =>
    ({
      auth: {
        getSession: async () => (calls.push('get'), r),
        refreshSession: async () => (calls.push('refresh'), r)
      }
    }) as unknown as SupabaseClient
  const session = (id: string) => ({ access_token: `at-${id}`, refresh_token: REFRESH_SECRET, user: { id } })

  it('returns only the access token, of the right account only', async () => {
    expect(await accessTokenFor(client({ data: { session: session(ALICE) }, error: null }), ALICE, false)).toBe(`at-${ALICE}`)
    expect(await accessTokenFor(client({ data: { session: session(BOB) }, error: null }), ALICE, false)).toBeNull()
    expect(await accessTokenFor(client({ data: { session: null }, error: null }), ALICE, false)).toBeNull()
  })

  it('refreshes only when asked', async () => {
    const calls: string[] = []
    await accessTokenFor(client({ data: { session: session(ALICE) }, error: null }, calls), ALICE, false)
    await accessTokenFor(client({ data: { session: session(ALICE) }, error: null }, calls), ALICE, true)
    expect(calls).toEqual(['get', 'refresh'])
  })

  it('a network failure is an error (offline), a refused refresh is “no session”', async () => {
    const { AuthRetryableFetchError, AuthApiError } = await import('@supabase/supabase-js')
    await expect(accessTokenFor(client({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }), ALICE, true)).rejects.toThrow(/sign-in server/)
    expect(await accessTokenFor(client({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') }), ALICE, true)).toBeNull()
  })
})
