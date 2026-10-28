/**
 * Optional smoke test against the REAL Gemini API with your own key.
 * Skipped unless GEMINI_API_KEY is set. Makes 4 small requests (well within
 * free-tier limits): list models, a chat answer, a multimodal markup of a
 * handwriting image, and a practice set.
 *
 *   GEMINI_API_KEY=… npm run test:smoke
 *   GEMINI_API_KEY=… GEMINI_MODEL=gemini-3.5-flash-lite npm run test:smoke
 *
 * Use a key from a Google Cloud project WITHOUT billing so this stays free.
 * The key is read from the environment only; it is never written anywhere.
 * (INKLING_SMOKE_BASE_URL can point it at the fake server to check this test itself.)
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { modelIdSchema, type AiEvent, type AiRequest } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { planAnnotations } from '../../src/renderer/src/ai/annotate'
import { buildTransaction } from '../../src/renderer/src/canvas/commands'
import { createPageDoc } from '../../src/shared/factory'

const key = process.env.GEMINI_API_KEY
const model = modelIdSchema.parse(process.env.GEMINI_MODEL ?? 'gemini-3.8-flash')
const memoryCipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => Buffer.alloc(0),
  decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
}

describe.skipIf(!key)(`real Gemini API (${model})`, () => {
  const setup = async () => {
    const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-smoke-')), memoryCipher)
    await config.setKey(key!) // memory only: the cipher above cannot encrypt, so nothing is saved
    await config.setModel(model)
    await config.setConsent(true)
    const events: AiEvent[] = []
    const service = new AiService({ config, makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: process.env.INKLING_SMOKE_BASE_URL }), emit: (e) => events.push(e), limits: { minIntervalMs: 4000 } })
    const run = async (request: AiRequest): Promise<string> => {
      let started = service.start(request)
      while ('error' in started && started.error.code === 'rate_limited' && (started.error.retryAfter ?? 99) < 10) {
        await new Promise((r) => setTimeout(r, (started as { error: { retryAfter?: number } }).error.retryAfter! * 1000 + 200))
        started = service.start(request)
      }
      if ('error' in started) throw new Error(`${started.error.code}: ${started.error.message}`)
      const id = started.requestId
      for (;;) {
        const end = events.find((e) => e.requestId === id && e.type !== 'delta')
        if (end?.type === 'done') return end.text
        if (end?.type === 'error') throw new Error(`${end.error.code}: ${end.error.message}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    return { service, run, events }
  }

  it('connects, streams a chat answer, marks up handwriting and writes practice problems', { timeout: 180_000 }, async () => {
    const { service, run, events } = await setup()

    const test = await service.test()
    if (!test.ok) throw new Error(`${test.error.code}: ${test.error.message}`)
    expect(test.models.find((m) => m.id === model)?.status).toBe('available')

    const answer = await run({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'In one short sentence: what is 7 × 8? Use $...$ for maths.' }] }] })
    expect(answer).toMatch(/56/)
    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(0)

    const image = (await readFile(join(import.meta.dirname, '../fixtures/handwriting-linear.png'))).toString('base64')
    const markup = await run({
      task: 'annotate',
      turns: [{ role: 'user', parts: [{ text: 'Check my work in the image and mark it up.' }, { image: { mimeType: 'image/png', data: image } }] }]
    })
    const set = parseTaskResult('annotate', markup)
    expect(set, markup).not.toBeNull()
    expect(set!.transcription.replace(/\s/g, '')).toMatch(/2x\+3=11/)
    expect(set!.annotations.some((a) => a.kind === 'cross' || a.kind === 'correction' || a.kind === 'circle' || a.kind === 'underline')).toBe(true)
    const page = createPageDoc('nb', 'pg')
    const placed = planAnnotations(set!.annotations, { region: { x: 100, y: 100, width: 460, height: 260 }, page })
    expect(() => buildTransaction(page, placed.flatMap((p) => p.commands), { author: 'ai' })).not.toThrow()

    const practice = parseTaskResult('practice', await run({ task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create 2 practice problems at easy difficulty on: solving linear equations.' }] }] }))
    expect(practice?.problems.length).toBeGreaterThanOrEqual(1)
    for (const p of practice!.problems) expect(p.hints.length).toBeGreaterThanOrEqual(1)

    console.log(`\n  Gemini ${model}: connected in ${test.latencyMs} ms\n  chat: ${answer.trim()}\n  read: ${set!.transcription.replace(/\n/g, ' | ')}\n  marks: ${set!.annotations.map((a) => a.kind + (a.text ? ` "${a.text}"` : '')).join(', ')}\n  practice: ${practice!.problems.map((p) => p.question).join(' / ')}`)
  })
})
