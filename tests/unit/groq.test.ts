/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Groq's free plan (qwen/qwen3.8-27b) behind the AI server: a request body that
 * can only ask for the free model on the standard tier, quotas that can't be set
 * above Groq's documented free limits, account-wide REQUEST and TOKEN quotas
 * (worst case held before sending, Groq's reported count after) that hold under
 * concurrency and across the UTC day boundary, Groq's x_groq streaming usage,
 * and a stop when the account's limits show it is no longer on the free plan.
 * Against a local fake (tests/support/fakeOpenAi.mjs) and the ledger directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROQ_FREE_LIMITS, PRESETS, planUpgraded, toProviderBody } from '../../beta-server/src/provider'
import { inference, limits as limitsFromEnv, NOTICE_NOT_YET_SHIPPED, type Env } from '../../beta-server/src/config'
import { Ledger, type LedgerLimits } from '../../beta-server/src/ledger'
import { estimateInputTokens } from '../../beta-server/src/upstream'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { FAKE_KEY, startFakeOpenAi, type FakeOpenAi } from '../support/fakeOpenAi.mjs'

const INSTALL_A = 'inst_' + 'A'.repeat(32)
const chat = (text: string): Record<string, unknown> => ({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }] })
const SHADOW = { unit: 'usd' as const, inputPerM: 200_000, outputPerM: 2_500_000, ignoreReportedCost: true }
/** Groq's real free-plan headers for this model. */
const FREE_HEADERS = { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-requests': '999', 'x-ratelimit-remaining-tokens': '7000' }

let fake: FakeOpenAi | undefined
let server: BetaServer | undefined
afterEach(async () => {
  await server?.close()
  await fake?.close()
  server = undefined
  fake = undefined
  vi.restoreAllMocks()
})

async function start(opts: { limits?: Record<string, unknown>; fake?: Parameters<typeof startFakeOpenAi>[0]; inputMargin?: number } = {}): Promise<void> {
  fake = await startFakeOpenAi({ path: '/openai/v1', responseHeaders: FREE_HEADERS, groqUsage: true, ...(opts.fake ?? {}) })
  server = await startBetaServer({
    provider: 'groq',
    model: 'qwen/qwen3.8-27b',
    publicModel: 'qwen3.8-27b',
    minNoticeVersion: 0,
    freeProvider: true,
    tokenQuota: true,
    imageMinTokens: 2048,
    inputMargin: opts.inputMargin ?? 1.5,
    rates: SHADOW,
    globalDailyNeurons: 1_000_000,
    installDailyNeurons: 50_000,
    networkDailyNeurons: 150_000,
    typicalNeuronsPerAnswer: 800,
    installPerMinute: 100,
    networkPerMinute: 100,
    installConcurrent: 10,
    networkConcurrent: 20,
    globalConcurrent: 20,
    limits: { unit: 'usd', globalMonthly: 10_000_000, globalRequestsPerDay: 900, globalRequestsPerMinute: 25, globalTokensPerDay: 180_000, globalTokensPerMinute: 7000, ...(opts.limits ?? {}) },
    makeAi: (mod: any) => mod.provider.externalProvider({ id: 'groq', apiKey: FAKE_KEY, baseUrl: fake!.url, maxAttempts: 2, retryRateLimit: false, sleep: async () => undefined })
  })
}

let n = 0
const install = (): string => `inst_${String(++n).padStart(32, 'g')}`
async function post(body: unknown, who: string = INSTALL_A): Promise<{ status: number; events: Array<{ event: string; data: any }>; json?: any }> {
  const res = await fetch(`${server!.url}/v1/tutor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': who, 'x-inkling-notice': '4' }, body: JSON.stringify(body) })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events: [], json: await res.json().catch(() => null) }
  const text = await res.text()
  return { status: res.status, events: text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) })) }
}

describe('Groq free request body', () => {
  const inputs = { messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 900, temperature: 0.4, reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false }, stream: true }

  it('asks for qwen/qwen3.8-27b on the on-demand tier, max_completion_tokens, usage, and no reasoning when thinking is off', () => {
    const body = toProviderBody(PRESETS.groq, 'qwen/qwen3.8-27b', inputs)
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', max_completion_tokens: 900, temperature: 0.4, stream: true, stream_options: { include_usage: true }, service_tier: 'on_demand', reasoning_format: 'parsed' })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('chat_template_kwargs')
  })

  it('with thinking on, only an effort Groq lists for the model', () => {
    const on = { ...inputs, chat_template_kwargs: undefined }
    expect(toProviderBody(PRESETS.groq, 'qwen/qwen3.8-27b', on)).toMatchObject({ reasoning_effort: 'low' })
    expect(toProviderBody(PRESETS.groq, 'qwen/qwen3.8-27b', { ...on, reasoning_effort: 'xhigh' })).not.toHaveProperty('reasoning_effort')
  })

  it('operator extras can change neither the model, the tier, nor add tools', () => {
    const body = toProviderBody(PRESETS.groq, 'qwen/qwen3.8-27b', inputs, { model: 'openai/gpt-oss-120b', service_tier: 'flex', tools: [{ type: 'browser_search' }], reasoning_format: 'raw', seed: 1 })
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', service_tier: 'on_demand', reasoning_format: 'parsed', seed: 1 })
    expect(body).not.toHaveProperty('tools')
  })

  it('reads the account’s limit headers: the free plan’s are fine, anything higher is a paid plan', () => {
    expect(planUpgraded(PRESETS.groq, new Headers(FREE_HEADERS))).toBe(false)
    expect(planUpgraded(PRESETS.groq, new Headers({}))).toBe(false)
    expect(planUpgraded(PRESETS.groq, new Headers({ ...FREE_HEADERS, 'x-ratelimit-limit-requests': '500000' }))).toBe(true)
    expect(planUpgraded(PRESETS.groq, new Headers({ ...FREE_HEADERS, 'x-ratelimit-limit-tokens': '300000' }))).toBe(true)
  })

  it('counts each image as at least Groq’s 2,048 tokens', () => {
    const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const turns = [{ role: 'user' as const, parts: [{ image: { mimeType: 'image/png', data: tiny } }, { image: { mimeType: 'image/png', data: tiny } }] }]
    expect(estimateInputTokens('', turns as any, 28)).toBeLessThan(100)
    expect(estimateInputTokens('', turns as any, 28, 2048)).toBeGreaterThanOrEqual(4096)
  })
})

describe('Groq free plan through the AI server', () => {
  it('streams an answer; Groq’s x_groq usage replaces the held worst case in the token quota', async () => {
    await start()
    fake!.model.reply({ text: 'A derivative measures change.', usage: { inputTokens: 1200, outputTokens: 40 } })
    const r = await post(chat('what is a derivative'))
    expect(r.status).toBe(200)
    expect(r.events.map((e) => e.event)).toEqual(['delta', 'done'])
    expect(r.events.at(-1)!.data.usage).toMatchObject({ inputTokens: 1200, outputTokens: 40, estimated: false })
    await server!.settled()
    const s = (await server!.admin('GET', '/admin/summary')).body
    expect(s.providerRolling24h).toEqual({ requests: 1, tokens: 1240, requestLimit: 900, tokenLimit: 180_000 })
    expect(s.providerLastMinute).toMatchObject({ requests: 1, tokens: 1240, requestLimit: 25, tokenLimit: 7000 })
    const sent = fake!.completions()[0]!.body
    expect(sent).toMatchObject({ model: 'qwen/qwen3.8-27b', service_tier: 'on_demand', max_completion_tokens: 900 })
  })

  it('the per-minute TOKEN quota holds in a burst from many installations: the worst case is held while answers run', async () => {
    // A chat's worst case ≈ (system prompt + text) × 1.5 + 900 output; 7,000 a minute fits only a few at once.
    await start()
    fake!.model.reply({ chunks: ['a', 'b'], chunkDelayMs: 40 })
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => post(chat(`burst ${i}`), install())))
    const ok = all.filter((r) => r.status === 200)
    expect(ok.length).toBeGreaterThan(0)
    expect(ok.length).toBeLessThan(12)
    expect(all.filter((r) => r.status !== 200).every((r) => r.json.error.scope === 'capacity' && r.json.error.retryAfter >= 1)).toBe(true)
    expect(fake!.completions()).toHaveLength(ok.length)
    await server!.settled()
    const m = (await server!.admin('GET', '/admin/summary')).body.providerLastMinute
    expect(m.tokens).toBeLessThanOrEqual(7000)
  })

  it('stops everyone at the daily token quota before calling Groq, and says so with an honest wait', async () => {
    await start({ limits: { globalTokensPerDay: 5000 } })
    // Groq reports more than the worst case left room for: 4,100 of 5,000 used.
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 4000, outputTokens: 100 } })
    expect((await post(chat('one'), install())).status).toBe(200)
    await server!.settled()
    const r = await post(chat('two'), install())
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'server', scope: 'free_token_quota' })
    expect(r.json.error.retryAfter).toBeGreaterThanOrEqual(60)
    expect(fake!.completions()).toHaveLength(1)
    // 25 hours later the rolling window has emptied.
    server!.clock.offset += 25 * 3_600_000 + 60_000
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 2000, outputTokens: 100 } })
    expect((await post(chat('three'), install())).status).toBe(200)
  })

  it('a request whose worst case exceeds the per-minute token quota is refused as too large (Groq would 413 it)', async () => {
    await start({ limits: { globalTokensPerMinute: 1500 } })
    const r = await post(chat('x'.repeat(3000)))
    expect(r.status).toBe(413)
    expect(r.json.error.scope).toBe('too_large')
    expect(fake!.completions()).toHaveLength(0)
  })

  it('the daily request quota holds over any 24 hours, not only the UTC day', async () => {
    await start({ limits: { globalRequestsPerDay: 2 } })
    // Two requests just before UTC midnight…
    const now = Date.now()
    const nextMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1)
    server!.clock.offset = nextMidnight - now - 60_000
    expect((await post(chat('a'), install())).status).toBe(200)
    expect((await post(chat('b'), install())).status).toBe(200)
    await server!.settled()
    // …and two minutes later (a new UTC day) the rolling count still says no.
    server!.clock.offset += 2 * 60_000
    const r = await post(chat('c'), install())
    expect(r.json.error.scope).toBe('free_daily_quota')
    expect(fake!.completions()).toHaveLength(2)
  })

  it('Groq’s daily token limit hit anyway (a long retry-after) stops everyone until then, without calling again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await start()
    fake!.fail({ status: 429, headers: { 'retry-after': '3600', ...FREE_HEADERS }, body: { error: { message: 'Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD)', type: 'tokens', code: 'rate_limit_exceeded' } } })
    const r = await post(chat('hi'))
    expect(r.json.error.scope).toBe('upstream_unavailable')
    expect((await post(chat('again'), install())).json.error.scope).toBe('upstream_unavailable')
    expect(fake!.completions()).toHaveLength(1)
  })

  it('a short 429 (per-minute) is not retried and does not close the service', async () => {
    await start()
    fake!.fail({ status: 429, headers: { 'retry-after': '7', ...FREE_HEADERS }, body: { error: { message: 'Rate limit reached on tokens per minute (TPM)', code: 'rate_limit_exceeded' } } })
    expect((await post(chat('hi'))).json.error.code).toBe('rate_limited')
    expect(fake!.completions()).toHaveLength(1)
    expect((await post(chat('later'), install())).status).toBe(200)
  })

  it('an account no longer on the free plan (higher limits in Groq’s headers) pauses every answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await start({ fake: { path: '/openai/v1', groqUsage: true, responseHeaders: { ...FREE_HEADERS, 'x-ratelimit-limit-requests': '250000' } } })
    const r = await post(chat('hi'))
    expect(r.json.error).toMatchObject({ code: 'beta_closed', scope: 'paused' })
    expect(JSON.stringify(error.mock.calls)).toMatch(/not on the free plan/)
    expect((await post(chat('again'), install())).json.error.scope).toBe('paused')
    expect(fake!.completions()).toHaveLength(1)
    // Its request reached the model: its held tokens stay counted.
    expect((await server!.admin('GET', '/admin/summary')).body.providerRolling24h.tokens).toBeGreaterThan(900)
  })

  it('provider downtime: two attempts at most, both counted as requests', async () => {
    await start()
    for (let i = 0; i < 3; i++) fake!.fail({ status: 503 })
    expect((await post(chat('hi'))).status).toBe(503)
    expect(fake!.completions()).toHaveLength(2)
    await server!.settled()
    expect((await server!.admin('GET', '/admin/summary')).body.providerRolling24h.requests).toBe(2)
  })
})

describe('Ledger token quota under concurrency', () => {
  const base: LedgerLimits = {
    unit: 'usd',
    globalDailyNeurons: 1e9,
    installDailyNeurons: 1e9,
    networkDailyNeurons: 1e9,
    installPerMinute: 1000,
    networkPerMinute: 1000,
    installConcurrent: 1000,
    networkConcurrent: 1000,
    globalConcurrent: 1000,
    reservationTtlMs: 600_000,
    typicalNeuronsPerAnswer: 1,
    globalRequestsPerDay: 1000,
    globalRequestsPerMinute: 30,
    globalTokensPerDay: 200_000,
    globalTokensPerMinute: 8000
  }
  const mem = (): any => {
    const m = new Map<string, unknown>()
    return { get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)), delete: async (k: string) => void m.delete(k), list: async (p: string) => [...m.keys()].filter((k) => k.startsWith(p)) }
  }

  it('100 simultaneous reservations of 1,500 tokens: exactly 5 fit in 8,000 a minute', async () => {
    const t = 1_800_000_000_000
    const ledger = new Ledger(mem(), base, () => t)
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => ledger.reserve({ install: `inst_${i}`, network: `10.0.0.${i}` }, 1, 1, undefined, 1500)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
  })

  it('30 a minute and 1,000 a day hold for tiny requests; settled counts replace the worst case', async () => {
    let t = 1_800_000_000_000
    const ledger = new Ledger(mem(), base, () => t)
    const ok: string[] = []
    for (let minute = 0; minute < 40; minute++) {
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => ledger.reserve({ install: `i${minute}_${i}`, network: `n${i}` }, 1, 1, undefined, 100)))
      const accepted = rs.filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      expect(accepted.length).toBeLessThanOrEqual(30)
      for (const r of accepted) {
        ok.push(r.reservationId)
        await ledger.settle(r.reservationId, 1, { tokens: 50 })
      }
      t += 61_000
    }
    expect(ok).toHaveLength(1000)
    const s = await ledger.summary()
    expect(s.providerRolling24h).toMatchObject({ requests: 1000, tokens: 50_000 })
  })

  it('a reservation never settled stays counted at its worst case when it expires', async () => {
    let t = 1_800_000_000_000
    const ledger = new Ledger(mem(), base, () => t)
    const r = await ledger.reserve({ install: 'a', network: 'n' }, 1, 1, undefined, 3000)
    expect(r.ok).toBe(true)
    t += 11 * 60_000
    const s = await ledger.summary()
    expect(s.providerRolling24h).toMatchObject({ requests: 1, tokens: 3000 })
  })

  it('without a token count the reservation is refused (fail closed)', async () => {
    const ledger = new Ledger(mem(), base, () => 1_800_000_000_000)
    const r = await ledger.reserve({ install: 'a', network: 'n' }, 1, 1)
    expect(r).toMatchObject({ ok: false, code: 'too_large' })
  })
})

describe('Groq free configuration', () => {
  const env = (extra: Partial<Env> = {}): Env =>
    ({
      MODEL: '@cf/qwen/qwen3.8-27b',
      ACCOUNT_PLAN: 'free',
      INPUT_NEURONS_PER_M: '40909',
      OUTPUT_NEURONS_PER_M: '290909',
      INFERENCE_PROVIDER: 'groq',
      INFERENCE_API_KEY: 'gsk_' + 'k'.repeat(48),
      GLOBAL_DAILY_USD: '1',
      GLOBAL_MONTHLY_USD: '30',
      GLOBAL_REQUESTS_PER_DAY: '900',
      GLOBAL_REQUESTS_PER_MINUTE: '25',
      GLOBAL_TOKENS_PER_DAY: '180000',
      GLOBAL_TOKENS_PER_MINUTE: '7000',
      ...extra
    }) as Env

  it('defaults: the free model, token quota, 2,048 tokens an image, one retry, closed until a notice names Groq', () => {
    const inf = inference(env())
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf).toMatchObject({ provider: 'groq', model: 'qwen/qwen3.8-27b', freeProvider: true, tokenQuota: true, imageMinTokens: 2048, minNotice: NOTICE_NOT_YET_SHIPPED, publicModel: 'qwen3.8-27b' })
    expect(limitsFromEnv(env())).toMatchObject({ globalRequestsPerDay: 900, globalRequestsPerMinute: 25, globalTokensPerDay: 180_000, globalTokensPerMinute: 7000 })
  })

  it('refuses to start above Groq’s documented free limits', () => {
    expect(GROQ_FREE_LIMITS).toEqual({ requestsPerDay: 1000, requestsPerMinute: 30, tokensPerDay: 200_000, tokensPerMinute: 8000 })
    expect(inference(env({ GLOBAL_REQUESTS_PER_DAY: '1001' }))).toMatch(/at most 1000/)
    expect(inference(env({ GLOBAL_REQUESTS_PER_MINUTE: '31' }))).toMatch(/at most 30/)
    expect(inference(env({ GLOBAL_TOKENS_PER_DAY: '200001' }))).toMatch(/at most 200000/)
    expect(inference(env({ GLOBAL_TOKENS_PER_MINUTE: '9000' }))).toMatch(/at most 8000/)
  })

  it('fails closed without the token quota, on another model, or with another base URL', () => {
    expect(inference(env({ GLOBAL_TOKENS_PER_DAY: undefined }))).toMatch(/GLOBAL_TOKENS_PER_DAY/)
    expect(inference(env({ GLOBAL_TOKENS_PER_MINUTE: '' }))).toMatch(/GLOBAL_TOKENS_PER_MINUTE/)
    expect(inference(env({ UPSTREAM_MODEL: 'openai/gpt-oss-120b' }))).toMatch(/qwen\/qwen3\.8-27b/)
    expect(inference(env({ UPSTREAM_BASE_URL: 'https://example.com/v1' }))).toMatch(/can’t be changed|can't be changed/)
    expect(inference(env({ INFERENCE_API_KEY: '' }))).toMatch(/INFERENCE_API_KEY/)
    expect(inference(env({ GLOBAL_REQUESTS_PER_DAY: undefined }))).toMatch(/GLOBAL_REQUESTS_PER_DAY/)
  })

  it('Workers AI stays the default: no provider set means no Groq', () => {
    const inf = inference(env({ INFERENCE_PROVIDER: undefined }))
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf.provider).toBe('workers-ai')
  })
})
