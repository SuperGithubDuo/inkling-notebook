/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The AI server with an external inference provider (DeepInfra / OpenRouter,
 * OpenAI-compatible): the provider adapter (request shape, retries, timeouts,
 * errors), dollar accounting, spending caps, budget protection, duplicate
 * requests, the data-notice gate, configuration that fails closed, and the
 * app against it. The provider is a local fake (tests/support/fakeOpenAi.mjs);
 * nothing here reaches the internet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { costFor, estimateInputTokens, inputUpperBound, parseUpstream, reportedCost } from '../../beta-server/src/upstream'
import { PRESETS, externalProvider, guardStream, kindOfStatus, retryAfterSeconds, toProviderBody, UpstreamError } from '../../beta-server/src/provider'
import { inference, limits as limitsFromEnv, NOTICE_NOT_YET_SHIPPED, providerOf, type Env } from '../../beta-server/src/config'
import { Ledger, type LedgerLimits } from '../../beta-server/src/ledger'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { FAKE_KEY, startFakeOpenAi, type FakeOpenAi } from '../support/fakeOpenAi.mjs'
import { CloudProvider } from '../../src/main/ai/cloud'
import { CLOUD_CONSENT_VERSION, CLOUD_MODEL_PUBLIC } from '../../src/shared/ai'

const INSTALL_A = 'inst_' + 'A'.repeat(32)
const INSTALL_B = 'inst_' + 'B'.repeat(32)
const chat = (text: string): Record<string, unknown> => ({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }] })

/** DeepInfra's list price for Qwen 3.8 27B in µ$ per million tokens ($0.20 / $2.50 / $0.05 cached). */
const USD_RATES = { unit: 'usd' as const, inputPerM: 200_000, outputPerM: 2_500_000, cachedInputPerM: 50_000 }
/** Dollar limits in µ$: $1/day, $10/month for everyone; $0.02/day per installation. */
const USD_LIMITS = { unit: 'usd', globalMonthly: 10_000_000 }

const noSleep = { sleeps: [] as number[] }
const instantSleep = async (ms: number): Promise<void> => void noSleep.sleeps.push(ms)

let fake: FakeOpenAi | undefined
let server: BetaServer | undefined
afterEach(async () => {
  await server?.close()
  await fake?.close()
  server = undefined
  fake = undefined
  noSleep.sleeps.length = 0
  vi.restoreAllMocks()
})

async function start(opts: { provider?: 'deepinfra' | 'openrouter'; limits?: Record<string, unknown>; server?: Record<string, unknown>; fake?: Parameters<typeof startFakeOpenAi>[0]; adapter?: Record<string, unknown> } = {}): Promise<{ fake: FakeOpenAi; server: BetaServer }> {
  fake = await startFakeOpenAi(opts.fake)
  const provider = opts.provider ?? 'deepinfra'
  server = await startBetaServer({
    provider,
    model: PRESETS[provider].model,
    publicModel: CLOUD_MODEL_PUBLIC,
    minNoticeVersion: 4,
    rates: { ...USD_RATES, costMultiplier: PRESETS[provider].costMultiplier },
    globalDailyNeurons: 1_000_000,
    installDailyNeurons: 20_000,
    networkDailyNeurons: 60_000,
    typicalNeuronsPerAnswer: 800,
    limits: { ...USD_LIMITS, ...(opts.limits ?? {}) },
    makeAi: (mod: any) => mod.provider.externalProvider({ id: provider, apiKey: FAKE_KEY, baseUrl: fake!.url, sleep: instantSleep, random: () => 0.5, ...(opts.adapter ?? {}) }),
    ...(opts.server ?? {})
  })
  return { fake, server }
}

async function post(body: unknown, who: { install?: string; notice?: string | null; ip?: string } = {}): Promise<{ status: number; events: Array<{ event: string; data: any }>; json?: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-inkling-install': who.install ?? INSTALL_A }
  if (who.notice !== null) headers['x-inkling-notice'] = who.notice ?? '4'
  if (who.ip) headers['x-test-ip'] = who.ip
  const res = await fetch(`${server!.url}/v1/tutor`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events: [], json: await res.json().catch(() => null) }
  const text = await res.text()
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }))
  return { status: res.status, events }
}
const status = async (install = INSTALL_A): Promise<any> => (await fetch(`${server!.url}/v1/status`, { headers: { 'x-inkling-install': install } })).json()

// ------------------------------------------------------------------ adapter

