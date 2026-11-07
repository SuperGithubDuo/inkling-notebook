/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Usage data structurally excludes notebook content, on both paths (DeepInfra for notice-4 apps,
 * Workers AI for older apps): requests carry unguessable canaries in the question, the notes, an
 * earlier answer, a practice topic and alongside an image; then EVERYTHING the server keeps or
 * reports (every stored ledger record, /admin/summary) must be numbers and short identifiers only
 * (beta-server/scripts/privacy-check.mjs), and no canary may appear there or in any log line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canaryRequests, checkUsageReport, makeCanaries } from '../../beta-server/scripts/privacy-check.mjs'
import { PRESETS } from '../../beta-server/src/provider'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { FAKE_KEY, startFakeOpenAi, type FakeOpenAi } from '../support/fakeOpenAi.mjs'
import { CLOUD_MODEL_PUBLIC } from '../../src/shared/ai'

let server: BetaServer | undefined
let fake: FakeOpenAi | undefined
afterEach(async () => {
  await server?.close()
  await fake?.close()
  server = undefined
  fake = undefined
  vi.restoreAllMocks()
})

/** Every console line the server writes during the test. */
function captureLogs(): string[] {
  const lines: string[] = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
  return lines
}

async function send(body: unknown, notice: string | null, n: number): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-inkling-install': 'inst_' + String(n).padStart(32, 'p') }
  if (notice) headers['x-inkling-notice'] = notice
  const r = await fetch(`${server!.url}/v1/tutor`, { method: 'POST', headers, body: JSON.stringify(body) })
  await r.text()
  return r.status
}

function storedRecords(): unknown {
  return Object.fromEntries([...server!.storage.store.entries()])
}

describe('usage data holds no notebook content (structural)', () => {
  it('the validator accepts identifiers and numbers, and rejects free text and canaries', () => {
    expect(checkUsageReport({ model: 'Qwen/Qwen3.8-27B', day: '2026-11-07', tasks: { chat: 2 }, neurons: 1.5, paused: false })).toEqual([])
    expect(checkUsageReport({ note: 'my lab partner' })).toHaveLength(1)
    expect(checkUsageReport({ 'two words': 1 })).toHaveLength(1)
    expect(checkUsageReport({ h: 'abcCANARY123' }, ['CANARY123'])).toHaveLength(1)
    expect(checkUsageReport({ img: 'x'.repeat(200) })).toHaveLength(1)
  })

  it('DeepInfra path (notice 4): stored records, the summary and the logs', async () => {
    const logs = captureLogs()
    fake = await startFakeOpenAi()
    server = await startBetaServer({
      provider: 'deepinfra',
      model: PRESETS.deepinfra.model,
      publicModel: CLOUD_MODEL_PUBLIC,
      minNoticeVersion: 4,
      rates: { unit: 'usd', inputPerM: 200_000, outputPerM: 2_500_000, cachedInputPerM: 50_000 },
      globalDailyNeurons: 250_000,
      installDailyNeurons: 10_000,
      networkDailyNeurons: 50_000,
      typicalNeuronsPerAnswer: 800,
      limits: { unit: 'usd', globalMonthly: 5_000_000 },
      makeAi: (mod: any) => mod.provider.externalProvider({ id: 'deepinfra', apiKey: FAKE_KEY, baseUrl: fake!.url, sleep: async () => undefined })
    })
    const k = makeCanaries()
    const canaries = Object.values(k)
    let n = 0
    for (const body of canaryRequests(k)) {
      fake.model.reply({ text: '{"problems":[{"problem":"1/2 + 1/4","answer":"3/4","hints":["Common denominator"],"solution":"3/4"}]}', usage: { inputTokens: 700, outputTokens: 120 } })
      expect(await send(body, '4', n++)).toBe(200)
      await server.settled()
    }
    // An error path too: the provider refuses.
    fake.fail({ status: 500, body: { error: { message: `upstream echo ${k.question}` } } })
    fake.fail({ status: 500, body: { error: { message: `upstream echo ${k.question}` } } })
    fake.fail({ status: 500, body: { error: { message: `upstream echo ${k.question}` } } })
    await send(canaryRequests(k)[0], '4', n++)
    await server.settled()
    // The provider did receive the content (the request is real) …
    expect(JSON.stringify(fake.completions().map((c) => c.body))).toContain(k.note)
    // … but nothing the server keeps, reports or logs does.
    const summary = (await server.admin('GET', '/admin/summary')).body
    expect(checkUsageReport(summary, canaries)).toEqual([])
    expect(checkUsageReport(storedRecords(), canaries)).toEqual([])
    expect(logs.filter((l) => canaries.some((c) => l.includes(c)))).toEqual([])
    expect(summary.answers).toBeGreaterThanOrEqual(2)
    // Not vacuous: per-installation, per-network, day and month records were written and checked.
    expect(Object.keys(storedRecords() as object).filter((key) => /^[inm]/.test(key)).length).toBeGreaterThanOrEqual(3)
  })

  it('Workers AI path (older apps on the bridge, and the rollback): the same', async () => {
    const logs = captureLogs()
    server = await startBetaServer({ textModel: { model: '@cf/google/gemma-4-26b-a4b-it', rates: { inputPerM: 9091, outputPerM: 27273 }, tasks: ['practice'] } })
    const k = makeCanaries()
    const canaries = Object.values(k)
    let n = 0
    for (const body of canaryRequests(k)) {
      expect(await send(body, null, n++)).toBe(200)
      await server.settled()
    }
    const summary = (await server.admin('GET', '/admin/summary')).body
    expect(checkUsageReport(summary, canaries)).toEqual([])
    expect(checkUsageReport(storedRecords(), canaries)).toEqual([])
    expect(logs.filter((l) => canaries.some((c) => l.includes(c)))).toEqual([])
    // Today's routing on this path: practice on Gemma, chat on Qwen.
    expect(Object.keys(summary.models.today).sort()).toEqual(['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b'])
  })
})
