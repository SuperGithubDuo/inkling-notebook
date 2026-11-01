import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@google/genai'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY, GeminiProvider, backoffDelay, classifyError, secondsUntilPacificMidnight, type RetryPolicy } from '../../src/main/ai/gemini'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { ProviderError, type ProviderChunk } from '../../src/main/ai/provider'
import { aiRequestSchema, apiKeySchema, redactKeys, type AiEvent, type AiRequest } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { BAD_KEY, VALID_AQ_KEY, VALID_KEY, errors, startFakeGemini, type FakeGemini } from '../support/fakeGemini.mjs'

let fake: FakeGemini
beforeAll(async () => {
  fake = await startFakeGemini()
})
afterAll(() => fake.close())
beforeEach(() => {
  fake.requests.length = 0
  logs = []
  fake.setModels([
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
  ])
})

/** Fast, quiet retries for tests; `logs` collects what the provider would print. */
const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 4 }
let logs: string[] = []
const provider = (key = VALID_KEY, retry: Partial<RetryPolicy> = FAST_RETRY): GeminiProvider =>
  new GeminiProvider({ apiKey: key, baseUrl: fake.url, retry, log: (l) => logs.push(l) })
const collect = async (it: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const out: ProviderChunk[] = []
  for await (const c of it) out.push(c)
  return out
}
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const req = (over: Partial<Parameters<GeminiProvider['stream']>[0]> = {}) => ({
  model: 'gemini-3.8-flash',
  system: 'sys',
  turns: [{ role: 'user' as const, parts: [{ text: 'Explain' }, { image: { mimeType: 'image/png' as const, data: PIXEL } }] }],
  maxOutputTokens: 100,
  ...over
})
async function errorOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    return e as ProviderError
  }
  throw new Error('expected an error')
}

describe('Gemini provider (official SDK against a fake Gemini API)', () => {
  it('streams text and sends text, image, system instruction and the key header', async () => {
    fake.reply({ chunks: ['Hel', 'lo $x$'] })
    const chunks = await collect(provider().stream(req()))
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('')).toBe('Hello $x$')
    expect(chunks.at(-1)).toMatchObject({ type: 'end', finishReason: 'STOP', usage: { inputTokens: 120, outputTokens: 40 } })
    const sent = fake.requests.at(-1)!
    expect(sent.path).toBe('/v1beta/models/gemini-3.8-flash:streamGenerateContent')
    expect(sent.key).toBe(VALID_KEY)
    expect(sent.body.systemInstruction.parts[0].text).toBe('sys')
    expect(sent.body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PIXEL } })
    expect(sent.body.generationConfig.maxOutputTokens).toBe(100)
  })

  it('asks for JSON output with a schema for structured tasks', async () => {
    fake.reply({ json: { ok: true } })
    await collect(provider().stream(req({ jsonSchema: { type: 'object' } })))
    const cfg = fake.requests.at(-1)!.body.generationConfig
    expect(cfg.responseMimeType).toBe('application/json')
    expect(cfg.responseJsonSchema).toEqual({ type: 'object' })
  })

  it('lists models without the models/ prefix and marks which can generate', async () => {
    fake.setModels([...[{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }], { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }])
    const models = await provider().listModels()
    expect(models.map((m) => [m.id, m.canGenerate])).toEqual([
      ['gemini-3.8-flash', true],
      ['embed', false]
    ])
  })

  it.each([
    ['invalid key', errors.invalidKey(), 'invalid_key', undefined],
    ['per-minute limit', errors.perMinute('17s'), 'rate_limited', 17],
    ['daily free quota', errors.perDay(), 'daily_quota', 'pacific'],
    ['model without free quota', errors.noFreeTier(), 'not_free', undefined],
    ['unknown model', errors.notFound(), 'model_unavailable', undefined],
    ['overloaded', errors.overloaded(), 'server', 10]
  ])('translates %s into a friendly error', async (_name, error, code, retry) => {
    fake.reply({ error })
    const e = await errorOf(collect(provider(VALID_KEY, { attempts: 1 }).stream(req())))
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.code).toBe(code)
    expect(e.message).not.toMatch(/\{|RESOURCE_EXHAUSTED/)
    if (retry === 'pacific') expect(e.retryAfter).toBeGreaterThan(0)
    else expect(e.retryAfter).toBe(retry)
  })

  it('reports a rejected key from the real request path', async () => {
    const e = await errorOf(provider(BAD_KEY).listModels())
    expect(e.code).toBe('invalid_key')
  })

  it('reports network failures', async () => {
    const offline = new GeminiProvider({ apiKey: VALID_KEY, baseUrl: 'http://127.0.0.1:9', retry: FAST_RETRY, log: (l) => logs.push(l) })
    const e = await errorOf(collect(offline.stream(req())))
    expect(e.code).toBe('network')
  })

  it('stops a streaming answer when canceled', async () => {
    fake.reply({ chunks: ['first'], hang: true })
    const controller = new AbortController()
    const got: string[] = []
    const e = await errorOf(
      (async () => {
        for await (const c of provider().stream(req(), controller.signal)) {
          if (c.type === 'text') got.push(c.text)
          controller.abort()
        }
      })()
    )
    expect(got).toEqual(['first'])
    expect(e.code).toBe('canceled')
  })

  it('treats a safety stop without any answer as blocked', async () => {
    fake.reply({ chunks: [''], finishReason: 'SAFETY' })
    const e = await errorOf(collect(provider().stream(req())))
    expect(e.code).toBe('blocked')
  })

  it('computes the wait until the Pacific midnight reset', () => {
    // 23:00 PDT on 15 July = 06:00 UTC on 16 July → one hour left.
    expect(secondsUntilPacificMidnight(new Date('2026-07-16T06:00:00Z'))).toBe(3600)
    expect(classifyError(new Error('boom'), { aborted: true, timedOut: false }).code).toBe('canceled')
  })
})