describe('provider adapter', () => {
  it('asks DeepInfra for Qwen 3.8 27B with thinking off, a token cap and usage in the stream', () => {
    const body = toProviderBody(PRESETS.deepinfra, 'Qwen/Qwen3.8-27B', {
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 900,
      temperature: 0.4,
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: false },
      stream: true
    })
    expect(body).toEqual({
      model: 'Qwen/Qwen3.8-27B',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      temperature: 0.4,
      chat_template_kwargs: { enable_thinking: false },
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('pins OpenRouter to DeepInfra with no fallback, no data collection and zero retention', () => {
    const body = toProviderBody(PRESETS.openrouter, 'qwen/qwen3.8-27b', { messages: [], max_completion_tokens: 500, chat_template_kwargs: { enable_thinking: false }, stream: true })
    expect(body.provider).toEqual({ order: ['deepinfra'], allow_fallbacks: false, data_collection: 'deny', zdr: true })
    expect(body.reasoning).toEqual({ enabled: false })
    expect(body).not.toHaveProperty('chat_template_kwargs')
    expect(body).not.toHaveProperty('stream_options')
    expect(PRESETS.openrouter.costMultiplier).toBeCloseTo(1.055)
  })

  it('sorts HTTP failures into kinds and reads Retry-After', () => {
    expect(kindOfStatus(401, '')).toBe('auth')
    expect(kindOfStatus(403, '')).toBe('auth')
    expect(kindOfStatus(402, '')).toBe('credits')
    expect(kindOfStatus(429, '{"error":"insufficient balance"}')).toBe('credits')
    expect(kindOfStatus(429, 'slow down')).toBe('rate_limited')
    expect(kindOfStatus(404, '')).toBe('model_unavailable')
    expect(kindOfStatus(400, 'model Qwen/X does not exist')).toBe('model_unavailable')
    expect(kindOfStatus(400, 'bad')).toBe('bad_request')
    expect(kindOfStatus(503, '')).toBe('capacity')
    expect(kindOfStatus(504, '')).toBe('timeout')
    expect(retryAfterSeconds('3')).toBe(3)
    expect(retryAfterSeconds(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3)
    expect(retryAfterSeconds(null)).toBeUndefined()
    expect(retryAfterSeconds('soon')).toBeUndefined()
  })

  it('refuses a plain-http provider address (except this computer, for tests)', () => {
    expect(() => externalProvider({ id: 'deepinfra', apiKey: 'k', baseUrl: 'http://api.example.com/v1' })).toThrow(/https/)
    expect(() => externalProvider({ id: 'deepinfra', apiKey: 'k', baseUrl: 'https://api.deepinfra.com/v1/openai' })).not.toThrow()
  })

  it('reads cached tokens and a reported cost; the higher of list price and the reported cost is charged', () => {
    const ev = parseUpstream({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.00031 } })
    expect(ev.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, reportedCostUsd: 0.00031 })
    // List price here is 80 + 30 + 500 = 610 µ$; a lower reported (promotional) 310 µ$ doesn't lower the charge.
    expect(costFor(ev.usage!, { ...USD_RATES, costMultiplier: 1.055 })).toBeCloseTo(610 * 1.055)
    expect(reportedCost(ev.usage!, { ...USD_RATES, costMultiplier: 1.055 })).toBeCloseTo(310 * 1.055)
    // A reported cost above list price (a price rise) is charged in full.
    expect(costFor({ ...ev.usage!, reportedCostUsd: 0.001 }, USD_RATES)).toBeCloseTo(1000)
    // DeepInfra's own field name.
    expect(parseUpstream({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, estimated_cost: 0.0000043 } }).usage?.reportedCostUsd).toBe(0.0000043)
    // No reported cost (DeepInfra): its token counts at list price, cached input at the cached rate.
    const { reportedCostUsd: _, ...tokensOnly } = ev.usage!
    expect(costFor(tokensOnly, USD_RATES)).toBeCloseTo(400 * 0.2 + 600 * 0.05 + 200 * 2.5)
    // Neurons ignore a dollar figure.
    expect(costFor(ev.usage!, { inputPerM: 40909, outputPerM: 290909 })).toBeCloseTo((1000 * 40909 + 200 * 290909) / 1e6)
    // Nonsense usage is ignored rather than trusted.
    expect(parseUpstream({ choices: [{ delta: {} }], usage: { prompt_tokens: -5, completion_tokens: 'x' } }).usage).toBeUndefined()
  })

  it('recognises errors reported inside a 200 response or a stream', () => {
    expect(parseUpstream({ error: { message: 'x', code: 502 } }).error).toBe(true)
    expect(parseUpstream({ choices: [{ delta: { content: '' }, finish_reason: 'error' }] }).error).toBe(true)
  })

  it('an idle stream ends with a timeout, and cancelling it cancels the provider', async () => {
    let cancelled = false
    const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => void (cancelled = true) })
    const reader = guardStream(silent, 30, 10_000).getReader()
    await expect(reader.read()).rejects.toBeInstanceOf(UpstreamError)
    const again = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => void (cancelled = true) })
    const r2 = guardStream(again, 10_000, 10_000).getReader()
    void r2.read().catch(() => undefined)
    await r2.cancel()
    expect(cancelled).toBe(true)
  })
})

// ------------------------------------------------------------------ server + provider

