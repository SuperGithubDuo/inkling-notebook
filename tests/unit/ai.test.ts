import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiProvider, classifyError, secondsUntilPacificMidnight } from '../../src/main/ai/gemini'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { ProviderError, type ProviderChunk } from '../../src/main/ai/provider'
import { aiRequestSchema, apiKeySchema, type AiEvent, type AiRequest } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { BAD_KEY, VALID_KEY, errors, startFakeGemini, type FakeGemini } from '../support/fakeGemini.mjs'

let fake: FakeGemini
beforeAll(async () => {
  fake = await startFakeGemini()
})
afterAll(() => fake.close())
beforeEach(() => {
  fake.requests.length = 0
  fake.setModels([
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
  ])
})

const provider = (key = VALID_KEY): GeminiProvider => new GeminiProvider({ apiKey: key, baseUrl: fake.url })
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
    const e = await errorOf(collect(provider().stream(req())))
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
    const offline = new GeminiProvider({ apiKey: VALID_KEY, baseUrl: 'http://127.0.0.1:9' })
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
    makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: fake.url }),
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
    // Newer Google keys use an `AQ.` prefix with a dot; both formats must pass.
    expect(apiKeySchema.safeParse('AQ.Ab8RN6Kx_fake-0123456789abcdefGHIJ').success).toBe(true)
    expect(apiKeySchema.safeParse('AIzaSyFakeLegacyKey_0123456789abcdef').success).toBe(true)
    expect(apiKeySchema.safeParse('AQ.Ab8RN6Kx\nfake0123456789abcdef').success).toBe(false)
  })
})