// ------------------------------------------------------------------ config

const fakeCipher = (opts: { available?: boolean; backend?: string } = {}): SecretCipher => ({
  isAsyncEncryptionAvailable: async () => opts.available ?? true,
  encryptStringAsync: async (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptStringAsync: async (b) => ({ result: Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(), shouldReEncrypt: false }),
  getSelectedStorageBackend: () => opts.backend ?? 'gnome_libsecret'
})

describe('AI config and key storage', () => {
  it('stores the key encrypted outside the notebook data, and reloads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const config = new AiConfig(dir, fakeCipher(), 'linux')
    await config.load()
    expect(await config.setKey(VALID_KEY)).toBe('encrypted')
    await config.setConsent(true)
    await config.setProvider('gemini')
    await config.setModel('gemini-3.5-flash-lite')
    const files = await readdir(dir)
    expect(files.sort()).toEqual(['ai-settings.json', 'gemini-key.bin'])
    for (const f of files) expect(await readFile(join(dir, f), 'utf8')).not.toContain(VALID_KEY)

    const again = new AiConfig(dir, fakeCipher(), 'linux')
    await again.load()
    expect(again.apiKey).toBe(VALID_KEY)
    expect(again.keyHint).toBe(VALID_KEY.slice(-4))
    expect(again.consented).toBe(true)
    expect(again.model).toBe('gemini-3.5-flash-lite')
    await again.clearKey()
    expect(await readdir(dir)).toEqual(['ai-settings.json'])
  })

  it('flags weak protection on Linux without a keyring, and keeps keys in memory when nothing can encrypt', async () => {
    const weak = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-ai-')), fakeCipher({ backend: 'basic_text' }), 'linux')
    expect(await weak.setKey(VALID_KEY)).toBe('weak')
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const none = new AiConfig(dir, fakeCipher({ available: false }), 'linux')
    expect(await none.setKey(VALID_KEY)).toBe('session')
    expect(none.apiKey).toBe(VALID_KEY)
    expect(await readdir(dir)).toEqual([])
  })

  it('migrates Phase 4 settings to the local default, falling back to the free Gemini model and asking consent again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'ai-settings.json'), JSON.stringify({ version: 1, provider: 'gemini', model: 'gemini-9-ultra-paid', consent: { version: 1, acceptedAt: 'x' } }))
    const config = new AiConfig(dir, fakeCipher())
    await config.load()
    expect(config.provider).toBe('ollama')
    expect(config.model).toBe('qwen3-vl:4b-instruct')
    expect(config.geminiModel).toBe('gemini-3.8-flash')
    // The old consent had no age confirmation.
    expect(config.consented).toBe(false)
  })

  it('keeps a model per provider and rejects a model of the wrong provider', async () => {
    const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-ai-')), fakeCipher())
    await config.load()
    await config.setModel('qwen3-vl:2b-instruct')
    await expect(config.setModel('gemini-3.8-flash; rm -rf')).rejects.toThrow()
    await config.setProvider('gemini')
    await expect(config.setModel('qwen3-vl:2b-instruct')).rejects.toThrow()
    await config.setModel('gemini-3.5-flash-lite')
    expect(config.model).toBe('gemini-3.5-flash-lite')
    await config.setProvider('ollama')
    expect(config.model).toBe('qwen3-vl:2b-instruct')
  })
})