describe('AI server on an external provider', () => {
  it('streams an anonymous answer through the provider; the key goes only to the provider', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await start()
    fake!.model.reply({ chunks: ['The roots ', 'are $-2$ and $-3$.'], usage: { inputTokens: 1000, outputTokens: 120 } })
    const r = await post(chat('My private question about x^2+5x+6'))
    expect(r.status).toBe(200)
    expect(r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toBe('The roots are $-2$ and $-3$.')
    const done = r.events.at(-1)!
    expect(done.event).toBe('done')
    // Real tokens × list price, in µ$: 1000 × 0.20 + 120 × 2.50 = 500 µ$ ($0.0005).
    expect(done.data).toMatchObject({ neurons: 500, unit: 'usd', usage: { inputTokens: 1000, outputTokens: 120, estimated: false } })
    await server!.settled()
    expect((await status()).quota.installUsed).toBe(500)
    // What reached the provider: its model ID, Inkling's instructions, the key as a bearer token.
    const [req] = fake!.completions()
    expect(req!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(req!.body).toMatchObject({ model: 'Qwen/Qwen3.8-27B', stream: true, max_tokens: 900, chat_template_kwargs: { enable_thinking: false } })
    expect(req!.body.messages[0].role).toBe('system')
    // The key never appears in what the app receives or in any log line; nor does the question.
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
    const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])
    expect(logged).not.toContain(FAKE_KEY)
    expect(logged).not.toMatch(/private question/)
  })

  it('status names the model, not the provider, and needs no model call', async () => {
    await start()
    const s = await status()
    expect(s.model).toBe(CLOUD_MODEL_PUBLIC)
    expect(s.quota).toMatchObject({ installLimit: 20_000, globalLimit: 1_000_000, approxAnswersLeft: 25 })
    expect(fake!.completions()).toHaveLength(0)
  })

  it('an app whose user agreed to an older data notice is asked to update, before anything is sent', async () => {
    await start()
    for (const notice of [null, '3', 'abc']) {
      const r = await post(chat('hi'), { notice })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatchObject({ code: 'bad_request', scope: 'update_required' })
      expect(r.json.error.message).toMatch(/Update Inkling/)
    }
    expect(fake!.completions()).toHaveLength(0)
    expect((await post(chat('hi'), { notice: String(CLOUD_CONSENT_VERSION) })).status).toBe(200)
  })

  it('retries a provider hiccup before the answer starts, with backoff, and charges one answer', async () => {
    await start()
    fake!.fail({ status: 503 })
    fake!.fail({ status: 429, headers: { 'retry-after': '1' } })
    fake!.model.reply({ text: 'Recovered.', usage: { inputTokens: 500, outputTokens: 40 } })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.event).toBe('done')
    expect(fake!.completions()).toHaveLength(3)
    // Exponential backoff with jitter (random 0.5 → ×1): 500 ms, then the provider's 1 s.
    expect(noSleep.sleeps).toEqual([500, 1000])
    await server!.settled()
    expect((await status()).quota.installUsed).toBe(500 * 0.2 + 40 * 2.5)
  })

  it('never retries forever: after the attempts run out the student gets a clear error and nothing is charged', async () => {
    await start()
    for (let i = 0; i < 5; i++) fake!.fail({ status: 502 })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'server' })
    expect(fake!.completions()).toHaveLength(3)
    await server!.settled()
    expect((await status()).quota.installUsed).toBe(0)
  })

  it('a long Retry-After is not waited for: the rate limit is passed on', async () => {
    await start()
    fake!.fail({ status: 429, headers: { 'retry-after': '120' } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(429)
    expect(r.json.error.code).toBe('rate_limited')
    expect(fake!.completions()).toHaveLength(1)
  })

  it('a provider that does not answer in time is tried again; a timed-out attempt is charged its input, to be safe', async () => {
    await start({ adapter: { firstByteTimeoutMs: 150 } })
    fake!.fail({ hangMs: 600 })
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 300, outputTokens: 10 } })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.event).toBe('done')
    await server!.settled()
    const used = (await status()).quota.installUsed
    expect(used).toBeGreaterThan(300 * 0.2 + 10 * 2.5)
  })

  it('a rejected API key is an operator problem: a calm message, no retries, no charge, no key in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await start({ fake: { key: 'a-different-key-xxxxxxxxxxxxxxxx' } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('server')
    expect(r.json.error.message).not.toMatch(/key/i)
    expect(fake!.requests).toHaveLength(1)
    expect(JSON.stringify(error.mock.calls)).toMatch(/refused the API key/)
    expect(JSON.stringify(error.mock.calls)).not.toContain(FAKE_KEY)
    await server!.settled()
    expect((await status()).quota.installUsed).toBe(0)
  })

  it('an unavailable model is said so without retrying', async () => {
    await start()
    fake!.fail({ status: 404, body: { error: { message: 'model not found' } } })
    const r = await post(chat('hi'))
    expect(r.json.error.code).toBe('model_unavailable')
    expect(fake!.completions()).toHaveLength(1)
  })

  it('the provider account running out of credit pauses everyone briefly, like Cloudflare’s free allocation', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await start()
    fake!.fail({ status: 402, body: { error: { message: 'Insufficient balance' } } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'server', scope: 'upstream_unavailable' })
    // Others are paused too, without calling the provider.
    const other = await post(chat('hello'), { install: INSTALL_B, ip: '198.51.100.7' })
    expect(other.json.error.scope).toBe('upstream_unavailable')
    expect(fake!.completions()).toHaveLength(1)
    // An operator alert, as DeepInfra's real 402 body says: "You need positive balance to do inference".
    expect(JSON.stringify(error.mock.calls)).toMatch(/no credit/)
  })

  it('a malformed stream is an error, charged conservatively; garbage is never shown as an answer', async () => {
    await start()
    fake!.fail({ garbage: 'data: {not json\n\ndata: <html>oops</html>\n\n' })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.event).toBe('error')
    expect(r.events.filter((e) => e.event === 'delta')).toHaveLength(0)
    await server!.settled()
    expect((await status()).quota.installUsed).toBeGreaterThan(0)
  })

  it('a malformed whole-body reply is a bad response, not retried', async () => {
    await start({ server: { structured: 'json_schema' } })
    fake!.fail({ garbage: '<html>gateway</html>' })
    const r = await post({ task: 'check', turns: [{ role: 'user', parts: [{ text: 'Problem: 1+1. Expected: 2. My answer: 2' }] }] })
    expect(r.status).toBe(502)
    expect(r.json.error.code).toBe('bad_response')
    expect(fake!.completions()).toHaveLength(1)
  })

  it('an error reported in the middle of the stream ends the answer', async () => {
    await start()
    fake!.fail({ errorEvent: true })
    const r = await post(chat('hi'))
    expect(r.events[0]).toMatchObject({ event: 'delta', data: { text: 'Partial' } })
    expect(r.events.at(-1)!.event).toBe('done')
  })

  it('a stream that goes silent is stopped and charged in full', async () => {
    await start({ adapter: { idleTimeoutMs: 100 } })
    fake!.fail({ idleAfterFirst: true })
    const r = await post(chat('hi'))
    expect(r.events.map((e) => e.event)).toEqual(['delta', 'done'])
    await server!.settled()
    expect((await status()).quota.installUsed).toBeGreaterThan(0)
  })

  it('a provider that ignores the token cap is cut off and charged its reservation, never more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await start()
    // 900-token cap; the fake streams ~12,000 characters and reports 3,000 output tokens.
    fake!.model.reply({ chunks: Array.from({ length: 100 }, () => 'x'.repeat(120)), usage: { inputTokens: 300, outputTokens: 3000 } })
    const r = await post(chat('hi'))
    const shown = r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
    expect(shown.length).toBeLessThanOrEqual(900 * 8 + 120)
    expect(r.events.at(-1)!).toMatchObject({ event: 'done', data: { finishReason: 'MAX_TOKENS' } })
    // Charged this attempt's worst case (input bound: the request's bytes + 900 × $2.50/M), not the 3,000 tokens reported.
    expect(r.events.at(-1)!.data.neurons).toBeLessThan(900 * 2.5 + 600)
    expect(r.events.at(-1)!.data.neurons).toBeGreaterThan(900 * 2.5)
    expect(JSON.stringify(warn.mock.calls)).toMatch(/runaway_output/)
  })

  it('reserves the input with a margin, so a provider counting more input than estimated stays inside the reservation', async () => {
    await start({ server: { inputMargin: 1.5 } })
    const q = await status()
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })
    await post(chat('hi'))
    // The reservation shows while the answer runs; afterwards the real (tiny) cost replaces it.
    await server!.settled()
    expect((await status()).quota.installUsed).toBeLessThan(5)
    expect(q.quota.installUsed).toBe(0)
  })

  it('uses OpenRouter’s reported cost, with its credit fee', async () => {
    await start({ provider: 'openrouter', fake: { path: '/api/v1', reportCost: () => 0.0004 } })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.data).toMatchObject({ unit: 'usd', neurons: Math.round(400 * 1.055 * 10) / 10 })
    expect(fake!.completions()[0]!.body.provider).toMatchObject({ order: ['deepinfra'], allow_fallbacks: false, zdr: true })
  })

  it('cached prompt tokens are charged at the cached rate', async () => {
    await start({ fake: { cachedTokens: 800 } })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 1000, outputTokens: 100 } })
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.data.neurons).toBeCloseTo(200 * 0.2 + 800 * 0.05 + 100 * 2.5)
  })
})

// ------------------------------------------------------------------ economics

