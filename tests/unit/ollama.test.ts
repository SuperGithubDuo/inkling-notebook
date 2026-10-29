import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaProvider, isLoopbackUrl } from '../../src/main/ai/ollama'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { qwenBoxesToBox2d, taskSpec } from '../../src/main/ai/prompts'
import { ProviderError, type ProviderChunk } from '../../src/main/ai/provider'
import { parseTaskResult } from '../../src/shared/tutor'
import { aiReady, type AiEvent, type AiRequest } from '../../src/shared/ai'
import { DEFAULT_TAGS, startFakeOllama, type FakeOllama } from '../support/fakeOllama.mjs'

let fake: FakeOllama
beforeAll(async () => {
  fake = await startFakeOllama()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.requests.length = 0
  fake.setTags(DEFAULT_TAGS)
})

const IMAGE = Buffer.from('fake-png-bytes').toString('base64')
const collect = async (it: AsyncIterable<ProviderChunk>): Promise<{ text: string; chunks: number; end?: ProviderChunk }> => {
  let text = ''
  let chunks = 0
  let end: ProviderChunk | undefined
  for await (const c of it) {
    if (c.type === 'text') {
      text += c.text
      chunks++
    } else end = c
  }
  return { text, chunks, end }
}
const errorOf = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p
  } catch (err) {
    return err as ProviderError
  }
  throw new Error('expected an error')
}

