/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OpenRouter Free (qwen/qwen3.8-27b:free) behind the AI server: a request body
 * that can never reach a paid endpoint, the account-wide daily and per-minute
 * request quota, a used-up quota stopping everyone until it resets, no retries
 * that spend quota, a reported charge pausing the service, and shadow-priced
 * allowances. Against a local fake (tests/support/fakeOpenAi.mjs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESETS, resetSeconds, toProviderBody } from '../../beta-server/src/provider'
import { inference, limits as limitsFromEnv, NOTICE_NOT_YET_SHIPPED, type Env } from '../../beta-server/src/config'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { FAKE_KEY, startFakeOpenAi, type FakeOpenAi } from '../support/fakeOpenAi.mjs'

const INSTALL_A = 'inst_' + 'A'.repeat(32)
const INSTALL_B = 'inst_' + 'B'.repeat(32)
const chat = (text: string): Record<string, unknown> => ({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }] })
const SHADOW = { unit: 'usd' as const, inputPerM: 200_000, outputPerM: 2_500_000, ignoreReportedCost: true }

let fake: FakeOpenAi | undefined
let server: BetaServer | undefined
afterEach(async () => {
  await server?.close()
  await fake?.close()
  server = undefined
  fake = undefined
  vi.restoreAllMocks()
})

async function start(opts: { limits?: Record<string, unknown>; fake?: Parameters<typeof startFakeOpenAi>[0]; adapter?: Record<string, unknown> } = {}): Promise<void> {
  fake = await startFakeOpenAi({ path: '/api/v1', ...(opts.fake ?? {}) })
  server = await startBetaServer({
    provider: 'openrouter-free',
    model: 'qwen/qwen3.8-27b:free',
    publicModel: 'qwen3.8-27b',
    minNoticeVersion: 0,
    freeProvider: true,
    rates: SHADOW,
    globalDailyNeurons: 1_000_000,
    installDailyNeurons: 20_000,
    networkDailyNeurons: 60_000,
    typicalNeuronsPerAnswer: 800,
    installPerMinute: 100,
    networkPerMinute: 100,
    installConcurrent: 10,
    networkConcurrent: 10,
    limits: { unit: 'usd', globalMonthly: 10_000_000, globalRequestsPerDay: 950, globalRequestsPerMinute: 18, ...(opts.limits ?? {}) },
    makeAi: (mod: any) => mod.provider.externalProvider({ id: 'openrouter-free', apiKey: FAKE_KEY, baseUrl: fake!.url, maxAttempts: 2, retryRateLimit: false, sleep: async () => undefined, ...(opts.adapter ?? {}) })
  })
}