// ----------------------------------------------------------------- service

async function makeService(opts: { consent?: boolean; key?: string | null; clock?: { t: number }; limits?: object } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
  const config = new AiConfig(dir, fakeCipher())
  await config.load()
  await config.setProvider('gemini')
  if (opts.key !== null) await config.setKey(opts.key ?? VALID_KEY)
  if (opts.consent !== false) await config.setConsent(true)
  const events: AiEvent[] = []
  const clock = opts.clock
  const service = new AiService({
    config,
    makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: fake.url, retry: FAST_RETRY, log: (l) => logs.push(l) }),
    emit: (e) => events.push(e),
    now: clock ? () => clock.t : undefined,
    limits: { minIntervalMs: 0, ...opts.limits }
  })
  const finished = (id: string): Promise<AiEvent> =>
    new Promise((resolve) => {
      const poll = (): void => {
        const end = events.find((e) => e.requestId === id && e.type !== 'delta')
        if (end) resolve(end)
        else setTimeout(poll, 5)
      }
      poll()
    })
  return { service, events, finished, config }
}
const chat = (text = 'What is 2+2?'): AiRequest => ({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }] })
const idOf = (r: ReturnType<AiService['start']>): string => {
  if ('error' in r) throw new Error(r.error.message)
  return r.requestId
}