describe('Ollama provider (against a fake Ollama API)', () => {
  it('only talks to this computer', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true)
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:11434')).toBe(true)
    expect(isLoopbackUrl('http://192.168.1.20:11434')).toBe(false)
    expect(isLoopbackUrl('https://ollama.example.com')).toBe(false)
    expect(() => new OllamaProvider({ baseUrl: 'http://10.0.0.5:11434' })).toThrow(/this computer/)
    expect(new OllamaProvider().baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('discovers installed models and which can read images', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url })
    expect(await p.version()).toBe('0.40.13')
    const models = await p.listModels()
    expect(models.find((m) => m.id === 'qwen3-vl:4b')).toMatchObject({ vision: true, thinking: true, canGenerate: true, sizeBytes: 3_300_000_000 })
    expect(models.find((m) => m.id === 'llama3.2:3b')).toMatchObject({ vision: false, canGenerate: true })
    expect(models.find((m) => m.id === 'nomic-embed-text:latest')?.canGenerate).toBe(false)
    // Capabilities are cached per model.
    await p.listModels()
    expect(fake.requests.filter((r) => r.path === '/api/show').length).toBe(4)
  })

  it('streams a chat with history and images, the system prompt, and thinking turned off', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url })
    const out = await collect(
      p.stream({
        model: 'qwen3-vl:4b',
        system: 'You are a tutor.',
        turns: [
          { role: 'user', parts: [{ text: 'Check this' }, { image: { mimeType: 'image/png', data: IMAGE } }] },
          { role: 'model', parts: [{ text: 'It looks right.' }] },
          { role: 'user', parts: [{ text: 'Why?' }] }
        ],
        maxOutputTokens: 500,
        temperature: 0.3
      })
    )
    expect(out.chunks).toBe(3)
    expect(out.text).toContain('$x = -2$ or $x = -3$')
    expect(out.end).toMatchObject({ type: 'end', usage: { inputTokens: 300, outputTokens: 60 }, finishReason: 'STOP' })
    const body = fake.chats().at(-1)!.body
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(body.messages[1].images).toEqual([IMAGE])
    expect(body.messages[1].content).toBe('Check this')
    expect(body.stream).toBe(true)
    expect(body.think).toBe(false)
    expect(body.options).toMatchObject({ num_predict: 500, temperature: 0.3, num_ctx: 8192 })
    expect(body.format).toBeUndefined()
  })

  it('omits the thinking switch for models that have no thinking mode', async () => {
    fake.setTags([{ name: 'llava:7b', capabilities: ['completion', 'vision'] }])
    const p = new OllamaProvider({ baseUrl: fake.url })
    await collect(p.stream({ model: 'llava:7b', system: 's', turns: [{ role: 'user', parts: [{ text: 'hi' }] }], maxOutputTokens: 50 }))
    expect('think' in fake.chats().at(-1)!.body).toBe(false)
  })

  it('sends the task JSON schema as the output format', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url })
    const spec = taskSpec('practice', 'ollama')
    const out = await collect(p.stream({ model: 'qwen3-vl:4b', system: spec.system, turns: [{ role: 'user', parts: [{ text: 'Create 2 practice problems' }] }], jsonSchema: spec.jsonSchema, maxOutputTokens: 2000 }))
    expect(fake.chats().at(-1)!.body.format).toEqual(spec.jsonSchema)
    expect(parseTaskResult('practice', out.text)?.problems).toHaveLength(2)
  })

  it('explains a stopped server, a missing model, a text-only model, memory and mid-stream errors', async () => {
    const offline = new OllamaProvider({ baseUrl: 'http://127.0.0.1:9' })
    expect((await errorOf(offline.version())).code).toBe('offline')
    expect((await errorOf(collect(offline.stream({ model: 'qwen3-vl:4b', system: 's', turns: [{ role: 'user', parts: [{ text: 'x' }] }], maxOutputTokens: 5 })))).code).toBe('offline')

    const p = new OllamaProvider({ baseUrl: fake.url })
    const req = (model: string, image = false) =>
      collect(p.stream({ model, system: 's', turns: [{ role: 'user', parts: [{ text: 'x' }, ...(image ? [{ image: { mimeType: 'image/png' as const, data: IMAGE } }] : [])] }], maxOutputTokens: 5 }))

    const missing = await errorOf(req('qwen3-vl:8b'))
    expect(missing.code).toBe('model_unavailable')
    expect(missing.message).toContain('ollama pull qwen3-vl:8b')

    const textOnly = await errorOf(req('llama3.2:3b', true))
    expect(textOnly.code).toBe('model_unavailable')
    expect(textOnly.message).toMatch(/can't read images/)

    fake.reply({ error: 'model requires more system memory (5.1 GiB) than is available (3.2 GiB)', status: 500 })
    const memory = await errorOf(req('qwen3-vl:4b'))
    expect(memory.code).toBe('server')
    expect(memory.message).toMatch(/more memory/)

    fake.reply({ chunks: ['partial '], midStreamError: 'llama runner process has terminated: exit status 2' })
    expect((await errorOf(req('qwen3-vl:4b'))).code).toBe('server')
  })

  it('cancels a running answer', async () => {
    fake.reply({ chunks: ['one ', 'two '], chunkDelayMs: 50, hang: true })
    const p = new OllamaProvider({ baseUrl: fake.url })
    const controller = new AbortController()
    const stream = p.stream({ model: 'qwen3-vl:4b', system: 's', turns: [{ role: 'user', parts: [{ text: 'long' }] }], maxOutputTokens: 5 }, controller.signal)
    const err = errorOf(
      (async () => {
        for await (const c of stream) if (c.type === 'text') controller.abort()
      })()
    )
    expect((await err).code).toBe('canceled')
  })
})

describe('Qwen boxes', () => {
  it('converts bbox_2d [x1, y1, x2, y2] to the shared box_2d [ymin, xmin, ymax, xmax]', () => {
    const out = JSON.parse(
      qwenBoxesToBox2d(
        JSON.stringify({
          transcription: 't',
          summary: 's',
          annotations: [
            { kind: 'cross', bbox_2d: [60, 700, 500, 960] },
            { kind: 'circle', bbox_2d: [500, 960, 60, 700] }, // reversed corners
            { kind: 'note', bbox_2d: [-20, 10, 1200, 30], text: 'n' }, // out of range
            { kind: 'check', bbox_2d: 'nonsense' } // unplaceable: dropped
          ]
        })
      )
    )
    expect(out.annotations).toEqual([
      { kind: 'cross', box_2d: [700, 60, 960, 500] },
      { kind: 'circle', box_2d: [700, 60, 960, 500] },
      { kind: 'note', box_2d: [10, 0, 30, 1000], text: 'n' }
    ])
    expect(parseTaskResult('annotate', JSON.stringify(out))).not.toBeNull()
  })

  it('asks Qwen for its native box format and Gemini for its own', () => {
    const local = taskSpec('annotate', 'ollama')
    expect(local.system).toContain('[x1, y1, x2, y2]')
    expect(JSON.stringify(local.jsonSchema)).toContain('bbox_2d')
    expect(local.normalize).toBeTypeOf('function')
    const cloud = taskSpec('annotate', 'gemini')
    expect(cloud.system).toContain('[ymin, xmin, ymax, xmax]')
    expect(cloud.normalize).toBeUndefined()
    expect(taskSpec('chat', 'ollama')).toBe(taskSpec('chat', 'gemini'))
  })
})

