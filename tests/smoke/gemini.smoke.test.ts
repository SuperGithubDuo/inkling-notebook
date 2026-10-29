/**
 * Optional smoke test against the REAL Gemini API with your own free-tier key.
 * Skipped unless GEMINI_API_KEY is set. It goes through Inkling's own
 * AiService + GeminiProvider (the code the app's main process runs), and
 * covers the Phase 4 flows end to end:
 *
 *   - models: lists the models the key can use and reports which of Inkling's
 *     two supported models are offered to it;
 *   - chat: a streamed answer, a follow-up that needs the earlier turns,
 *     cancelling a running answer, and a rejected key;
 *   - handwriting: reads tests/fixtures/handwriting-linear.png, explains the
 *     mistake in chat, and returns a markup that becomes valid canvas commands;
 *   - practice: two problems with hints, then one right and one wrong answer
 *     checked by the model.
 *
 * About 11 small requests, paced by AiService's own limiter (≤ 8 a minute), so
 * it takes a minute or two and stays inside the free tier's per-minute limits.
 * Use a key from a Google Cloud project WITHOUT billing, so nothing is charged.
 *
 *   macOS / Linux:   read -rs GEMINI_API_KEY && export GEMINI_API_KEY && npm run test:smoke
 *   PowerShell:      $env:GEMINI_API_KEY = Read-Host 'Gemini key'; npm run test:smoke
 *   Lighter model:   also set GEMINI_MODEL=gemini-3.5-flash-lite
 *
 * The key is read from the environment only and never written anywhere.
 *
 * `npm run test:smoke:fake` runs the same test against the local fake Gemini
 * server (tests/support/fakeGemini.mjs) to check the test itself; there only the
 * structure is asserted, since the fake's answers are canned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GEMINI_MODELS, modelIdSchema, type AiError, type AiEvent, type AiRequest, type AiTurn } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { planAnnotations } from '../../src/renderer/src/ai/annotate'
import { buildTransaction } from '../../src/renderer/src/canvas/commands'
import { createPageDoc } from '../../src/shared/factory'
import { startFakeGemini, VALID_KEY, type FakeGemini } from '../support/fakeGemini.mjs'

const useFake = process.env.INKLING_SMOKE_FAKE === '1'
const key = useFake ? VALID_KEY : process.env.GEMINI_API_KEY
const model = modelIdSchema.parse(process.env.GEMINI_MODEL ?? 'gemini-3.8-flash')
/** Content checks only make sense against the real model. */
const real = !useFake && !process.env.INKLING_SMOKE_BASE_URL

const memoryCipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => Buffer.alloc(0),
  decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
}

const log = (line: string): void => console.log(`  ${line}`)