describe('AI service', () => {
  it('refuses to send notebook content before consent or without a key, without calling the API', async () => {
    const a = await makeService({ consent: false })
    expect(a.service.start(chat())).toEqual({ error: expect.objectContaining({ code: 'consent_required' }) })
    const b = await makeService({ key: null })
    expect(b.service.start(chat())).toEqual({ error: expect.objectContaining({ code: 'no_key' }) })
    expect(fake.requests).toHaveLength(0)
  })

  it('streams a multi-turn chat with an image and uses the chat instructions', async () => {
    const { service, events, finished } = await makeService()
    const request: AiRequest = {
      task: 'chat',
      turns: [
        { role: 'user', parts: [{ text: 'Is this right?' }, { image: { mimeType: 'image/png', data: PIXEL } }] },
        { role: 'model', parts: [{ text: 'Almost.' }] },
        { role: 'user', parts: [{ text: 'Explain the next step' }] }
      ]
    }
    const id = idOf(service.start(request))
    const done = await finished(id)
    expect(done).toMatchObject({ type: 'done', model: 'gemini-3.8-flash' })
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe((done as { text: string }).text)
    const sent = fake.generated().at(-1)!
    expect(sent.body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user'])
    expect(sent.body.systemInstruction.parts[0].text).toMatch(/AI tutor/)
    expect(sent.body.generationConfig.responseMimeType).toBeUndefined()
  })

  it('validates structured answers and rejects malformed ones', async () => {
    const { service, finished } = await makeService()
    const practice: AiRequest = { task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Two easy problems on factoring' }] }] }
    const ok = await finished(idOf(service.start(practice)))
    expect(ok.type).toBe('done')
    expect(parseTaskResult('practice', (ok as { text: string }).text)?.problems).toHaveLength(2)

    fake.reply({ json: { topic: 'x', problems: [{ question: 'no hints' }] } })
    const bad = await finished(idOf(service.start({ ...practice, turns: [{ role: 'user', parts: [{ text: 'again' }] }] })))
    expect(bad).toMatchObject({ type: 'error', error: { code: 'bad_response' } })
  })

  it('allows one request at a time and blocks accidental repeats', async () => {
    const { service, finished } = await makeService()
    fake.reply({ chunks: ['slow'], delayMs: 150 })
    const first = idOf(service.start(chat('one')))
    expect(service.start(chat('two'))).toEqual({ error: expect.objectContaining({ code: 'busy' }) })
    await finished(first)
    expect(service.start(chat('one'))).toEqual({ error: expect.objectContaining({ code: 'duplicate' }) })
    expect(fake.generated()).toHaveLength(1)
  })

  it('keeps under a per-minute budget', async () => {
    const clock = { t: 1_000_000 }
    const { service, finished } = await makeService({ clock, limits: { perMinute: 2 } })
    await finished(idOf(service.start(chat('a'))))
    await finished(idOf(service.start(chat('b'))))
    const third = service.start(chat('c'))
    expect(third).toEqual({ error: expect.objectContaining({ code: 'rate_limited', retryAfter: 60 }) })
    clock.t += 61_000
    await finished(idOf(service.start(chat('c'))))
    expect(fake.generated()).toHaveLength(3)
  })

  it('waits out a rate limit locally instead of calling the API again', async () => {
    const clock = { t: 5_000_000 }
    const { service, finished } = await makeService({ clock })
    fake.reply({ error: errors.perMinute('20s') })
    const failed = await finished(idOf(service.start(chat('a'))))
    expect(failed).toMatchObject({ type: 'error', error: { code: 'rate_limited', retryAfter: 20 } })
    expect(service.status().cooldown).toMatchObject({ reason: 'rate_limited', model: 'gemini-3.8-flash' })
    expect(service.start(chat('b'))).toEqual({ error: expect.objectContaining({ code: 'rate_limited' }) })
    expect(fake.generated()).toHaveLength(1)
    clock.t += 21_000
    expect((await finished(idOf(service.start(chat('b'))))).type).toBe('done')
  })

  it('when the daily free quota runs out, suggests the other free model but never switches by itself', async () => {
    const { service, finished } = await makeService()
    fake.reply({ error: errors.perDay() })
    const failed = await finished(idOf(service.start(chat('a'))))
    expect(failed).toMatchObject({ type: 'error', error: { code: 'daily_quota', suggestModel: 'gemini-3.5-flash-lite' } })
    expect(service.status().model).toBe('gemini-3.8-flash')
    expect(service.start(chat('b'))).toEqual({ error: expect.objectContaining({ code: 'daily_quota' }) })
    // The user chooses Flash-Lite; it works immediately.
    await service.setModel('gemini-3.5-flash-lite')
    expect((await finished(idOf(service.start(chat('b'))))).type).toBe('done')
    expect(fake.generated().map((r) => r.model)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
  })

  it('cancels a running request', async () => {
    const { service, finished } = await makeService()
    fake.reply({ chunks: ['partial'], hang: true })
    const id = idOf(service.start(chat('long')))
    await new Promise((r) => setTimeout(r, 80))
    service.cancel(id)
    expect(await finished(id)).toMatchObject({ type: 'error', error: { code: 'canceled' } })
    expect((await finished(idOf(service.start(chat('next'))))).type).toBe('done')
  })

  it('tests the connection with a tiny request and validates available models', async () => {
    const { service } = await makeService({ consent: false })
    const result = await service.test()
    expect(result).toMatchObject({ ok: true, model: 'gemini-3.8-flash' })
    expect(service.status().models).toEqual([
      { id: 'gemini-3.8-flash', status: 'available', inputTokenLimit: 1000000 },
      { id: 'gemini-3.5-flash-lite', status: 'available' }
    ])
    const sent = fake.requests.filter((r) => r.model)
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/page|notebook/i)
    expect(sent[0]!.body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(64)

    fake.setModels([{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }])
    const missing = await service.test()
    expect(missing).toMatchObject({ ok: false, error: { code: 'model_unavailable', suggestModel: 'gemini-3.5-flash-lite' } })
  })

  it('reports an invalid key from the connection test', async () => {
    const { service } = await makeService({ key: BAD_KEY })
    expect(await service.test()).toMatchObject({ ok: false, error: { code: 'invalid_key' } })
  })
})

describe('request validation', () => {
  it('limits images per request and image size, and requires a user turn last', () => {
    const img = { image: { mimeType: 'image/jpeg' as const, data: PIXEL } }
    expect(aiRequestSchema.safeParse({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'a' }, img, img] }] }).success).toBe(true)
    expect(aiRequestSchema.safeParse({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'a' }, img, img, img] }] }).success).toBe(false)
    expect(aiRequestSchema.safeParse({ task: 'chat', turns: [{ role: 'user', parts: [{ image: { mimeType: 'image/jpeg', data: 'A'.repeat(1_500_000) } }] }] }).success).toBe(false)
    expect(aiRequestSchema.safeParse({ task: 'chat', turns: [{ role: 'model', parts: [{ text: 'a' }] }] }).success).toBe(false)
    expect(aiRequestSchema.safeParse({ task: 'system', turns: [{ role: 'user', parts: [{ text: 'a' }] }] }).success).toBe(false)
  })

  it('checks the shape of API keys', () => {
    expect(apiKeySchema.safeParse(` ${VALID_KEY} `).success).toBe(true)
    expect(apiKeySchema.safeParse('short').success).toBe(false)
    expect(apiKeySchema.safeParse('AIza key with spaces 0123456789').success).toBe(false)
  })

  it('accepts legacy AIza keys and newer AQ. authorization keys, with their dots', () => {
    const legacy = 'AIzaSyD' + 'x'.repeat(28) + '_-9Q' // 39 characters, the usual length
    const ok = [legacy, VALID_KEY, VALID_AQ_KEY, ` ${VALID_AQ_KEY}\n`, 'AQ.' + 'Ab8RN6'.repeat(10), 'AQ.Ab8RN6Lx.Yz-0_1.' + 'q'.repeat(30)]
    for (const k of ok) expect(apiKeySchema.safeParse(k), k).toMatchObject({ success: true, data: k.trim() })
    const bad = [
      'AQ.short',                                 // too short to be a key
      'AQ.' + 'a'.repeat(30) + '.',                // can't end with a dot
      'AQ..' + 'a'.repeat(30),                     // or start its body with one
      'AQ.' + 'a'.repeat(15) + ' ' + 'a'.repeat(15), // no spaces
      'AQ.' + 'a'.repeat(20) + '"' + 'a'.repeat(5),  // no quotes
      'aq.' + 'a'.repeat(30),                      // prefixes are case-sensitive
      'AIza.' + 'a'.repeat(30),                    // no dots in legacy keys
      'auth_tokens/' + 'a'.repeat(30),             // ephemeral tokens work only with the Live API
      'x-goog-api-key: ' + VALID_KEY,              // a whole header line
      'Bearer ' + VALID_AQ_KEY,
      'sk-' + 'a'.repeat(40),                      // another provider's key
      'AQ.' + 'a'.repeat(300)                      // too long
    ]
    for (const k of bad) {
      const r = apiKeySchema.safeParse(k)
      expect(r.success, k).toBe(false)
      if (!r.success) expect(r.error.issues[0]?.message).toMatch(/starts with “AIza” or “AQ\.”/)
    }
  })

  it('hides keys in any text that may be shown or logged', () => {
    const text = `API key not valid: ${VALID_AQ_KEY} (also ${VALID_KEY})`
    const out = redactKeys(text)
    expect(out).not.toContain(VALID_AQ_KEY)
    expect(out).not.toContain(VALID_KEY)
    expect(out).toContain(`[key …${VALID_AQ_KEY.slice(-4)}]`)
    expect(redactKeys('Quota exceeded for model gemini-3.8-flash.')).toBe('Quota exceeded for model gemini-3.8-flash.')
  })
})