// ----------------------------------------------------------------- service

const memoryCipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => Buffer.alloc(0),
  decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
}

async function makeService(baseUrl = fake.url) {
  const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-ollama-')), memoryCipher)
  await config.load()
  const events: AiEvent[] = []
  const service = new AiService({
    config,
    makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: 'http://127.0.0.1:9' }),
    makeLocalProvider: () => new OllamaProvider({ baseUrl }),
    emit: (e) => events.push(e),
    limits: { minIntervalMs: 0 }
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
  return { service, config, events, finished }
}
const idOf = (r: ReturnType<AiService['start']>): string => {
  if ('error' in r) throw new Error(r.error.message)
  return r.requestId
}

describe('AI service on local Ollama', () => {
  it('is the default: local, no key, no consent prompt, and status reports the server and models', async () => {
    const { service } = await makeService()
    const status = await service.freshStatus()
    expect(status).toMatchObject({ provider: 'ollama', local: true, needsKey: false, consented: true, model: 'qwen3-vl:4b' })
    expect(status.ollama).toMatchObject({ running: true, version: '0.40.13', url: fake.url })
    expect(status.models).toEqual([
      { id: 'qwen3-vl:4b', status: 'available', sizeBytes: 3_300_000_000, vision: true },
      { id: 'qwen3-vl:2b', status: 'available', sizeBytes: 1_900_000_000, vision: true },
      { id: 'qwen3-vl:8b', status: 'missing' }
    ])
    expect(aiReady(status)).toBe(true)
  })

  it('lists other installed vision models, but not text-only or embedding ones', async () => {
    fake.setTags([...DEFAULT_TAGS, { name: 'llava:7b', size: 4_700_000_000, capabilities: ['completion', 'vision'] }])
    const { service } = await makeService()
    const ids = (await service.freshStatus()).models.map((m) => m.id)
    expect(ids).toEqual(['qwen3-vl:4b', 'qwen3-vl:2b', 'qwen3-vl:8b', 'llava:7b'])
  })

  it('reports a stopped server and a missing model with what to do', async () => {
    const down = await makeService('http://127.0.0.1:9')
    const status = await down.service.freshStatus()
    expect(status.ollama.running).toBe(false)
    expect(aiReady(status)).toBe(false)
    const test = await down.service.test()
    expect(!test.ok && test.error.code).toBe('offline')

    const { service } = await makeService()
    await service.setModel('qwen3-vl:8b')
    const missing = await service.test()
    expect(!missing.ok && missing.error).toMatchObject({ code: 'model_unavailable', message: expect.stringContaining('ollama pull qwen3-vl:8b') })
    expect(aiReady(service.status())).toBe(false)
  })

  it('tests the connection without sending notebook content', async () => {
    const { service } = await makeService()
    const result = await service.test()
    expect(result.ok).toBe(true)
    const chat = fake.requests.filter((r) => r.path === '/api/chat')
    expect(chat).toHaveLength(1)
    expect(chat[0]!.body.messages.at(-1).content).toBe('Connection test')
  })

  it('streams a chat answer and reports timings', async () => {
    const { service, events, finished } = await makeService()
    const id = idOf(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'Solve it' }, { image: { mimeType: 'image/jpeg', data: IMAGE } }] }] }))
    const end = await finished(id)
    expect(events.filter((e) => e.requestId === id && e.type === 'delta')).toHaveLength(3)
    expect(end).toMatchObject({ type: 'done', model: 'qwen3-vl:4b', usage: { inputTokens: 300, outputTokens: 60, firstTokenMs: expect.any(Number), totalMs: expect.any(Number) } })
  })

  it('returns a validated annotation set in the shared box format', async () => {
    const { service, finished } = await makeService()
    const end = await finished(idOf(service.start({ task: 'annotate', turns: [{ role: 'user', parts: [{ text: 'Mark up' }, { image: { mimeType: 'image/jpeg', data: IMAGE } }] }] })))
    if (end.type !== 'done') throw new Error(JSON.stringify(end))
    const set = parseTaskResult('annotate', end.text)!
    expect(set.annotations.map((a) => a.box_2d)).toEqual([
      [40, 60, 300, 900],
      [700, 60, 960, 500],
      [700, 60, 960, 500]
    ])
    expect(fake.chats().at(-1)!.body.format.properties.annotations.items.required).toEqual(['kind', 'bbox_2d'])
  })

  it('rejects structured answers that do not validate', async () => {
    const { service, finished } = await makeService()
    fake.reply({ json: { topic: 'x', problems: [{ question: 'q' }] } })
    const end = await finished(idOf(service.start({ task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create practice problems' }] }] })))
    expect(end).toMatchObject({ type: 'error', error: { code: 'bad_response', message: expect.stringContaining('The local model') } })
    fake.reply({ text: '{"verdict": "correct", "transcr', doneReason: 'length' })
    const cut = await finished(idOf(service.start({ task: 'check', turns: [{ role: 'user', parts: [{ text: 'Student answer: 3' }] }] })))
    expect(cut).toMatchObject({ type: 'error', error: { code: 'bad_response', message: expect.stringContaining('cut off') } })
  })

  it('has no per-minute pacing locally, but still one request at a time and no accidental repeats', async () => {
    const { service, finished } = await makeService()
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = idOf(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: `question ${i}` }] }] }))
      ids.push(id)
      await finished(id)
    }
    expect(ids).toHaveLength(10)
    fake.reply({ chunks: ['slow'], delayMs: 200 })
    const a = service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'again' }] }] })
    expect(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'other' }] }] })).toMatchObject({ error: { code: 'busy' } })
    await finished(idOf(a))
    expect(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'again' }] }] })).toMatchObject({ error: { code: 'duplicate' } })
  })

  it('cancels, and suggests the smaller installed model when a bigger one runs out of memory', async () => {
    const { service, finished } = await makeService()
    fake.reply({ chunks: ['a', 'b'], chunkDelayMs: 50, hang: true })
    const id = idOf(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'long one' }] }] }))
    await new Promise((r) => setTimeout(r, 30))
    service.cancel(id)
    expect(await finished(id)).toMatchObject({ type: 'error', error: { code: 'canceled' } })

    await service.freshStatus()
    fake.reply({ error: 'model requires more system memory (5 GiB) than is available (3 GiB)', status: 500 })
    const end = await finished(idOf(service.start({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'memory' }] }] })))
    expect(end).toMatchObject({ type: 'error', error: { code: 'server', suggestModel: 'qwen3-vl:2b' } })
  })

  it('switches between providers, keeping Gemini behind its key and consent', async () => {
    const { service } = await makeService()
    const gemini = await service.setProvider('gemini')
    expect(gemini).toMatchObject({ provider: 'gemini', local: false, needsKey: true, hasKey: false, consented: false, model: 'gemini-3.8-flash' })
    expect(aiReady(gemini)).toBe(false)
    const req: AiRequest = { task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    expect(service.start(req)).toMatchObject({ error: { code: 'consent_required' } })
    const back = await service.setProvider('ollama')
    expect(back).toMatchObject({ provider: 'ollama', consented: true, model: 'qwen3-vl:4b' })
  })
})