describe.skipIf(!key)(`${useFake ? 'fake' : 'real'} Gemini API (${model})`, () => {
  let fake: FakeGemini | null = null
  let baseUrl: string | undefined
  let service: AiService
  const events: AiEvent[] = []

  const makeService = async (apiKey: string): Promise<AiService> => {
    const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-smoke-')), memoryCipher)
    await config.setKey(apiKey) // memory only: the cipher above cannot encrypt, so nothing is saved
    await config.setModel(model)
    await config.setConsent(true)
    return new AiService({ config, makeProvider: (k) => new GeminiProvider({ apiKey: k, baseUrl }), emit: (e) => events.push(e), limits: { minIntervalMs: 4000 } })
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Starts a request, waiting out short rate limits (ours or Google's). */
  const start = async (request: AiRequest): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      const started = service.start(request)
      if (!('error' in started)) return started.requestId
      const wait = started.error.retryAfter
      if (started.error.code !== 'rate_limited' || wait === undefined || wait > 65 || attempt > 4) throw new Error(`${started.error.code}: ${started.error.message}`)
      await sleep(wait * 1000 + 300)
    }
  }

  const settle = async (id: string): Promise<{ text: string } | { error: AiError }> => {
    for (;;) {
      const end = events.find((e) => e.requestId === id && e.type !== 'delta')
      if (end?.type === 'done') return { text: end.text }
      if (end?.type === 'error') return { error: end.error }
      await sleep(50)
    }
  }

  /** Runs a request to completion; retries once on a per-minute 429 from Google. */
  const run = async (request: AiRequest): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      const result = await settle(await start(request))
      if ('text' in result) return result.text
      if (result.error.code === 'rate_limited' && attempt < 2 && (result.error.retryAfter ?? 99) <= 65) {
        await sleep((result.error.retryAfter ?? 30) * 1000 + 500)
        continue
      }
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
  }

  const user = (text: string): AiTurn => ({ role: 'user', parts: [{ text }] })

  beforeAll(async () => {
    if (useFake) {
      fake = await startFakeGemini()
      baseUrl = fake.url
    } else {
      baseUrl = process.env.INKLING_SMOKE_BASE_URL
    }
    service = await makeService(key!)
  })
  afterAll(async () => {
    await fake?.close()
  })

  it('lists models and connects with the selected one', { timeout: 60_000 }, async () => {
    const test = await service.test()
    if (!test.ok) throw new Error(`${test.error.code}: ${test.error.message}`)
    for (const m of GEMINI_MODELS) log(`model ${m.id}: ${test.models.find((x) => x.id === m.id)?.status ?? 'unknown'}`)
    expect(test.models.find((m) => m.id === model)?.status).toBe('available')
    log(`connected in ${test.latencyMs} ms`)
  })

  it('streams a chat answer and keeps the context for a follow-up', { timeout: 180_000 }, async () => {
    const q1 = user('Solve 3x + 5 = 20 for x. Reply in one short sentence; use $...$ for maths.')
    const id = await start({ task: 'chat', turns: [q1] })
    const first = await settle(id)
    if ('error' in first) throw new Error(`${first.error.code}: ${first.error.message}`)
    const deltas = events.filter((e) => e.requestId === id && e.type === 'delta').length
    expect(deltas).toBeGreaterThan(0)
    if (real) expect(first.text.replace(/[\s$]/g, '')).toMatch(/x=5(?!\d)/)
    log(`chat (${deltas} streamed chunks): ${first.text.trim()}`)

    const follow = await run({
      task: 'chat',
      turns: [q1, { role: 'model', parts: [{ text: first.text }] }, user('Now double your answer. Reply with just the number.')]
    })
    if (real) expect(follow).toMatch(/\b10\b/)
    log(`follow-up: ${follow.trim()}`)
  })

  it('cancels a running answer and stays usable', { timeout: 180_000 }, async () => {
    fake?.reply({ chunks: ['A long ', 'answer ', 'that ', 'never ', 'ends'], chunkDelayMs: 400 })
    const id = await start({ task: 'chat', turns: [user('Explain, in about 400 words, why dividing both sides of an equation by the same non-zero number keeps it true.')] })
    while (!events.some((e) => e.requestId === id)) await sleep(20)
    service.cancel(id)
    const end = await settle(id)
    // A very fast model can finish before the cancel lands; that is not a failure of cancelling.
    if ('error' in end) expect(end.error.code).toBe('canceled')
    log(`cancel: ${'error' in end ? `stopped (${end.error.code})` : 'answer had already finished'}`)
    expect(await run({ task: 'chat', turns: [user('What is 7 × 8? Reply with just the number.')] })).toMatch(real ? /56/ : /./)
  })

  it('reports a rejected key as invalid_key', { timeout: 60_000 }, async () => {
    const bad = await makeService('AIzaSyInklingSmokeTestDeliberatelyInvalid0')
    const result = await bad.test()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_key')
      log(`bad key: ${result.error.message}`)
    }
  })

  it('reads handwriting, explains the mistake and marks it up on a page', { timeout: 180_000 }, async () => {
    const image = (await readFile(join(import.meta.dirname, '../fixtures/handwriting-linear.png'))).toString('base64')
    const imagePart = { image: { mimeType: 'image/png' as const, data: image } }

    const explained = await run({
      task: 'chat',
      turns: [{ role: 'user', parts: [{ text: 'Here is my handwritten working. Is it right? If not, explain the mistake briefly.' }, imagePart] }]
    })
    if (real) expect(explained).toMatch(/\b8\b|\b4\b/)
    log(`explain: ${explained.trim().replace(/\n+/g, ' ').slice(0, 300)}`)

    const markup = await run({ task: 'annotate', turns: [{ role: 'user', parts: [{ text: 'Check my work in the image and mark it up.' }, imagePart] }] })
    const set = parseTaskResult('annotate', markup)
    expect(set, markup).not.toBeNull()
    expect(set!.transcription.replace(/\s/g, '')).toMatch(/2x\+3=11/)
    expect(set!.annotations.length).toBeGreaterThan(0)
    expect(set!.annotations.some((a) => a.kind === 'cross' || a.kind === 'correction' || a.kind === 'circle' || a.kind === 'underline')).toBe(true)
    const page = createPageDoc('nb', 'pg')
    const placed = planAnnotations(set!.annotations, { region: { x: 100, y: 100, width: 460, height: 260 }, page })
    const tx = buildTransaction(page, placed.flatMap((p) => p.commands), { author: 'ai' })
    expect(tx.created.length).toBeGreaterThan(0)
    log(`read: ${set!.transcription.replace(/\n/g, ' | ')}`)
    log(`marks: ${set!.annotations.map((a) => a.kind + (a.text ? ` "${a.text}"` : '')).join(', ')} → ${tx.created.length} canvas objects`)
  })

  it('writes practice problems with hints and checks answers', { timeout: 240_000 }, async () => {
    const practice = parseTaskResult('practice', await run({ task: 'practice', turns: [user('Create 2 practice problems at easy difficulty on: solving linear equations.')] }))
    expect(practice).not.toBeNull()
    expect(practice!.problems.length).toBeGreaterThanOrEqual(1)
    if (real) expect(practice!.problems.length).toBe(2)
    for (const p of practice!.problems) expect(p.hints.length).toBeGreaterThanOrEqual(1)
    const problem = practice!.problems[0]!
    log(`practice: ${practice!.problems.map((p) => p.question).join(' / ')}`)
    log(`hints for #1: ${problem.hints.join(' → ')}`)

    // The same prompt the app's Practice view sends for a typed answer.
    const check = async (answer: string) =>
      parseTaskResult(
        'check',
        await run({ task: 'check', turns: [{ role: 'user', parts: [{ text: `Practice problem:\n${problem.question}\n\nExpected final answer: ${problem.answer}` }, { text: `Student answer (typed): ${answer}` }] }] })
      )
    const right = await check(problem.answer.replace(/\$/g, ''))
    expect(right).not.toBeNull()
    if (real) expect(right!.verdict).toBe('correct')
    const wrong = await check('x = 12345')
    expect(wrong).not.toBeNull()
    if (real) expect(wrong!.verdict).not.toBe('correct')
    log(`check: right answer → ${right!.verdict}; wrong answer → ${wrong!.verdict} (${wrong!.feedback.slice(0, 120)})`)
  })
})
