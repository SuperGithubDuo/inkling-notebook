/**
 * Text-only routing (beta-server/src/route.ts): requests with any handwriting
 * context stay on the main model (Qwen 3.8 27B), text-only requests may go to
 * the text model (Gemma 4 26B A4B), and the rule is OFF unless configured.
 * Covers the rule itself, the app's own follow-up turns (buildTurns), the real
 * handler behind a fake Workers AI, and the per-model counts for the operator.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chooseModel, needsMainModel, textModelFrom, IMAGE_OMITTED } from '../../beta-server/src/route'
import { Ledger, type LedgerLimits } from '../../beta-server/src/ledger'
import { neuronsFor } from '../../beta-server/src/upstream'
import { buildTurns, HISTORY_ENTRIES, type ThreadEntry } from '../../src/renderer/src/ai/turns'
import { startBetaServer, RATES, type BetaServer } from '../support/fakeBeta.mjs'
import { CLOUD_MODEL, type AiPart, type AiRequest, type AiTurn } from '../../src/shared/ai'

const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const GEMMA_RATES = { inputPerM: 9091, outputPerM: 27273 }
const MAIN = { model: CLOUD_MODEL, rates: RATES, reasoningEffort: 'low', disableThinking: true }
const TEXT = { model: GEMMA, rates: GEMMA_RATES }

const image: AiPart = { image: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' } }
const text = (t: string): AiPart => ({ text: t })
const ask = (...parts: AiPart[]): AiTurn[] => [{ role: 'user', parts }]
const entry = (role: 'user' | 'model', parts: AiPart[]): ThreadEntry => ({ role, parts, ok: true })

describe('routing rule', () => {
  it('is off without a text model: everything goes to the main model', () => {
    for (const task of ['chat', 'practice', 'check', 'annotate'] as const) expect(chooseModel(task, ask(text('hi')), MAIN, null)).toMatchObject({ route: 'image', model: CLOUD_MODEL, reasoningEffort: 'low' })
  })

  it('sends text-only chat, practice and typed answer checks to the text model, thinking off', () => {
    for (const task of ['chat', 'practice', 'check'] as const) {
      expect(chooseModel(task, ask(text('<note>Calvin cycle</note> Where does it happen?')), MAIN, TEXT)).toEqual({ route: 'text', model: GEMMA, rates: GEMMA_RATES, reasoningEffort: '', disableThinking: true })
    }
  })

  it('keeps markup on the main model, even without an image', () => {
    expect(chooseModel('annotate', ask(text('Mark it up.')), MAIN, TEXT).model).toBe(CLOUD_MODEL)
  })

  it('keeps anything with an image on the main model: current question or an earlier turn', () => {
    expect(needsMainModel('chat', ask(text('Check my work'), image))).toBe(true)
    expect(needsMainModel('check', ask(text('My answer:'), image))).toBe(true)
    const followUp: AiTurn[] = [{ role: 'user', parts: [text('Hint?'), image] }, { role: 'model', parts: [text('Look at the signs.')] }, { role: 'user', parts: [text('Why negative?')] }]
    expect(chooseModel('chat', followUp, MAIN, TEXT).model).toBe(CLOUD_MODEL)
  })

  it('treats the app’s "(image omitted)" placeholder as handwriting context', () => {
    const turns: AiTurn[] = [{ role: 'user', parts: [text(IMAGE_OMITTED)] }, { role: 'model', parts: [text('…')] }, { role: 'user', parts: [text('And now?')] }]
    expect(needsMainModel('chat', turns)).toBe(true)
  })

  it('keeps a conversation at the app’s history limit on the main model (an image may have been cut)', () => {
    const long: AiTurn[] = []
    for (let i = 0; i < HISTORY_ENTRIES / 2; i++) long.push({ role: 'user', parts: [text(`q${i}`)] }, { role: 'model', parts: [text(`a${i}`)] })
    long.push({ role: 'user', parts: [text('next')] })
    expect(needsMainModel('chat', long)).toBe(true)
    expect(needsMainModel('chat', long.slice(2))).toBe(false)
  })

  describe('with the app’s own follow-up turns (buildTurns)', () => {
    it('a typed follow-up to a handwriting question carries the image, so it stays on the main model', () => {
      const history = [entry('user', [text('Check my work'), image]), entry('model', [text('Sign mistake.')])]
      const turns = buildTurns(history, [text('Why are the roots negative?')])
      expect(turns.some((t) => t.parts.some((p) => 'image' in p))).toBe(true)
      expect(chooseModel('chat', turns, MAIN, TEXT).model).toBe(CLOUD_MODEL)
    })

    it('every follow-up stays on the main model until the image leaves the history, and then the history is full', () => {
      // The image is asked about first; then typed follow-ups, one after another.
      const history: ThreadEntry[] = [entry('user', [text('Check my work'), image]), entry('model', [text('a0')])]
      for (let i = 1; i <= 8; i++) {
        const turns = buildTurns(history, [text(`follow-up ${i}`)])
        expect(chooseModel('chat', turns, MAIN, TEXT).model, `follow-up ${i}`).toBe(CLOUD_MODEL)
        history.push(entry('user', [text(`follow-up ${i}`)]), entry('model', [text(`a${i}`)]))
      }
    })

    // buildTurns drops an earlier image only when the request keeps another one (the current
    // question's, or the most recent earlier one) or when the exchange aged out (full history).
    it('a new image question after an earlier one: the older image is dropped, the current one keeps it on the main model', () => {
      const history = [entry('user', [text('Page 1'), image]), entry('model', [text('a')])]
      const turns = buildTurns(history, [text('Page 2'), image])
      expect(turns.flatMap((t) => t.parts).filter((p) => 'image' in p)).toHaveLength(1)
      expect(chooseModel('chat', turns, MAIN, TEXT).model).toBe(CLOUD_MODEL)
    })

    it('several earlier images: the most recent is kept, so a typed follow-up stays on the main model', () => {
      const history = [entry('user', [text('Page 1'), image]), entry('model', [text('a')]), entry('user', [text('Page 2'), image]), entry('model', [text('b')])]
      const turns = buildTurns(history, [text('What about the second line?')])
      expect(turns.flatMap((t) => t.parts).filter((p) => 'image' in p)).toHaveLength(1)
      expect(chooseModel('chat', turns, MAIN, TEXT).model).toBe(CLOUD_MODEL)
    })

    it('an image-only earlier question becomes the placeholder when a newer image is sent', () => {
      const history = [entry('user', [image]), entry('model', [text('a')])]
      const turns = buildTurns(history, [text('And this one?'), image])
      expect(JSON.stringify(turns)).toContain(IMAGE_OMITTED)
      expect(chooseModel('chat', turns, MAIN, TEXT).model).toBe(CLOUD_MODEL)
    })

    it('an image exchange that aged out leaves a full history, so the follow-up stays on the main model', () => {
      const history: ThreadEntry[] = [entry('user', [text('Check my work'), image]), entry('model', [text('a0')])]
      for (let i = 1; i <= HISTORY_ENTRIES / 2; i++) history.push(entry('user', [text(`q${i}`)]), entry('model', [text(`a${i}`)]))
      const turns = buildTurns(history, [text('one more')])
      expect(turns.flatMap((t) => t.parts).some((p) => 'image' in p)).toBe(false)
      expect(chooseModel('chat', turns, MAIN, TEXT).model).toBe(CLOUD_MODEL)
    })

    it('a typed conversation about notes uses the text model', () => {
      const history = [entry('user', [text('<note>Calvin cycle: stroma</note> Where?')]), entry('model', [text('In the stroma.')])]
      expect(chooseModel('chat', buildTurns(history, [text('And the light reactions?')]), MAIN, TEXT).model).toBe(GEMMA)
    })
  })

  describe('settings (textModelFrom)', () => {
    it('is off unless the model and both prices are set', () => {
      expect(textModelFrom({}, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: '' , TEXT_INPUT_NEURONS_PER_M: '9091', TEXT_OUTPUT_NEURONS_PER_M: '27273' }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: GEMMA }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: GEMMA, TEXT_INPUT_NEURONS_PER_M: '9091', TEXT_OUTPUT_NEURONS_PER_M: '0' }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: GEMMA, TEXT_INPUT_NEURONS_PER_M: 'x', TEXT_OUTPUT_NEURONS_PER_M: '27273' }, CLOUD_MODEL)).toBeNull()
    })
    it('accepts only a Workers AI model id, different from the main model', () => {
      expect(textModelFrom({ MODEL_TEXT: 'gpt-4o', TEXT_INPUT_NEURONS_PER_M: '1', TEXT_OUTPUT_NEURONS_PER_M: '1' }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: 'https://example.com/m', TEXT_INPUT_NEURONS_PER_M: '1', TEXT_OUTPUT_NEURONS_PER_M: '1' }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: CLOUD_MODEL, TEXT_INPUT_NEURONS_PER_M: '1', TEXT_OUTPUT_NEURONS_PER_M: '1' }, CLOUD_MODEL)).toBeNull()
      expect(textModelFrom({ MODEL_TEXT: ` ${GEMMA} `, TEXT_INPUT_NEURONS_PER_M: '9091', TEXT_OUTPUT_NEURONS_PER_M: '27273' }, CLOUD_MODEL)).toEqual(TEXT)
    })
    it('the shipped wrangler.jsonc leaves it off', async () => {
      const raw = await readFile(join(import.meta.dirname, '../../beta-server/wrangler.jsonc'), 'utf8')
      expect(raw).toMatch(/"MODEL_TEXT":\s*""/)
    })
  })
})

// --------------------------------------------------------- real handler

const INSTALL = 'inst_' + 'R'.repeat(32)
async function post(server: BetaServer, body: AiRequest, install = INSTALL): Promise<{ status: number; events: Array<{ event: string; data: any }>; json?: any }> {
  const res = await fetch(`${server.url}/v1/tutor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': install, 'x-test-ip': '203.0.113.9' }, body: JSON.stringify(body) })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events: [], json: await res.json().catch(() => null) }
  const events = (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }))
  return { status: res.status, events }
}

describe('AI server with text-only routing', () => {
  let server: BetaServer
  afterEach(async () => server?.close())
  const fixture = async (): Promise<AiPart> => ({ image: { mimeType: 'image/jpeg', data: (await readFile(join(import.meta.dirname, '../fixtures/handwriting/scenario-a.jpg'))).toString('base64') } })

  it('flag off: every request reaches the main model with today’s settings (no change)', async () => {
    server = await startBetaServer()
    await post(server, { task: 'chat', turns: ask(text('Where does the Calvin cycle happen?')) })
    await post(server, { task: 'chat', turns: ask(text('Check my work'), await fixture()) })
    await post(server, { task: 'practice', turns: ask(text('Two easy problems.')) })
    expect(server.ai.calls.map((c) => c.model)).toEqual([CLOUD_MODEL, CLOUD_MODEL, CLOUD_MODEL])
    for (const c of server.ai.calls) expect(c.inputs).toMatchObject({ reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } })
  })

  it('flag on: text-only → text model (thinking off, no reasoning effort), handwriting → main model', async () => {
    server = await startBetaServer({ textModel: TEXT })
    await post(server, { task: 'chat', turns: ask(text('<note>Calvin cycle: stroma</note> Where?')) })
    await post(server, { task: 'chat', turns: ask(text('Check my work'), await fixture()) })
    await post(server, { task: 'annotate', turns: ask(text('Check my work in the image and mark it up.'), await fixture()) })
    await post(server, { task: 'practice', turns: ask(text('Two easy problems.')) })
    await post(server, { task: 'check', turns: ask(text('Solve 2x+3=11. Expected x=4. Student answer (typed): x = 4')) })
    expect(server.ai.calls.map((c) => [c.task, c.model])).toEqual([
      ['chat', GEMMA],
      ['chat', CLOUD_MODEL],
      ['annotate', CLOUD_MODEL],
      ['practice', GEMMA],
      ['check', GEMMA]
    ])
    const gemma = server.ai.calls.filter((c) => c.model === GEMMA)
    for (const c of gemma) {
      expect(c.inputs.reasoning_effort).toBeUndefined()
      expect(c.inputs.chat_template_kwargs).toEqual({ enable_thinking: false })
    }
    for (const c of server.ai.calls.filter((c) => c.model === CLOUD_MODEL)) expect(c.inputs.reasoning_effort).toBe('low')
    // Same instructions, schema and token caps whichever model answers.
    expect(gemma[0]!.inputs.messages[0]).toEqual(server.ai.calls[1]!.inputs.messages[0])
  })

  it('charges the text model at its own price, against the same limits', async () => {
    server = await startBetaServer({ textModel: TEXT })
    server.ai.reply({ text: 'In the stroma.', usage: { inputTokens: 400, outputTokens: 50 } })
    const r = await post(server, { task: 'chat', turns: ask(text('Where?')) })
    const done = r.events.at(-1)!
    expect(done.event).toBe('done')
    const expected = neuronsFor({ inputTokens: 400, outputTokens: 50 }, GEMMA_RATES)
    expect(done.data.neurons).toBeCloseTo(expected, 1)
    expect(done.data.quota.installUsed).toBe(Math.round(expected))
    expect(done.data.quota.installLimit).toBe(900)
  })

  it('no fallback: a failed text-model call is reported once and never retried on the main model', async () => {
    server = await startBetaServer({ textModel: TEXT })
    server.ai.reply({ error: '3040: Capacity temporarily exceeded, please try again.' })
    const r = await post(server, { task: 'chat', turns: ask(text('Where?')) })
    expect(r.status).toBe(503)
    expect(server.ai.calls.map((c) => c.model)).toEqual([GEMMA])
  })

  it('a typed follow-up to a handwriting answer, as the app sends it, stays on the main model', async () => {
    server = await startBetaServer({ textModel: TEXT })
    const img = await fixture()
    const history = [entry('user', [text('Give me a hint for the next step.'), img]), entry('model', [text('Look at the signs.')])]
    await post(server, { task: 'chat', turns: buildTurns(history, [text('Why are the roots negative?')]) })
    expect(server.ai.calls[0]!.model).toBe(CLOUD_MODEL)
  })

  it('the operator summary counts requests per model: image vs text, tasks, Neurons, errors; no content', async () => {
    server = await startBetaServer({ textModel: TEXT })
    server.ai.reply({ text: 'a', usage: { inputTokens: 400, outputTokens: 50 } })
    await post(server, { task: 'chat', turns: ask(text('secret question about my notes')) })
    server.ai.reply({ text: 'b', usage: { inputTokens: 1000, outputTokens: 200 } })
    await post(server, { task: 'chat', turns: ask(text('Check my work'), await fixture()) })
    server.ai.reply({ error: '3040: Capacity temporarily exceeded' })
    await post(server, { task: 'practice', turns: ask(text('Two problems')) })
    await server.settled()
    const s = (await server.admin('GET', '/admin/summary')).body
    const g = s.models.today[GEMMA]
    const q = s.models.today[CLOUD_MODEL]
    expect(g).toMatchObject({ requests: 2, image: 0, text: 2, routes: { text: 2 }, tasks: { chat: 1, practice: 1 }, errors: 1, errorKinds: { capacity: 1 } })
    expect(q).toMatchObject({ requests: 1, image: 1, text: 0, routes: { image: 1 }, tasks: { chat: 1 }, errors: 0 })
    expect(g.neurons).toBeCloseTo(neuronsFor({ inputTokens: 400, outputTokens: 50 }, GEMMA_RATES), 1)
    expect(q.neurons).toBeCloseTo(neuronsFor({ inputTokens: 1000, outputTokens: 200 }, RATES), 1)
    expect(s.models.estimatedCapacity).toBe(Math.floor(9000 / ((g.neurons + q.neurons) / 2)))
    expect(JSON.stringify(s)).not.toMatch(/secret question|Check my work|inst_/)
  })
})

describe('per-model counts in the ledger', () => {
  const limits: LedgerLimits = { globalDailyNeurons: 9000, installDailyNeurons: 900, networkDailyNeurons: 2700, installPerMinute: 6, networkPerMinute: 20, installConcurrent: 1, networkConcurrent: 4, globalConcurrent: 12, reservationTtlMs: 600_000, typicalNeuronsPerAnswer: 90 }
  const storage = () => {
    const map = new Map<string, unknown>()
    return { map, get: async <T,>(k: string) => structuredClone(map.get(k)) as T | undefined, put: async (k: string, v: unknown) => void map.set(k, structuredClone(v)), delete: async (k: string) => void map.delete(k), list: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)) }
  }

  it('start empty, and keep the previous UTC day’s counts after midnight', async () => {
    let t = Date.UTC(2026, 10, 4, 23, 50)
    const s = storage()
    const ledger = new Ledger(s, limits, () => t)
    expect((await ledger.summary()).models).toEqual({ today: {}, previous: null, estimatedCapacity: null })
    await ledger.record({ model: GEMMA, route: 'text', task: 'chat', image: false, neurons: 8 })
    await ledger.record({ model: CLOUD_MODEL, route: 'image', task: 'annotate', image: true, neurons: 124 })
    t = Date.UTC(2026, 10, 5, 0, 10)
    const next = await ledger.summary()
    expect(next.models.today).toEqual({})
    expect(next.models.previous?.day).toBe('2026-11-04')
    expect(next.models.previous?.models[GEMMA]).toMatchObject({ requests: 1, text: 1, neurons: 8 })
    expect(next.models.previous?.models[CLOUD_MODEL]).toMatchObject({ requests: 1, image: 1, tasks: { annotate: 1 } })
  })
})