describe('the $5 budget: atomic caps, reconciled reservations, pacing, honest messages', () => {
  const base: LedgerLimits = { unit: 'usd', globalDailyNeurons: 250_000, globalMonthly: 5_000_000, installDailyNeurons: 10_000, networkDailyNeurons: 50_000, installPerMinute: 1000, networkPerMinute: 1000, installConcurrent: 1000, networkConcurrent: 1000, globalConcurrent: 1000, reservationTtlMs: 600_000, typicalNeuronsPerAnswer: 800 }
  const memory = () => {
    const map = new Map<string, unknown>()
    return { map, storage: { get: async (k: string) => structuredClone(map.get(k)) as any, put: async (k: string, v: unknown) => void map.set(k, structuredClone(v)), delete: async (k: string) => void map.delete(k), list: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)) } }
  }
  const who = (i: number) => ({ install: 'inst_' + String(i).padStart(32, '0'), network: `198.51.100.${i % 250}` })

  it('200 simultaneous requests can never reserve past the daily or monthly hard cap', async () => {
    const { storage } = memory()
    const ledger = new Ledger(storage, { ...base, globalDailyNeurons: 30_000, globalMonthly: 40_000 })
    // Each worst case is 1,000 µ$: at most 30 may be in flight under a $0.03 daily cap.
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => ledger.reserve(who(i), 1_000, 800)))
    const ok = results.filter((r) => r.ok)
    expect(ok).toHaveLength(30)
    expect(results.filter((r) => !r.ok && r.code === 'global_quota')).toHaveLength(170)
    // Every one settles at its real (lower) cost: room comes back, and the month never passes its cap.
    await Promise.all(ok.map((r) => ledger.settle((r as any).reservationId, 600)))
    const s1 = await ledger.summary()
    expect(s1.answering).toBe(0)
    expect(s1.monthUsed).toBe(18_000)
    const more = await Promise.all(Array.from({ length: 200 }, (_, i) => ledger.reserve(who(i + 300), 1_000, 800)))
    const ok2 = more.filter((r) => r.ok)
    await Promise.all(ok2.map((r) => ledger.settle((r as any).reservationId, 1_000)))
    const s2 = await ledger.summary()
    expect(s2.monthUsed).toBeLessThanOrEqual(30_000) // the daily cap (any 24 h) binds first here
    expect(s2.monthUsed).toBeLessThanOrEqual(40_000)
  })

  it('reservations are reconciled: success charges the real cost, failure before the model charges nothing, a lost answer the worst case', async () => {
    const { storage } = memory()
    const ledger = new Ledger(storage, base)
    const a = await ledger.reserve(who(1), 3_000, 800)
    const b = await ledger.reserve(who(2), 3_000, 800)
    const c = await ledger.reserve(who(3), 3_000, 800)
    if (!a.ok || !b.ok || !c.ok) throw new Error('reserve')
    expect((await ledger.summary()).globalUsed).toBe(9_000) // all three held against the cap while open
    await ledger.settle(a.reservationId, 640) // answered: the provider's real cost
    await ledger.settle(b.reservationId, undefined, { failedBeforeModel: true }) // refused before any work
    await ledger.settle(c.reservationId, undefined) // stream lost, usage unknown: the full reservation
    const s = await ledger.summary()
    expect(s.answering).toBe(0)
    expect(s.globalUsed).toBe(640 + 0 + 3_000)
    expect(s.monthUsed).toBe(3_640)
    // Settling twice (a retry of the bookkeeping) changes nothing.
    await ledger.settle(a.reservationId, 640)
    expect((await ledger.summary()).monthUsed).toBe(3_640)
  })

  it('an abandoned reservation is charged in full and released when it expires, never left holding the cap', async () => {
    const { storage } = memory()
    let t = Date.parse('2026-11-10T12:00:00Z')
    const ledger = new Ledger(storage, base, () => t)
    const a = await ledger.reserve(who(1), 3_000, 800)
    if (!a.ok) throw new Error('reserve')
    t += 11 * 60_000 // past the 10-minute lifetime
    const s = await ledger.summary()
    expect(s.answering).toBe(0)
    expect(s.monthUsed).toBe(3_000)
  })

  it('a timed-out retry is inside the reservation: the settled cost never exceeds what was reserved', async () => {
    await start({ adapter: { firstByteTimeoutMs: 150 }, server: { upstreamAttempts: 3 } })
    fake!.fail({ hangMs: 600 })
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 300, outputTokens: 10 } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await post(chat('hi'))
    expect(r.events.at(-1)!.event).toBe('done')
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.overshoot).toEqual({ count: 0, total: 0 })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('cost above reservation'))).toBe(false)
  })

  it('a provider bill above the worst case is charged in full and reported, never hidden', async () => {
    await start()
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 200_000, outputTokens: 10 } }) // far above any estimate
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await post(chat('hi'))
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.monthUsed).toBe(200_000 * 0.2 + 10 * 2.5)
    expect(sum.overshoot.count).toBe(1)
    expect(sum.overshoot.total).toBeGreaterThan(0)
  })

  it('monthly pacing: a busy start lowers later days’ caps so the month is never spent early', async () => {
    const { storage } = memory()
    let t = Date.parse('2026-11-01T09:00:00Z') // 30 days in November
    const ledger = new Ledger(storage, { ...base, monthlyPacing: 1.5 }, () => t)
    // Day 1: (5,000,000 / 30) × 1.5 = 250,000 µ$ — the configured $0.25.
    expect((await ledger.quota(who(1))).globalLimit).toBe(250_000)
    expect((await ledger.quota(who(1))).paced).toBeUndefined()
    // Spend $4.20 over the first days (simulated here as one large settled answer on 1 Nov).
    const big = await ledger.reserve(who(1), 240_000, 1)
    if (!big.ok) throw new Error('reserve')
    await ledger.settle(big.reservationId, 4_200_000)
    t = Date.parse('2026-11-21T09:00:00Z') // 10 days left: (800,000 / 10) × 1.5 = 120,000 µ$
    const q = await ledger.quota(who(2))
    expect(q.globalLimit).toBe(120_000)
    expect(q.paced).toBe(true)
    const s = await ledger.summary()
    expect(s).toMatchObject({ paced: true, globalLimit: 120_000, dailyConfigured: 250_000 })
    // A request that doesn't fit today's paced share waits for tomorrow's, with a message that says why.
    const r = await ledger.reserve(who(2), 130_000, 1)
    expect(r).toMatchObject({ ok: false, code: 'global_quota' })
  })

  it('without pacing or soft limits, each day’s cap is the configured one and nothing is silently reduced', async () => {
    const { storage } = memory()
    const ledger = new Ledger(storage, base)
    const a = await ledger.reserve(who(1), 240_000, 1)
    if (!a.ok) throw new Error('reserve')
    await ledger.settle(a.reservationId, 240_000) // 96% of the day
    const q = await ledger.quota(who(2))
    expect(q.installLimit).toBe(10_000)
    expect(q.reduced).toBeUndefined()
  })

  it('the refusal says when the shared budget, paced for the month, is what ran out', async () => {
    await start({ server: { globalDailyNeurons: 250_000 }, limits: { globalMonthly: 300, monthlyPacing: 1.5 } })
    const r = await post(chat('hi'))
    expect(r.status).toBe(429)
    expect(r.json.error.scope).toBe('global_quota')
    expect(r.json.error.message).toMatch(/used up for everyone, to keep enough for the rest of the month/)
    expect(fake!.completions()).toHaveLength(0)
  })

  it('when reduced allowances are switched on, the refusal says so', async () => {
    await start({ server: { globalDailyNeurons: 10_000, installDailyNeurons: 3_000 }, limits: { softFraction: 0.5, softFactor: 0.5 } })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 5000, outputTokens: 1800 } }) // 5,500 µ$: past half the day
    await post(chat('big'), { install: INSTALL_B, ip: '198.51.100.9' })
    await server!.settled()
    fake!.model.reply({ text: 'y', usage: { inputTokens: 1000, outputTokens: 300 } })
    await post(chat('one'))
    await server!.settled()
    const r = await post(chat('two'))
    expect(r.json.error.scope).toBe('install_quota')
    expect(r.json.error.message).toMatch(/allowance is smaller right now because Inkling’s shared AI budget is nearly used up/)
  })
})