let n = 0
const install = (): string => `inst_${String(++n).padStart(32, 'x')}`
async function post(body: unknown, who: string = INSTALL_A): Promise<{ status: number; events: Array<{ event: string; data: any }>; json?: any }> {
  const res = await fetch(`${server!.url}/v1/tutor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': who, 'x-inkling-notice': '4' }, body: JSON.stringify(body) })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events: [], json: await res.json().catch(() => null) }
  const text = await res.text()
  return { status: res.status, events: text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) })) }
}

describe('OpenRouter Free request body', () => {
  it('asks for the :free variant with no fallback, a zero price ceiling and no data collection', () => {
    const body = toProviderBody(PRESETS['openrouter-free'], 'qwen/qwen3.8-27b:free', { messages: [], max_completion_tokens: 900, chat_template_kwargs: { enable_thinking: false }, stream: true })
    expect(body).toMatchObject({
      model: 'qwen/qwen3.8-27b:free',
      max_tokens: 900,
      stream: true,
      reasoning: { enabled: false },
      provider: { allow_fallbacks: false, data_collection: 'deny', max_price: { prompt: 0, completion: 0, request: 0, image: 0 } }
    })
    expect(body).not.toHaveProperty('models')
  })

  it('operator settings can loosen none of data collection, the price ceiling, fallbacks or the model', () => {
    const body = toProviderBody(PRESETS['openrouter-free'], 'qwen/qwen3.8-27b:free', { messages: [] }, {
      provider: { data_collection: 'allow', allow_fallbacks: true, max_price: { prompt: 5, completion: 5 } },
      models: ['qwen/qwen3.8-27b'],
      route: 'fallback',
      model: 'qwen/qwen3.8-27b'
    })
    expect(body.model).toBe('qwen/qwen3.8-27b:free')
    expect(body).not.toHaveProperty('models')
    expect(body).not.toHaveProperty('route')
    expect(body.provider).toEqual({ data_collection: 'deny', allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } })
  })

  it('reads OpenRouter’s X-RateLimit-Reset in milliseconds or seconds', () => {
    const now = 1_800_000_000_000
    expect(resetSeconds(String(now + 30_000), now)).toBe(30)
    expect(resetSeconds(String(now / 1000 + 60), now)).toBe(60)
    expect(resetSeconds(null, now)).toBeUndefined()
  })
})

describe('OpenRouter Free on the AI server', () => {
  it('answers for free; allowances still count a shadow price, whatever cost the provider reports', async () => {
    await start({ fake: { path: '/api/v1', reportCost: () => 0 } })
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 1000, outputTokens: 100 } })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)).toMatchObject({ event: 'done', data: { neurons: 1000 * 0.2 + 100 * 2.5 } })
    const req = fake!.completions()[0]!
    expect(req.body.model).toBe('qwen/qwen3.8-27b:free')
    expect(req.body.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 })
    expect((await server!.admin('GET', '/admin/summary')).body).toMatchObject({ upstreamRequests: 1, upstreamRequestLimit: 950, paused: false })
  })

  it('stops everyone at the account-wide daily request quota, before calling OpenRouter', async () => {
    await start({ limits: { globalRequestsPerDay: 3 } })
    for (let i = 0; i < 3; i++) expect((await post(chat(`q${i}`), install())).status).toBe(200)
    await server!.settled()
    const r = await post(chat('one more'), install())
    expect(r.status).toBe(429)
    expect(r.json.error).toMatchObject({ code: 'daily_quota', scope: 'free_daily_quota' })
    expect(r.json.error.message).toMatch(/as many questions as it can today, for everyone/)
    expect(fake!.completions()).toHaveLength(3)
  })

  it('a retried attempt counts against the daily quota too', async () => {
    await start({ limits: { globalRequestsPerDay: 2 } })
    fake!.fail({ status: 502 })
    expect((await post(chat('first'), install())).events.at(-1)!.event).toBe('done')
    await server!.settled()
    expect(fake!.completions()).toHaveLength(2)
    expect((await post(chat('second'), install())).json.error.scope).toBe('free_daily_quota')
  })

  it('never more than the per-minute quota at once, even in a burst from many installations', async () => {
    await start({ limits: { globalRequestsPerMinute: 4 } })
    fake!.model.reply({ chunks: ['a', 'b'], chunkDelayMs: 30 })
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => post(chat(`burst ${i}`), install())))
    expect(all.filter((r) => r.status === 200)).toHaveLength(4)
    expect(all.filter((r) => r.status === 503).every((r) => r.json.error.code === 'server' && r.json.error.scope === 'capacity')).toBe(true)
    expect(fake!.completions()).toHaveLength(4)
  })

  it('a 429 is never retried (each attempt spends quota) and is passed on as a short pause', async () => {
    await start()
    fake!.fail({ status: 429, headers: { 'retry-after': '20' }, body: { error: { message: 'Rate limit exceeded: free-models-per-min' } } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(429)
    expect(r.json.error.code).toBe('rate_limited')
    expect(fake!.completions()).toHaveLength(1)
    // A short limit doesn't close the service.
    expect((await post(chat('later'), INSTALL_B)).status).toBe(200)
  })

  it('OpenRouter’s daily quota used up (a long reset) stops everyone until the reset, without calling it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await start()
    const reset = Date.now() + 5 * 3_600_000
    fake!.fail({ status: 429, headers: { 'x-ratelimit-reset': String(reset) }, body: { error: { message: 'Rate limit exceeded: free-models-per-day' } } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'server', scope: 'upstream_unavailable' })
    expect(r.json.error.message).toMatch(/limit for today/)
    expect(r.json.error.retryAfter).toBeGreaterThan(4 * 3600)
    const other = await post(chat('hello'), INSTALL_B)
    expect(other.json.error.scope).toBe('upstream_unavailable')
    expect(fake!.completions()).toHaveLength(1)
    expect(JSON.stringify(warn.mock.calls)).toMatch(/quota used up/)
    // Once the reset passes, answers resume.
    server!.clock.offset += 5 * 3_600_000 + 60_000
    expect((await post(chat('after reset'), install())).status).toBe(200)
  })

  it('an unavailable free endpoint (none matches the data policy, or removed) says so without retrying', async () => {
    await start()
    fake!.fail({ status: 404, body: { error: { message: 'No endpoints found matching your data policy (Free model training)' } } })
    const r = await post(chat('hi'))
    expect(r.json.error.code).toBe('model_unavailable')
    expect(fake!.completions()).toHaveLength(1)
  })

  it('the free variant withdrawn (OpenRouter’s real 404) is "model unavailable"; the suggested paid slug is never tried', async () => {
    await start()
    fake!.fail({ status: 404, body: { error: { message: 'This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen3.8-27b', code: 404 } } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('model_unavailable')
    expect(fake!.completions().map((c) => c.body.model)).toEqual(['qwen/qwen3.8-27b:free'])
  })

  it('provider downtime: two attempts at most, then a calm error, nothing charged', async () => {
    await start()
    for (let i = 0; i < 4; i++) fake!.fail({ status: 503 })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(fake!.completions()).toHaveLength(2)
  })

  it('a reported charge on the free endpoint pauses every answer: never paying by accident', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await start({ fake: { path: '/api/v1', reportCost: () => 0.0004 } })
    expect((await post(chat('hi'))).status).toBe(200)
    await server!.settled()
    expect(JSON.stringify(error.mock.calls)).toMatch(/reported a charge on a free endpoint/)
    const next = await post(chat('again'), INSTALL_B)
    expect(next.json.error).toMatchObject({ code: 'beta_closed', scope: 'paused' })
    expect(fake!.completions()).toHaveLength(1)
  })
})

describe('OpenRouter Free configuration', () => {
  const env = (extra: Partial<Env> = {}): Env =>
    ({
      MODEL: '@cf/qwen/qwen3.8-27b',
      ACCOUNT_PLAN: 'free',
      INPUT_NEURONS_PER_M: '40909',
      OUTPUT_NEURONS_PER_M: '290909',
      INFERENCE_PROVIDER: 'openrouter-free',
      INFERENCE_API_KEY: 'k'.repeat(40),
      GLOBAL_DAILY_USD: '1',
      GLOBAL_MONTHLY_USD: '20',
      GLOBAL_REQUESTS_PER_DAY: '950',
      GLOBAL_REQUESTS_PER_MINUTE: '18',
      ...extra
    }) as Env

  it('defaults: the :free model, shadow prices, quotas, one retry, never retry a 429, closed until a notice names it', () => {
    const inf = inference(env())
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf).toMatchObject({ provider: 'openrouter-free', model: 'qwen/qwen3.8-27b:free', freeProvider: true, minNotice: NOTICE_NOT_YET_SHIPPED, rates: { unit: 'usd', inputPerM: 200_000, outputPerM: 2_500_000, ignoreReportedCost: true } })
    expect(limitsFromEnv(env())).toMatchObject({ globalRequestsPerDay: 950, globalRequestsPerMinute: 18 })
  })

  it('fails closed on a paid model, or without the account-wide request quota', () => {
    expect(inference(env({ UPSTREAM_MODEL: 'qwen/qwen3.8-27b' }))).toMatch(/:free/)
    expect(inference(env({ GLOBAL_REQUESTS_PER_DAY: undefined }))).toMatch(/GLOBAL_REQUESTS_PER_DAY/)
    expect(inference(env({ GLOBAL_REQUESTS_PER_MINUTE: '' }))).toMatch(/GLOBAL_REQUESTS_PER_MINUTE/)
    expect(inference(env({ INFERENCE_API_KEY: '' }))).toMatch(/INFERENCE_API_KEY/)
  })
})
