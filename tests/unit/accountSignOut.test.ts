/**
 * The desktop account (src/main/account.ts) with a real Supabase client against the fake
 * Supabase: a session that ends without the app signing out (another device's "sign out
 * everywhere", a revoked refresh token) stops the AI using the account at once, clears the
 * account's AI state, and keeps the notebooks and unsynced changes on the computer.
 * The web app's handler (src/web/account.ts) is covered by tests/e2e/web.e2e.mjs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeSupabase, type FakeSupabase } from '../support/fakeSupabase.mjs'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { Account } from '../../src/main/account'
import { Storage } from '../../src/main/storage'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OllamaProvider } from '../../src/main/ai/ollama'
import type { SupabaseClient } from '../../src/shared/sync/supabase'
import type { AiEvent } from '../../src/shared/ai'

const cipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(s),
  decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false })
}
// No keychain: the session is kept in memory only (as on a computer without one).
const noKeychain = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

describe('desktop: a session ended elsewhere', () => {
  let supabase: FakeSupabase
  let beta: BetaServer
  afterEach(async () => {
    await beta?.close()
    await supabase?.close()
  })

  it('stops the AI using the account at once, and keeps the notebooks', async () => {
    supabase = await startFakeSupabase()
    const email = 'student@example.com'
    // The AI server accepts any token from this Supabase as that student's Pro account.
    beta = await startBetaServer({ accounts: async (t: string) => (t.split('.').length === 3 ? { userId: supabase.uidOf(email), plan: 'pro' as const } : 'invalid'), limits: { pro: { daily: 2700 } } })
    const root = await mkdtemp(join(tmpdir(), 'inkling-signout-'))
    const dataDir = join(root, 'notebooks')
    await mkdir(dataDir, { recursive: true })

    let ai: AiService | null = null
    const account = new Account({
      config: { url: supabase.url, anonKey: supabase.anonKey },
      storage: new Storage(dataDir),
      dataDir,
      dir: join(root, 'sync'),
      cipher: noKeychain,
      openExternal: async () => undefined,
      flush: async () => ({ ok: true }),
      // As in src/main/index.ts: every account change reaches the AI.
      onState: () => ai?.accountChanged(),
      onDocsChanged: () => undefined
    })
    await account.start()
    const config = new AiConfig(join(root, 'config'), cipher, { builtInCloudUrl: beta.url, defaultProvider: 'cloud' })
    await config.load()
    await config.setCloudConsent(true)
    const events: AiEvent[] = []
    ai = new AiService({
      config,
      account: account.ai,
      makeProvider: (k) => new GeminiProvider({ apiKey: k, baseUrl: 'http://127.0.0.1:9' }),
      makeLocalProvider: () => new OllamaProvider({ baseUrl: 'http://127.0.0.1:9' }),
      emit: (e) => events.push(e),
      limits: { duplicateWindowMs: 0, minIntervalMs: 0 }
    })

    expect(await account.verifyEmailCode(email, '123456')).toEqual({ ok: true })
    expect(account.ai.userId()).toBe(supabase.uidOf(email))
    await ai.freshStatus()
    expect(ai.status().cloud.quota?.plan).toBe('pro')
    expect(beta.requests.at(-1)!.headers.authorization).toMatch(/^Bearer /)
    // A local change the account doesn't have yet.
    const unsynced = join(dataDir, 'unsynced-note.json')
    await writeFile(unsynced, '{"kept":true}')

    // The session ends without Account.signOut(): Supabase reports SIGNED_OUT on its own.
    await (account as unknown as { client: SupabaseClient }).client.auth.signOut({ scope: 'local' })

    expect(account.ai.userId()).toBeNull()
    expect(ai.status().cloud.quota).toBeNull()
    expect(account.state().sync.message).toMatch(/You were signed out/)
    // Still shown as this account (so the user knows whom to sign in as); the notebooks stay.
    expect(account.state().user?.email).toBe(email)
    expect(await readFile(unsynced, 'utf8')).toBe('{"kept":true}')
    // The next question is anonymous, with this computer's allowance: no token, no account plan.
    const r = ai.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    if ('error' in r) throw new Error(r.error.message)
    for (;;) {
      const e = events.find((x) => x.requestId === r.requestId && x.type !== 'delta')
      if (e) {
        expect(e.type).toBe('done')
        break
      }
      await new Promise((res) => setTimeout(res, 10))
    }
    const asked = beta.requests.filter((q) => q.path === '/v1/tutor').at(-1)!
    expect(asked.headers.authorization).toBeUndefined()
    expect(ai.status().cloud.quota?.plan).toBeUndefined()

    // Signing in again uses the account once more.
    expect(await account.verifyEmailCode(email, '123456')).toEqual({ ok: true })
    expect(account.ai.userId()).toBe(supabase.uidOf(email))
  })
})
