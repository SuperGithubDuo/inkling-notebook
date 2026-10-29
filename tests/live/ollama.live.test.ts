/**
 * Optional live test against a REAL local model in Ollama — no mocks.
 *
 *   ollama pull qwen3-vl:4b-instruct        # once, ~3.3 GB
 *   npm run test:live              # Ollama must be running on 127.0.0.1:11434
 *   INKLING_LIVE_MODEL=qwen3-vl:2b-instruct npm run test:live
 *
 * Skipped (not failed) when Ollama isn't running or the model isn't installed.
 * Runs the handwriting scenarios through Inkling's own AiService +
 * OllamaProvider, with the same task instructions, JSON schemas, context
 * format and validation the app uses, and the handwriting images the app
 * actually sends (tests/fixtures/handwriting/, captured by ollama.e2e.mjs):
 *
 *   A  algebra with a sign mistake: x² + 5x + 6 = 0 → (x + 2)(x + 3) = 0 → x = 2, 3
 *   B  correct algebra: 2x + 3 = 11 → 2x = 8 → x = 4
 *   C  a free-body diagram (W, N, F, f)
 *   D  a question about a rich-text note
 *   E  a question about imported PDF text
 *   P  practice problems with hints, and answer checking
 *
 * Each check is a soft expectation, so one wrong answer doesn't hide the
 * rest. Every answer, timing and check result is written to
 * test-results/live-ollama-<model>.md (and .json) as evidence.
 */
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaProvider } from '../../src/main/ai/ollama'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OLLAMA_DEFAULT_URL, type AiEvent, type AiRequest } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { registerScenarios, type Run } from './scenarios'

const url = process.env.INKLING_LIVE_OLLAMA_URL ?? OLLAMA_DEFAULT_URL
const model = process.env.INKLING_LIVE_MODEL ?? 'qwen3-vl:4b-instruct'
const root = join(import.meta.dirname, '../..')

async function probe(): Promise<{ ok: boolean; why: string; version?: string }> {
  const p = new OllamaProvider({ baseUrl: url })
  try {
    const version = await p.version()
    const models = await p.listModels()
    const m = models.find((x) => x.id === model)
    if (!m) return { ok: false, why: `${model} is not installed (ollama pull ${model})` }
    if (m.vision === false) return { ok: false, why: `${model} cannot read images` }
    return { ok: true, why: '', version }
  } catch (err) {
    return { ok: false, why: (err as Error).message }
  }
}
const available = await probe()
if (!available.ok) console.log(`\n  Live Ollama tests skipped: ${available.why}\n`)

const memoryCipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => Buffer.alloc(0),
  decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
}

const runs: Run[] = []

describe.skipIf(!available.ok)(`live local model ${model}`, () => {
  let service: AiService
  const events: AiEvent[] = []

  beforeAll(async () => {
    const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-live-')), memoryCipher)
    await config.load()
    await config.setModel(model)
    service = new AiService({
      config,
      makeProvider: (k) => new GeminiProvider({ apiKey: k, baseUrl: 'http://127.0.0.1:9' }),
      makeLocalProvider: () => new OllamaProvider({ baseUrl: url }),
      emit: (e) => events.push(e),
      limits: { duplicateWindowMs: 0 }
    })
    // Load the model once so the first scenario's time isn't mostly loading.
    const warm = await service.test()
    console.log(`  ${model} on Ollama ${available.version}: ${warm.ok ? `loaded and answered in ${(warm.latencyMs / 1000).toFixed(1)} s` : warm.error.message}`)
  }, 900_000)

  afterAll(async () => {
    await mkdir(join(root, 'test-results'), { recursive: true })
    const base = join(root, 'test-results', `live-ollama-${model.replace(/[^a-z0-9.-]+/gi, '_')}`)
    await writeFile(`${base}.json`, JSON.stringify({ model, ollama: available.version, url, at: new Date().toISOString(), runs }, null, 2))
    await writeFile(`${base}.md`, report())
    console.log(`\n  Report: ${base}.md`)
  })

  const run = async (scenario: string, request: AiRequest): Promise<Run> => {
    const started = Date.now()
    const r = service.start(request)
    if ('error' in r) throw new Error(r.error.message)
    let end: AiEvent | undefined
    while (!(end = events.find((e) => e.requestId === r.requestId && e.type !== 'delta'))) await new Promise((res) => setTimeout(res, 50))
    const chunks = events.filter((e) => e.requestId === r.requestId && e.type === 'delta').length
    const result: Run = {
      scenario,
      task: request.task,
      ok: end.type === 'done',
      text: end.type === 'done' ? end.text : '',
      error: end.type === 'error' ? `${end.error.code}: ${end.error.message}` : undefined,
      chunks,
      totalMs: end.type === 'done' ? (end.usage.totalMs ?? Date.now() - started) : Date.now() - started,
      firstTokenMs: end.type === 'done' ? end.usage.firstTokenMs : undefined,
      inputTokens: end.type === 'done' ? end.usage.inputTokens : undefined,
      outputTokens: end.type === 'done' ? end.usage.outputTokens : undefined,
      validated: request.task === 'chat' ? undefined : end.type === 'done' && parseTaskResult(request.task, end.text) !== null,
      checks: []
    }
    runs.push(result)
    console.log(`  [${scenario}/${request.task}] ${result.ok ? 'ok' : result.error} in ${(result.totalMs / 1000).toFixed(1)} s`)
    return result
  }
  const check = (r: Run, name: string, pass: boolean, detail?: string): void => {
    r.checks.push({ name, pass, detail })
    expect.soft(pass, `${r.scenario}/${r.task}: ${name}${detail ? ` — ${detail}` : ''}`).toBe(true)
  }
  registerScenarios({ run, check })
})

function report(): string {
  const s = (ms?: number): string => (ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`)
  const lines = [
    `# Live local-model results: ${model}`,
    '',
    `Ollama ${available.version} at ${url}, ${new Date().toISOString()}. Images: tests/fixtures/handwriting/ (as Inkling sends them).`,
    '',
    '| Scenario | Task | Result | Streamed chunks | First text | Total | Tokens in/out | Structured | Checks passed |',
    '|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of runs) {
    const passed = r.checks.filter((c) => c.pass).length
    lines.push(
      `| ${r.scenario} | ${r.task} | ${r.ok ? 'answered' : `error: ${r.error}`} | ${r.chunks} | ${s(r.firstTokenMs)} | ${s(r.totalMs)} | ${r.inputTokens ?? '–'}/${r.outputTokens ?? '–'} | ${r.validated === undefined ? 'n/a' : r.validated ? 'valid' : 'INVALID'} | ${passed}/${r.checks.length} |`
    )
  }
  for (const r of runs) {
    lines.push('', `## ${r.scenario} · ${r.task}`, '')
    for (const c of r.checks) lines.push(`- ${c.pass ? '✅' : '❌'} ${c.name}${c.detail && !c.pass ? ` — ${c.detail.replace(/\n/g, ' ')}` : ''}`)
    lines.push('', '```', (r.text || r.error || '').slice(0, 3000), '```')
  }
  return lines.join('\n') + '\n'
}