describe('one model on an external provider, and token accounting', () => {
  const TEXT_MODEL = { model: '@cf/google/gemma-4-26b-a4b-it', rates: { inputPerM: 9091, outputPerM: 27273 }, tasks: ['practice', 'chat', 'check'] as const }

  it('never routes: even with a text model configured, every task goes to Qwen 3.8 27B on the provider', async () => {
    await start({ server: { textModel: TEXT_MODEL } })
    for (const task of ['chat', 'practice', 'check'] as const) {
      const body = task === 'chat' ? chat('What is 2+2?') : { task, turns: [{ role: 'user', parts: [{ text: task === 'check' ? 'Problem: 2+2. Student answer: 4' : 'Topic: fractions. Difficulty: easy. 2 problems.' }] }] }
      const r = await post(body, { install: 'inst_' + task.padEnd(32, 'x') })
      expect(r.status).toBe(200)
      await server!.settled()
    }
    const models = fake!.completions().map((c) => c.body.model)
    expect(models).toEqual(['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-27B'])
  })

  it('the Workers AI rollback keeps today’s text-only rule unchanged', async () => {
    server = await startBetaServer({ textModel: { ...TEXT_MODEL, tasks: ['practice'] } })
    const r = await post({ task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Topic: fractions. 2 problems.' }] }] }, { notice: null })
    expect(r.status).toBe(200)
    await server.settled()
    expect((server.ai as any).calls.map((c: any) => c.model)).toEqual(['@cf/google/gemma-4-26b-a4b-it'])
  })

  it('tracks the provider’s real tokens and cost per installation, per day, per month and per model; no content', async () => {
    await start({ fake: { cachedTokens: 400 } })
    fake!.model.reply({ text: 'First answer.', usage: { inputTokens: 1000, outputTokens: 100 } })
    fake!.model.reply({ text: 'Second answer.', usage: { inputTokens: 1500, outputTokens: 200 } })
    await post(chat('a private question'))
    await server!.settled()
    await post(chat('another private question'))
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.unit).toBe('usd')
    expect(sum.tokens).toEqual({ today: { input: 2500, output: 300 }, month: { input: 2500, output: 300 } })
    const m = sum.models.today['Qwen/Qwen3.8-27B']
    expect(m).toMatchObject({ requests: 2, errors: 0, inputTokens: 2500, outputTokens: 300, cachedTokens: 800, estimated: 0, inputTokensPerAnswer: 1250, outputTokensPerAnswer: 150, tasks: { chat: 2 }, routes: { main: 2 } })
    // Cost: (600 × 0.20 + 400 × 0.05 + 100 × 2.50) + (1100 × 0.20 + 400 × 0.05 + 200 × 2.50) = 390 + 740 = 1130 µ$.
    expect(m.neurons).toBe(1130)
    expect(sum.monthUsed).toBe(1130)
    // Per installation (hashed key): tokens alongside cost.
    const installKeys = [...server!.storage.store.keys()].filter((k) => k.startsWith('i:'))
    expect(installKeys).toHaveLength(1)
    expect(server!.storage.store.get(installKeys[0]!)).toMatchObject({ neurons: 1130, requests: 2, inputTokens: 2500, outputTokens: 300 })
    // Nothing stored anywhere carries content or the raw installation ID.
    const stored = JSON.stringify([...server!.storage.store.entries()])
    expect(stored).not.toMatch(/private question|First answer/)
    expect(stored).not.toContain(INSTALL_A)
  })

  it('without provider usage, tokens are estimated conservatively and flagged as estimated', async () => {
    await start()
    fake!.model.reply({ text: 'An answer with no usage report.', noUsage: true })
    const r = await post(chat('question'))
    expect(r.events.at(-1)!.data.usage.estimated).toBe(true)
    await server!.settled()
    const m = (await server!.admin('GET', '/admin/summary')).body.models.today['Qwen/Qwen3.8-27B']
    expect(m.estimated).toBe(1)
    expect(m.inputTokens).toBeGreaterThan(0)
    expect(m.outputTokens).toBeGreaterThan(0)
  })

  it('a failed call is counted as an error by kind, with no tokens', async () => {
    await start()
    fake!.fail({ status: 404, body: { error: { message: 'model not found' } } })
    const r = await post(chat('question'))
    expect(r.status).toBe(503)
    const m = (await server!.admin('GET', '/admin/summary')).body.models.today['Qwen/Qwen3.8-27B']
    expect(m).toMatchObject({ requests: 1, errors: 1, errorKinds: { model_unavailable: 1 }, inputTokens: 0, outputTokens: 0 })
  })
})

describe('spending caps and budget protection', () => {
  it('the daily dollar cap stops everyone before the provider is called', async () => {
    // $0.0025 a day: room for one worst-case chat (~$0.0023). After a $0.0019 answer, even a
    // shortened chat answer (at least 300 tokens) no longer fits.
    await start({ server: { globalDailyNeurons: 2_500 } })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 2000, outputTokens: 600 } }) // 1,900 µ$
    expect((await post(chat('one'))).status).toBe(200)
    await server!.settled()
    const r = await post(chat('two'), { install: INSTALL_B, ip: '198.51.100.7' })
    expect(r.status).toBe(429)
    expect(r.json.error).toMatchObject({ code: 'daily_quota', scope: 'global_quota' })
    expect(fake!.completions()).toHaveLength(1)
  })

  it('the monthly dollar cap stops everyone until the next month', async () => {
    await start({ limits: { globalMonthly: 3_000 } })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 2000, outputTokens: 300 } })
    await post(chat('one'))
    await server!.settled()
    const r = await post(chat('two'), { install: INSTALL_B, ip: '198.51.100.7' })
    expect(r.json.error).toMatchObject({ code: 'daily_quota', scope: 'global_monthly_quota' })
    expect(r.json.error.message).toMatch(/this month/)
    const now = new Date()
    const toNextMonth = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000
    expect(r.json.error.retryAfter).toBeGreaterThan(toNextMonth - 60)
    expect(r.json.error.retryAfter).toBeLessThanOrEqual(toNextMonth + 1)
    expect(fake!.completions()).toHaveLength(1)
  })

  it('an installation’s monthly allowance applies across days, with a new ID still meeting the network limit', async () => {
    await start({ limits: { installMonthly: 1_500 } })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 2000, outputTokens: 300 } }) // 1,150 µ$
    await post(chat('one'))
    await server!.settled()
    server!.clock.offset += 26 * 3_600_000 // the next day (the daily count is gone; the monthly one isn't)
    const now = new Date(Date.now() + server!.clock.offset)
    if (now.getUTCDate() === 1) return // crossed into a new month: nothing to check today
    const r = await post(chat('two'))
    expect(r.json.error).toMatchObject({ code: 'daily_quota', scope: 'install_monthly_quota' })
    expect((await status()).quota).toMatchObject({ installMonthUsed: 1150, installMonthLimit: 1500 })
  })

  it('near the budget, everyone’s daily share shrinks instead of the budget running out', async () => {
    await start({ server: { globalDailyNeurons: 10_000 }, limits: { softFraction: 0.5, softFactor: 0.5 } })
    expect((await status(INSTALL_B)).quota).toMatchObject({ installLimit: 20_000 })
    fake!.model.reply({ text: 'x', usage: { inputTokens: 5000, outputTokens: 1800 } }) // 5,500 µ$ = 55% of the day
    await post(chat('big'))
    await server!.settled()
    const q = (await status(INSTALL_B)).quota
    expect(q.reduced).toBe(true)
    expect(q.installLimit).toBe(10_000)
  })

  it('a ledger switched between Neurons and dollars restarts its counts instead of misreading them', async () => {
    const map = new Map<string, unknown>()
    const storage = { get: async (k: string) => structuredClone(map.get(k)) as any, put: async (k: string, v: unknown) => void map.set(k, structuredClone(v)), delete: async (k: string) => void map.delete(k), list: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)) }
    const base: LedgerLimits = { globalDailyNeurons: 9000, installDailyNeurons: 900, networkDailyNeurons: 2700, installPerMinute: 60, networkPerMinute: 60, installConcurrent: 5, networkConcurrent: 5, globalConcurrent: 5, reservationTtlMs: 600_000, typicalNeuronsPerAnswer: 90 }
    const id = { install: INSTALL_A, network: '192.0.2.1' }
    const neurons = new Ledger(storage, { ...base, unit: 'neurons' })
    const a = await neurons.reserve(id, 100, 100)
    if (!a.ok) throw new Error('reserve')
    await neurons.settle(a.reservationId, 800)
    expect((await neurons.quota(id)).installUsed).toBe(800)
    // Forward to dollars ($1 a day): yesterday's 800 Neurons are not read as 800 µ$.
    const usd = new Ledger(storage, { ...base, unit: 'usd', globalDailyNeurons: 1_000_000, installDailyNeurons: 20_000, globalMonthly: 10_000_000 })
    expect((await usd.quota(id)).installUsed).toBe(0)
    const b = await usd.reserve(id, 2000, 900)
    if (!b.ok) throw new Error('reserve')
    await usd.settle(b.reservationId, 5_000)
    // Roll back to Neurons: 5,000 µ$ must not close Cloudflare's 9,000-Neuron day.
    const back = new Ledger(storage, { ...base, unit: 'neurons' })
    expect((await back.quota(id)).globalUsed).toBe(0)
    // And forward again in the same month: the month's dollars are still counted.
    const again = new Ledger(storage, { ...base, unit: 'usd', globalDailyNeurons: 1_000_000, installDailyNeurons: 20_000, globalMonthly: 10_000_000 })
    expect((await again.summary()).monthUsed).toBe(5_000)
  })
})