describe('newer AQ. Gemini keys', () => {
  it('are saved encrypted and reload unchanged; only the last 4 characters are shown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const config = new AiConfig(dir, fakeCipher(), 'linux')
    await config.load()
    expect(await config.setKey(apiKeySchema.parse(` ${VALID_AQ_KEY} `))).toBe('encrypted')
    for (const f of await readdir(dir)) {
      const raw = await readFile(join(dir, f), 'utf8')
      expect(raw).not.toContain(VALID_AQ_KEY)
      expect(raw).not.toContain(VALID_AQ_KEY.slice(3, 20))
    }
    const again = new AiConfig(dir, fakeCipher(), 'linux')
    await again.load()
    expect(again.apiKey).toBe(VALID_AQ_KEY)
    expect(again.keyHint).toBe(VALID_AQ_KEY.slice(-4))
  })

  it('reach Google through the official SDK in the x-goog-api-key header, dots and all', async () => {
    const models = await provider(VALID_AQ_KEY).listModels()
    expect(models.length).toBeGreaterThan(0)
    fake.reply({ chunks: ['ok'] })
    const chunks = await collect(provider(VALID_AQ_KEY).stream(req()))
    expect(chunks.at(-1)).toMatchObject({ type: 'end' })
    expect(fake.requests.at(-1)!.key).toBe(VALID_AQ_KEY)
  })

  it('saving and Google accepting the key are separate: a well-formed key Google rejects is saved, and the test says Google refused it', async () => {
    const rejected = 'AQ.Ab8RN6LnotKnownToGoogle.0123456789abcdef'
    const { service } = await makeService({ key: rejected })
    expect(service.status()).toMatchObject({ hasKey: true, keyHint: rejected.slice(-4) })
    const result = await service.test()
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_key' } })
    expect(JSON.stringify(result)).not.toContain(rejected)
  })

  it('never show a key that Google echoes in an error message', () => {
    const message = JSON.stringify({ error: { code: 403, message: `Method doesn't allow unregistered callers. Key ${VALID_AQ_KEY} is restricted.`, status: 'PERMISSION_DENIED' } })
    for (const e of [new ApiError({ message, status: 403 }), new Error(`fetch failed for key=${VALID_KEY}`)]) {
      const err = classifyError(e, { aborted: false, timedOut: false })
      expect(err.message).not.toContain(VALID_AQ_KEY)
      expect(err.message).not.toContain(VALID_KEY)
    }
    expect(classifyError(new ApiError({ message, status: 403 }), { aborted: false, timedOut: false }).code).toBe('invalid_key')
  })
})

describe('builds without Gemini (public, all ages)', () => {
  const make = async (provider: 'gemini' | 'cloud' = 'gemini') => {
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const config = new AiConfig(dir, fakeCipher(), { builtInCloudUrl: 'https://ai.example.test', defaultProvider: 'cloud' })
    await config.load()
    await config.setProvider(provider)
    const service = new AiService({ config, geminiEnabled: false, makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: fake.url }), emit: () => undefined })
    return { config, service }
  }

  it("don't offer Gemini, switch to it, or save a key for it", async () => {
    const { service } = await make('cloud')
    expect(service.status().geminiAvailable).toBe(false)
    expect((await service.setProvider('gemini')).provider).toBe('cloud')
    expect((await service.setKey(VALID_KEY)).hasKey).toBe(false)
  })

  it('move settings saved with Gemini to the cloud AI, without calling Google', async () => {
    const { service } = await make('gemini')
    const before = fake.requests.length
    await service.ensureAllowedProvider()
    expect(service.status().provider).toBe('cloud')
    expect(fake.requests.length).toBe(before)
  })
})

// ------------------------------------------------- Gemini errors and retries

describe('Gemini request pipeline: keys, Google errors, retries', () => {
  const google = (status: number, message: string, googleStatus: string, details: object[] = []) => ({ status, body: { error: { code: status, message, status: googleStatus, details } } })
  const reason = (r: string) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: r, domain: 'googleapis.com' })

  it.each([VALID_KEY, VALID_AQ_KEY])('sends %s to Google unchanged, only in the x-goog-api-key header', async (key) => {
    await collect(provider(key).stream(req()))
    await provider(key).listModels()
    expect(fake.requests.length).toBeGreaterThanOrEqual(2)
    for (const r of fake.requests) {
      expect(r.key).toBe(key)
      expect(r.path).not.toContain(key)
      expect(JSON.stringify(r.body ?? {})).not.toContain(key)
    }
  })

  it.each([
    ['400 bad key', google(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', [reason('API_KEY_INVALID')]), 'invalid_key', /not valid/],
    ['400 expired key', google(400, 'API key expired. Please renew the API key.', 'INVALID_ARGUMENT', [reason('API_KEY_EXPIRED')]), 'invalid_key', /expired/],
    ['400 region', google(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION'), 'bad_request', /region/],
    ['400 precondition', google(400, 'Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.', 'FAILED_PRECONDITION'), 'permission_denied', /billing/],
    ['400 bad argument', google(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT'), 'bad_request', /Invalid JSON payload/],
    ['401', google(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED', [reason('ACCESS_TOKEN_TYPE_UNSUPPORTED')]), 'invalid_key', /authenticate/],
    ['403 unregistered', google(403, "Method doesn't allow unregistered callers (callers without established identity).", 'PERMISSION_DENIED'), 'invalid_key', /recognise/],
    ['403 API disabled', google(403, 'Generative Language API has not been used in project 123 before or it is disabled.', 'PERMISSION_DENIED', [reason('SERVICE_DISABLED')]), 'permission_denied', /turned off/],
    ['403 key restricted', google(403, 'Requests to this API generativelanguage.googleapis.com method are blocked.', 'PERMISSION_DENIED', [reason('API_KEY_SERVICE_BLOCKED')]), 'permission_denied', /restrictions/],
    ['403 leaked key', google(403, 'Your API key was reported as leaked. Please use another API key.', 'PERMISSION_DENIED'), 'invalid_key', /leaked/],
    ['403 other', google(403, 'The caller does not have permission', 'PERMISSION_DENIED'), 'permission_denied', /does not have permission/],
    ['404 model', errors.notFound(), 'model_unavailable', /not available/],
    ['429 per minute', errors.perMinute('17s'), 'rate_limited', /per minute/],
    ['429 daily', errors.perDay(), 'daily_quota', /today/],
    ['429 no free tier', errors.noFreeTier(), 'not_free', /no free quota/],
    ['500', google(500, 'An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting', 'INTERNAL'), 'server', /internal error \(500\)/],
    ['502', { status: 502, body: { error: { code: 502, message: 'Bad Gateway', status: 'Bad Gateway' } } }, 'server', /bad gateway error \(502\)/],
    ['503', errors.overloaded(), 'server', /overloaded or temporarily unavailable \(503\)/],
    ['504', google(504, 'Deadline expired before operation could complete.', 'DEADLINE_EXCEEDED'), 'server', /timed out \(504\)/]
  ])('%s: its own message, with Google’s real answer kept as detail', async (_name, error, code, text) => {
    fake.reply({ error })
    const e = await errorOf(collect(provider(VALID_KEY, { attempts: 1 }).stream(req())))
    expect(e.code).toBe(code)
    expect(e.message).toMatch(text)
    expect(e.message).not.toMatch(/\{/)
    expect(e.detail).toMatch(new RegExp(`^HTTP ${error.status}\\b`))
    expect(e.detail).toContain((error.body as { error: { message: string } }).error.message.slice(0, 30))
    expect(e.toJSON().detail).toBe(e.detail)
  })

  it('distinct statuses no longer collapse into one generic message', () => {
    const msg = (status: number) => classifyError(new ApiError({ message: JSON.stringify(google(status, 'x', 'S').body), status }), { aborted: false, timedOut: false }).message
    expect(new Set([500, 502, 503, 504].map(msg)).size).toBe(4)
  })

  it('retries a 503 with backoff and delivers the answer when Google recovers', async () => {
    fake.reply({ error: errors.overloaded() })
    fake.reply({ text: 'Recovered answer' })
    const chunks = await collect(provider().stream(req()))
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('')).toBe('Recovered answer')
    expect(fake.generated()).toHaveLength(2)
    expect(logs.some((l) => /attempt 1 of 3 failed \(HTTP 503 UNAVAILABLE: The model is overloaded/.test(l))).toBe(true)
  })

  it.each([500, 502, 504])('retries %i too', async (status) => {
    fake.reply({ error: google(status, 'transient', 'X') })
    await collect(provider().stream(req()))
    expect(fake.generated()).toHaveLength(2)
  })

  it('gives up after the last attempt and says how many were made', async () => {
    for (let i = 0; i < 3; i++) fake.reply({ error: errors.overloaded() })
    const e = await errorOf(collect(provider().stream(req())))
    expect(e.code).toBe('server')
    expect(fake.generated()).toHaveLength(DEFAULT_RETRY.attempts)
    expect(e.detail).toMatch(/HTTP 503 UNAVAILABLE: The model is overloaded.*\(3 attempts\)$/)
    expect(logs.at(-1)).toMatch(/failed after 3 attempts: HTTP 503/)
  })

  it.each([
    ['invalid key', errors.invalidKey()],
    ['401', google(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED')],
    ['403', google(403, 'Permission denied', 'PERMISSION_DENIED', [reason('SERVICE_DISABLED')])],
    ['404', errors.notFound()],
    ['per-minute quota', errors.perMinute('17s')],
    ['daily quota', errors.perDay()],
    ['no free tier', errors.noFreeTier()],
    ['bad request', google(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT')]
  ])('never retries %s (one request only)', async (_name, error) => {
    fake.reply({ error })
    fake.reply({ text: 'should not be fetched' })
    const e = await errorOf(collect(provider().stream(req())))
    expect(e.retryable).toBe(false)
    expect(fake.generated()).toHaveLength(1)
    fake.requests.length = 0
    await collect(provider().stream(req())) // drain the queued answer for the next test
  })

  it('does not retry a rejected key when listing models either', async () => {
    const e = await errorOf(provider(BAD_KEY).listModels())
    expect(e.code).toBe('invalid_key')
    expect(fake.requests).toHaveLength(1)
  })

  it('retries a dropped connection but not a missing network', () => {
    const reset = classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), { aborted: false, timedOut: false })
    const dns = classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), { aborted: false, timedOut: false })
    expect([reset.code, reset.retryable]).toEqual(['network', true])
    expect([dns.code, dns.retryable]).toEqual(['network', false])
    expect(classifyError(new Error('x'), { aborted: false, timedOut: true }).retryable).toBe(false)
  })

  it('backs off exponentially with jitter, capped', () => {
    const policy = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 8000 }
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(a, policy, () => 1))).toEqual([1000, 2000, 4000, 8000, 8000])
    expect(backoffDelay(1, policy, () => 0)).toBe(500)
  })

  it('stops waiting at once when the user presses Stop during a backoff', async () => {
    fake.reply({ error: errors.overloaded() })
    const controller = new AbortController()
    const slow = provider(VALID_KEY, { attempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 })
    const started = Date.now()
    const pending = errorOf(collect(slow.stream(req(), controller.signal)))
    setTimeout(() => controller.abort(), 50)
    const e = await pending
    expect(e.code).toBe('canceled')
    expect(Date.now() - started).toBeLessThan(5000)
    expect(fake.generated()).toHaveLength(1)
  })

  it('does not retry an error that arrives after text was shown (no duplicated answer)', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Partial ' }] }, index: 0 }] })}\r\n\r\n`)
      setTimeout(() => res.end(`data: ${JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } })}\r\n\r\n`), 20)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    let hits = 0
    server.on('request', () => hits++)
    try {
      const port = (server.address() as { port: number }).port
      const p = new GeminiProvider({ apiKey: VALID_KEY, baseUrl: `http://127.0.0.1:${port}`, retry: FAST_RETRY, log: (l) => logs.push(l) })
      const got: string[] = []
      const e = await errorOf(
        (async () => {
          for await (const c of p.stream(req())) if (c.type === 'text') got.push(c.text)
        })()
      )
      expect(got).toEqual(['Partial '])
      expect(e.code).toBe('server')
      expect(e.detail).toMatch(/^HTTP 503 UNAVAILABLE/)
      expect(hits).toBe(1)
    } finally {
      server.close()
    }
  })

  it.each([VALID_KEY, VALID_AQ_KEY])('keeps %s out of messages, details and logs even when Google echoes it', async (key) => {
    for (let i = 0; i < 3; i++) fake.reply({ error: google(503, `Backend unavailable for key ${key}`, 'UNAVAILABLE') })
    const e = await errorOf(collect(provider(key).stream(req())))
    const surfaces = [e.message, e.detail ?? '', JSON.stringify(e.toJSON()), ...logs]
    for (const s of surfaces) {
      expect(s).not.toContain(key)
      expect(s).not.toContain(key.slice(0, 20))
    }
    expect(e.detail).toContain(`[key …${key.slice(-4)}]`)
  })

  it('redacts keys from unexpected errors before they reach the window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkling-ai-'))
    const config = new AiConfig(dir, fakeCipher())
    await config.load()
    await config.setProvider('gemini')
    await config.setKey(VALID_AQ_KEY)
    await config.setConsent(true)
    const events: AiEvent[] = []
    const service = new AiService({
      config,
      makeProvider: () => ({
        id: 'gemini',
        listModels: async () => [],
        // eslint-disable-next-line require-yield
        stream: async function* () {
          throw new Error(`boom with ${VALID_AQ_KEY}`)
        }
      }),
      emit: (e) => events.push(e),
      limits: { minIntervalMs: 0 }
    })
    idOf(service.start(chat()))
    await new Promise((r) => setTimeout(r, 30))
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(JSON.stringify(err)).not.toContain(VALID_AQ_KEY)
  })

  it('offers the other free model when Google is overloaded', async () => {
    const { service, finished } = await makeService()
    await service.test()
    for (let i = 0; i < 3; i++) fake.reply({ error: errors.overloaded() })
    const end = await finished(idOf(service.start(chat())))
    expect(end.type).toBe('error')
    if (end.type === 'error') {
      expect(end.error.code).toBe('server')
      expect(end.error.suggestModel).toBe('gemini-3.5-flash-lite')
      expect(end.error.detail).toMatch(/HTTP 503 UNAVAILABLE/)
    }
  })
})