// ------------------------------------------------------------------ duplicates

describe('duplicate requests', () => {
  it('the same request again right after it was answered is refused without calling the provider', async () => {
    await start()
    const body = chat('What is 2+2?')
    expect((await post(body)).events.at(-1)!.event).toBe('done')
    await server!.settled()
    const again = await post(body)
    expect(again.status).toBe(429)
    expect(again.json.error).toMatchObject({ code: 'rate_limited', scope: 'duplicate' })
    expect(fake!.completions()).toHaveLength(1)
    // Something different is fine, and so is the same question later.
    expect((await post(chat('What is 2+3?'))).status).toBe(200)
    await server!.settled()
    server!.clock.offset += 11_000
    expect((await post(body)).status).toBe(200)
  })

  it('a request that failed may be tried again at once', async () => {
    await start()
    for (let i = 0; i < 3; i++) fake!.fail({ status: 503 })
    const body = chat('retry me')
    expect((await post(body)).status).toBe(503)
    await server!.settled()
    expect((await post(body)).events.at(-1)!.event).toBe('done')
  })

  it('two simultaneous copies from one installation become one answer', async () => {
    await start()
    fake!.model.reply({ chunks: ['slow ', 'answer'], chunkDelayMs: 50 })
    const body = chat('double click')
    const [a, b] = await Promise.all([post(body), post(body)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 429])
    expect([a, b].find((r) => r.status === 429)!.json.error.code).toBe('busy')
    expect(fake!.completions()).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ configuration

describe('Worker configuration', () => {
  const baseEnv = (extra: Partial<Env> = {}): Env =>
    ({
      MODEL: '@cf/qwen/qwen3.8-27b',
      ACCOUNT_PLAN: 'free',
      GLOBAL_DAILY_NEURONS: '9000',
      INSTALL_DAILY_NEURONS: '900',
      NETWORK_DAILY_NEURONS: '2700',
      INSTALL_PER_MINUTE: '6',
      NETWORK_PER_MINUTE: '20',
      INSTALL_CONCURRENT: '1',
      NETWORK_CONCURRENT: '4',
      GLOBAL_CONCURRENT: '12',
      TYPICAL_NEURONS_PER_ANSWER: '90',
      INPUT_NEURONS_PER_M: '40909',
      OUTPUT_NEURONS_PER_M: '290909',
      REASONING_EFFORT: 'low',
      DISABLE_THINKING: 'true',
      STRUCTURED: 'prompt',
      IMAGE_PATCH: '28',
      MAX_INPUT_TOKENS: '12000',
      ...extra
    }) as Env

  const deepinfra = { INFERENCE_PROVIDER: 'deepinfra', INFERENCE_API_KEY: 'k'.repeat(40), PRICE_INPUT_USD_PER_M: '0.20', PRICE_OUTPUT_USD_PER_M: '2.50', GLOBAL_DAILY_USD: '5', GLOBAL_MONTHLY_USD: '100' }

  it('without INFERENCE_PROVIDER nothing changes: Workers AI, Neurons, Workers Free only', () => {
    const env = baseEnv({ AI: { run: async () => ({}) } })
    expect(providerOf(env)).toBe('workers-ai')
    const inf = inference(env)
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf).toMatchObject({ provider: 'workers-ai', model: '@cf/qwen/qwen3.8-27b', rates: { unit: 'neurons' }, minNotice: 0, inputMargin: 1 })
    expect(limitsFromEnv(env).globalDailyNeurons).toBe(9000)
    expect(inference(baseEnv({ ACCOUNT_PLAN: 'paid' }))).toMatch(/ACCOUNT_PLAN/)
  })

  it('an external provider fails closed without its key, prices or both spending caps', () => {
    expect(inference(baseEnv({ ...deepinfra, INFERENCE_API_KEY: '' }))).toMatch(/INFERENCE_API_KEY/)
    expect(inference(baseEnv({ ...deepinfra, PRICE_OUTPUT_USD_PER_M: '' }))).toMatch(/PRICE/)
    expect(inference(baseEnv({ ...deepinfra, GLOBAL_MONTHLY_USD: undefined }))).toMatch(/GLOBAL_MONTHLY_USD/)
    expect(inference(baseEnv({ ...deepinfra, GLOBAL_DAILY_USD: '0' }))).toMatch(/GLOBAL_DAILY_USD/)
    expect(inference(baseEnv({ ...deepinfra, UPSTREAM_BASE_URL: 'http://api.example.com' }))).toMatch(/https/)
    expect(inference(baseEnv({ ...deepinfra, UPSTREAM_EXTRA_BODY: '{nope' }))).toMatch(/JSON/)
  })

  it('DeepInfra: list prices in µ$, dollar limits, notice 4, the public model name; no Workers Free requirement', () => {
    const env = baseEnv({ ...deepinfra, ACCOUNT_PLAN: 'paid', INSTALL_MONTHLY_USD: '0.5' })
    const inf = inference(env)
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf).toMatchObject({ provider: 'deepinfra', model: 'Qwen/Qwen3.8-27B', publicModel: 'qwen3.8-27b', minNotice: 4, inputMargin: 1.5, rates: { unit: 'usd', inputPerM: 200_000, outputPerM: 2_500_000, costMultiplier: 1 } })
    expect(limitsFromEnv(env)).toMatchObject({ unit: 'usd', globalDailyNeurons: 5_000_000, globalMonthly: 100_000_000, installDailyNeurons: 100_000, networkDailyNeurons: 1_000_000, installMonthly: 500_000 })
    // Reduced allowances are opt-in; monthly pacing is off unless set.
    expect(limitsFromEnv(env)).toMatchObject({ softFraction: undefined, softFactor: undefined, monthlyPacing: undefined })
  })

  it('a daily cap above the monthly one is held to the monthly one', () => {
    expect(limitsFromEnv(baseEnv({ ...deepinfra, GLOBAL_DAILY_USD: '50', GLOBAL_MONTHLY_USD: '20' })).globalDailyNeurons).toBe(20_000_000)
  })

  it('a provider no shipped notice names is closed to real users until the notice is updated', () => {
    const inf = inference(baseEnv({ ...deepinfra, INFERENCE_PROVIDER: 'openrouter' }))
    if (typeof inf === 'string') throw new Error(inf)
    expect(inf.minNotice).toBe(NOTICE_NOT_YET_SHIPPED)
    expect(inf.minNotice).toBeGreaterThan(CLOUD_CONSENT_VERSION)
  })
})

// ------------------------------------------------------------------ the app

describe('app on the external provider', () => {
  it('the app is unchanged except for telling the server its notice version; it never learns the provider', async () => {
    await start()
    const quotas: unknown[] = []
    const cloud = new CloudProvider({ baseUrl: server!.url, installId: INSTALL_A, onQuota: (q) => quotas.push(q) })
    const models = await cloud.listModels()
    expect(models[0]).toMatchObject({ id: 'qwen3.8-27b', displayName: 'Qwen 3.8 27B', canGenerate: true })
    let text = ''
    let end: any
    for await (const c of cloud.stream({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] } as any)) {
      if (c.type === 'text') text += c.text
      if (c.type === 'end') end = c
    }
    expect(text.length).toBeGreaterThan(0)
    expect(end.usage.inputTokens).toBeGreaterThan(0)
    expect(quotas.length).toBeGreaterThanOrEqual(2)
    const tutorRequests = server!.requests.filter((r) => r.path === '/v1/tutor')
    expect(tutorRequests[0]!.headers['x-inkling-notice']).toBe(String(CLOUD_CONSENT_VERSION))
    expect(JSON.stringify(tutorRequests[0]!.headers)).not.toMatch(/deepinfra|authorization/i)
  })

  it('an older app (notice 3) gets a plain “update Inkling” error, not a crash or a retry loop', async () => {
    await start({ server: { minNoticeVersion: 5 } })
    const cloud = new CloudProvider({ baseUrl: server!.url, installId: INSTALL_A })
    const run = async (): Promise<void> => {
      for await (const _ of cloud.stream({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] } as any)) void _
    }
    await expect(run()).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/Update Inkling/) })
    expect(fake!.completions()).toHaveLength(0)
  })
})


// ------------------------------------------------------------------ stress: the $5 budget (7 Nov 2026 review)

describe('budget stress: large inputs, overshoot, a school network', () => {
  /** The production DeepInfra settings in µ$ ($5/month, $0.25/day, $0.01 and $0.05 per day). */
  const PROD = { server: { globalDailyNeurons: 250_000, installDailyNeurons: 10_000, networkDailyNeurons: 50_000, typicalNeuronsPerAnswer: 800, networkConcurrent: 4, globalConcurrent: 8, upstreamAttempts: 3 }, limits: { globalMonthly: 5_000_000, installMonthly: 150_000 } }
  const digits = (n: number): string => Array.from({ length: n }, (_, i) => String((i * 7) % 10)).join('')

  it('the input upper bound is never below the bytes the tokenizer can split into', () => {
    const turns = [{ role: 'user' as const, parts: [{ text: digits(6000) }] }]
    // The 3-characters-a-token estimate: ~2,000 tokens; Qwen splits digits one per token: 6,000+.
    expect(estimateInputTokens('', turns)).toBeLessThan(2100)
    expect(inputUpperBound('', turns)).toBeGreaterThanOrEqual(6000)
    // Non-Latin text: 1 character can be several bytes and several tokens.
    const cjk = [{ role: 'user' as const, parts: [{ text: '微积分'.repeat(500) + '😀'.repeat(100) }] }]
    expect(inputUpperBound('', cjk)).toBeGreaterThanOrEqual(1500 * 3 + 100 * 4)
  })

  it('a digit-heavy notebook page billed at the worst possible count never costs more than its reservation', async () => {
    await start(PROD)
    const text = 'Check my long division: ' + digits(6000)
    const worstIn = inputUpperBound('', [{ role: 'user', parts: [{ text }] }]) + 800 // + the system prompt, generously
    fake!.model.reply({ text: 'ok', usage: { inputTokens: worstIn, outputTokens: 900 } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await post(chat(text))
    expect(r.events.at(-1)!.event).toBe('done')
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.overshoot).toEqual({ count: 0, total: 0 })
  })

  it('the largest allowed request, three attempts, billed at the worst case: inside the reservation; one above the limit is refused for free', async () => {
    await start({ ...PROD, adapter: { firstByteTimeoutMs: 150 } })
    // Two 16,500-character parts (24,000 a part is the schema's limit): ~11,000 estimated tokens, under MAX_INPUT_TOKENS (12,000).
    const big2 = { task: 'chat', turns: [{ role: 'user', parts: [{ text: 'x'.repeat(16_500) }, { text: 'z'.repeat(16_500) }] }] }
    fake!.fail({ hangMs: 600 })
    fake!.fail({ hangMs: 600 })
    // Billed at the most the tokenizer can produce: one token per byte of text and the system prompt.
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 33_000 + 1_000, outputTokens: 900 } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await post(big2)
    expect(r.json ?? r.events.at(-1)).toMatchObject({ event: 'done' })
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.overshoot.count).toBe(0)
    expect(sum.monthUsed).toBeLessThan(40_000) // < $0.04 even in this worst case
    const big = await post({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'y'.repeat(20_000) }, { text: 'w'.repeat(20_000) }] }] }, { install: INSTALL_B })
    expect(big.status).toBe(413)
    expect(fake!.completions()).toHaveLength(3)
  })

  it('30 worst-case requests at once against an almost-spent month: the hard cap holds exactly', async () => {
    await start({ ...PROD, server: { ...PROD.server, globalConcurrent: 40, networkConcurrent: 40, networkPerMinute: 100, networkDailyNeurons: 5_000_000 }, limits: { globalMonthly: 20_000, installMonthly: 150_000 } })
    for (let i = 0; i < 30; i++) fake!.model.reply({ text: 'ok', usage: { inputTokens: 900, outputTokens: 900 } })
    const installs = Array.from({ length: 30 }, (_, i) => 'inst_' + String(i).padStart(32, 'c'))
    const results = await Promise.all(installs.map((install, i) => post(chat(`question ${i}`), { install, ip: `203.0.113.${i}` })))
    await server!.settled()
    const sum = (await server!.admin('GET', '/admin/summary')).body
    const answered = results.filter((r) => r.events.at(-1)?.event === 'done').length
    expect(answered).toBeGreaterThan(0)
    expect(results.filter((r) => r.json?.error?.scope === 'global_monthly_quota').length).toBe(30 - answered)
    expect(sum.monthUsed).toBeLessThanOrEqual(20_000)
    expect(sum.overshoot.count).toBe(0)
  })

  it('a classroom of 30 behind one school address: a minute, then a day', async () => {
    await start(PROD)
    const install = (i: number): string => 'inst_' + String(i).padStart(32, 's')
    const school = '198.51.100.40'
    // In one minute, one after another: the network's 20-a-minute limit is what a class meets first.
    const minute: string[] = []
    for (let i = 0; i < 30; i++) {
      fake!.model.reply({ text: 'ok', usage: { inputTokens: 640, outputTokens: 300 } }) // ~$0.00088, a typical answer
      const r = await post(chat(`student ${i}`), { install: install(i), ip: school })
      minute.push(r.events.at(-1)?.event === 'done' ? 'answered' : r.json.error.scope)
      await server!.settled()
    }
    expect(minute.filter((x) => x === 'answered')).toHaveLength(20)
    expect(minute.slice(20).every((x) => x === 'rate_limited')).toBe(true)
    // Another school is unaffected.
    fake!.model.reply({ text: 'ok', usage: { inputTokens: 640, outputTokens: 300 } })
    expect((await post(chat('elsewhere'), { install: 'inst_' + 'E'.repeat(32), ip: '192.0.2.7' })).events.at(-1)?.event).toBe('done')
  })

  it('…and over a day the school shares $0.05: ~55 typical answers, then a message naming the shared connection', async () => {
    await start({ ...PROD, server: { ...PROD.server, networkPerMinute: 1000 } })
    const school = '198.51.100.41'
    let answered = 0
    let refusal: any
    for (let i = 0; i < 80 && !refusal; i++) {
      fake!.model.reply({ text: 'ok', usage: { inputTokens: 640, outputTokens: 300 } })
      const r = await post(chat(`q${i}`), { install: 'inst_' + String(i % 30).padStart(32, 't'), ip: school })
      if (r.events.at(-1)?.event === 'done') answered++
      else if (r.json?.error?.scope !== 'duplicate') refusal = r.json.error
      await server!.settled()
    }
    expect(answered).toBeGreaterThanOrEqual(50)
    expect(answered).toBeLessThanOrEqual(60)
    expect(refusal.scope).toBe('network_quota')
    expect(refusal.message).toMatch(/internet connection \(shared by everyone on it, such as a school or office\)/)
    // The service as a whole still has budget for everyone else.
    const sum = (await server!.admin('GET', '/admin/summary')).body
    expect(sum.globalUsed).toBeLessThan(60_000)
  })
})
