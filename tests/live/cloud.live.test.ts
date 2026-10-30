/**
 * Optional live test of Inkling's cloud AI against the REAL model on Cloudflare
 * Workers AI (@cf/qwen/qwen3.8-27b) — no mocks. It spends real free
 * allowance: a full run uses roughly 2,000–3,000 of the account's 10,000
 * daily Neurons. Two ways to run it:
 *
 *   1. Against the deployed AI server (what users get), anonymously like the app:
 *        INKLING_BETA_URL=https://inkling-ai-beta.<you>.workers.dev \
 *        INKLING_LIVE_CLOUD=1 npm run test:live:cloud
 *      A full run needs more than one installation's daily allowance, so the
 *      test starts a fresh installation when the first one's is used up (and
 *      records that the per-installation limit was hit).
 *
 *   2. Without deploying: the AI server code runs on this computer and
 *      reaches Workers AI over Cloudflare's REST API (needs an API token with
 *      "Workers AI: Read" permission, on a Workers Free account):
 *        CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run test:live:cloud
 *      Add INKLING_LIVE_PROBE=1 to first compare model settings (reasoning,
 *      thinking switch, JSON mode) on one small request each.
 *
 * Skipped (not failed) without either. Runs the same handwriting scenarios as
 * the local-model test through Inkling's AiService + CloudProvider, and
 * records each answer's latency, tokens and Neurons, then estimates how many
 * interactions the free allowance supports. Report:
 * test-results/live-cloud-qwen3.8-27b.md (and .json).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OllamaProvider } from '../../src/main/ai/ollama'
import { CLOUD_MODEL, aiReady, type AiEvent, type AiRequest, type CloudQuota } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { taskSpec } from '../../src/main/ai/prompts'
import { registerScenarios, img, selection, type Run } from './scenarios'
import { startBetaServer, RATES, type BetaServer } from '../support/fakeBeta.mjs'
import { workersAiRest } from '../support/workersAiRest.mjs'

const root = join(import.meta.dirname, '../..')
const env = process.env
const direct = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
const deployed = !!env.INKLING_BETA_URL && env.INKLING_LIVE_CLOUD === '1'
const enabled = deployed || direct
if (!enabled) console.log('\n  Live cloud tests skipped: set INKLING_BETA_URL + INKLING_LIVE_CLOUD=1, or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (see the comment at the top of this file).\n')

const memoryCipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => Buffer.alloc(0),
  decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
}

interface Probe {
  name: string
  inputs: Record<string, unknown>
  ok: boolean
  ms: number
  error?: string
  text?: string
  reasoningChars?: number
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  neurons?: number
  validJson?: boolean
}

const runs: Run[] = []
const probes: Probe[] = []
let quotaBefore: CloudQuota | null = null
let quotaAfter: CloudQuota | null = null
let mode = ''
let installations = 0
let installLimitHits = 0
let capacityRetries = 0

describe.skipIf(!enabled)(`live cloud AI, ${CLOUD_MODEL}`, () => {
  let server: BetaServer | null = null
  let service: AiService
  let url = ''
  const events: AiEvent[] = []

  /** A freshly installed app: new data folder, new installation ID, no credentials. */
  const freshInstall = async (): Promise<void> => {
    const config = new AiConfig(await mkdtemp(join(tmpdir(), 'inkling-live-cloud-')), memoryCipher, { builtInCloudUrl: url, defaultProvider: 'cloud' })
    await config.load()
    service = new AiService({
      config,
      makeProvider: (k) => new GeminiProvider({ apiKey: k, baseUrl: 'http://127.0.0.1:9' }),
      makeLocalProvider: () => new OllamaProvider({ baseUrl: 'http://127.0.0.1:9' }),
      emit: (e) => events.push(e),
      limits: { duplicateWindowMs: 0, minIntervalMs: 0, perMinute: 100 }
    })
    installations++
    const s = service.status()
    if (s.provider !== 'cloud' || !aiReady(s)) throw new Error(`A fresh install is not ready on the cloud AI: ${JSON.stringify(s)}`)
    const t = await service.test()
    if (!t.ok) throw new Error(`Anonymous status check failed: ${JSON.stringify(t)}`)
    await service.setConsent(true)
  }

  beforeAll(async () => {
    url = env.INKLING_BETA_URL ?? ''
    // The settings probe calls Workers AI directly, so it needs account credentials in either mode.
    if (env.INKLING_LIVE_PROBE === '1' && direct) await probe(workersAiRest({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN }))
    if (!deployed) {
      const ai = workersAiRest({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN })
      server = await startBetaServer({
        ai,
        // The whole test may use at most this much of today's allowance.
        globalDailyNeurons: Number(env.INKLING_LIVE_BUDGET ?? 4000),
        installDailyNeurons: Number(env.INKLING_LIVE_BUDGET ?? 4000),
        networkDailyNeurons: Number(env.INKLING_LIVE_BUDGET ?? 4000),
        installPerMinute: 30,
        networkPerMinute: 30,
        reasoningEffort: env.INKLING_LIVE_REASONING ?? 'low',
        disableThinking: env.INKLING_LIVE_THINKING !== 'on',
        structured: env.INKLING_LIVE_STRUCTURED === 'json_schema' ? 'json_schema' : 'prompt'
      })
      url = server.url
      mode = `AI server code on this computer → Workers AI REST API (reasoning_effort=${server.config.reasoningEffort || 'unset'}, enable_thinking=${server.config.disableThinking ? 'false' : 'default'}, structured=${server.config.structured})`
    } else {
      mode = `deployed AI server ${url}, anonymous (no code or key)`
    }
    await freshInstall()
    quotaBefore = service.status().cloud.quota
    console.log(`  ${mode}; service-wide use before: ${quotaBefore?.globalUsed ?? '?'} / ${quotaBefore?.globalLimit ?? '?'}`)
  }, 300_000)

  afterAll(async () => {
    const t = await service?.test().catch(() => null)
    quotaAfter = service?.status().cloud.quota ?? null
    void t
    await server?.close()
    await mkdir(join(root, 'test-results'), { recursive: true })
    const base = join(root, 'test-results', 'live-cloud-qwen3.8-27b')
    await writeFile(`${base}.json`, JSON.stringify({ model: CLOUD_MODEL, mode, at: new Date().toISOString(), quotaBefore, quotaAfter, probes, runs }, null, 2))
    await writeFile(`${base}.md`, report())
    console.log(`\n  Report: ${base}.md`)
  })

  const run = async (scenario: string, request: AiRequest): Promise<Run> => {
    const started = Date.now()
    let end: AiEvent | undefined
    let id = ''
    for (let attempt = 0; ; attempt++) {
      // The server paces requests; wait out a pause rather than fail the scenario.
      let r = service.start(request)
      for (let i = 0; 'error' in r && (r.error.code === 'rate_limited' || r.error.code === 'busy') && i < 20; i++) {
        await new Promise((res) => setTimeout(res, ((('error' in r && r.error.retryAfter) || 3) as number) * 1000))
        r = service.start(request)
      }
      if ('error' in r) throw new Error(r.error.message)
      id = r.requestId
      while (!(end = events.find((e) => e.requestId === id && e.type !== 'delta'))) await new Promise((res) => setTimeout(res, 50))
      // This installation's day is used up: carry on as a newly installed copy (the network and global limits still apply).
      if (end.type === 'error' && end.error.code === 'daily_quota' && /on this computer/.test(end.error.message) && attempt < 3) {
        installLimitHits++
        console.log(`  installation ${installations} reached its daily allowance (${service.status().cloud.quota?.installUsed ?? '?'} Neurons); continuing as a fresh install`)
        await freshInstall()
        continue
      }
      // Workers AI is briefly out of capacity (error 3040): ask again, as a person would.
      if (end.type === 'error' && end.error.code === 'server' && /capacity/i.test(end.error.message) && attempt < 3) {
        capacityRetries++
        console.log('  Workers AI at capacity; asking again in 20 s')
        await new Promise((res) => setTimeout(res, 20_000))
        continue
      }
      break
    }
    const chunks = events.filter((e) => e.requestId === id && e.type === 'delta').length
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
      neurons: end.type === 'done' ? end.usage.neurons : undefined,
      validated: request.task === 'chat' ? undefined : end.type === 'done' && parseTaskResult(request.task, end.text) !== null,
      checks: []
    }
    runs.push(result)
    console.log(`  [${scenario}/${request.task}] ${result.ok ? 'ok' : result.error} in ${(result.totalMs / 1000).toFixed(1)} s, ${result.inputTokens ?? '?'}→${result.outputTokens ?? '?'} tokens, ${result.neurons ?? '?'} Neurons`)
    return result
  }
  const check = (r: Run, name: string, pass: boolean, detail?: string): void => {
    r.checks.push({ name, pass, detail })
    expect.soft(pass, `${r.scenario}/${r.task}: ${name}${detail ? ` — ${detail}` : ''}`).toBe(true)
  }

  registerScenarios({ run, check, timeout: 300_000 })

  it('F: a follow-up question carries the conversation', { timeout: 300_000 }, async () => {
    const image = await img('scenario-a.jpg')
    const first = await run('F', { task: 'chat', turns: [{ role: 'user', parts: [selection, image, { text: 'Give me a hint for the next step.' }] }] })
    check(first, 'answered', first.ok, first.error)
    const follow = await run('F', {
      task: 'chat',
      turns: [
        { role: 'user', parts: [selection, image, { text: 'Give me a hint for the next step.' }] },
        { role: 'model', parts: [{ text: first.text || '(no answer)' }] },
        { role: 'user', parts: [{ text: 'Why are the roots negative?' }] }
      ]
    })
    check(follow, 'answered the follow-up', follow.ok, follow.error)
    check(follow, 'explains via the factors being zero', /zero|= ?0|negative|sign/i.test(follow.text), follow.text.slice(0, 200))
  })
})

/** Compares model settings on one small structured request each (direct mode only). */
async function probe(ai: ReturnType<typeof workersAiRest>): Promise<void> {
  const spec = taskSpec('check', 'cloud')
  const messages = [
    { role: 'system', content: spec.system },
    { role: 'user', content: 'Practice problem:\nSolve $2x + 3 = 11$.\n\nExpected final answer: $x = 4$\n\nStudent answer (typed): x = 4' }
  ]
  const base = { messages, max_completion_tokens: 600, temperature: 0.2 }
  const variants: Array<[string, Record<string, unknown>]> = [
    ['model defaults (reasoning xhigh)', { ...base }],
    ['reasoning_effort low', { ...base, reasoning_effort: 'low' }],
    ['low + enable_thinking false', { ...base, reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } }],
    ['low + no thinking + JSON mode', { ...base, reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: spec.jsonSchema } }]
  ]
  for (const [name, inputs] of variants) {
    const started = Date.now()
    try {
      const out = (await ai.run(CLOUD_MODEL, inputs)) as Record<string, any>
      const msg = out.choices?.[0]?.message ?? {}
      const text: string = typeof msg.content === 'string' ? msg.content : typeof out.response === 'string' ? out.response : JSON.stringify(out.response ?? '')
      const usage = out.usage ?? {}
      const neurons = ((usage.prompt_tokens ?? 0) * RATES.inputPerM + (usage.completion_tokens ?? 0) * RATES.outputPerM) / 1e6
      probes.push({ name, inputs: { ...inputs, messages: '(check task)' }, ok: true, ms: Date.now() - started, text, reasoningChars: String(msg.reasoning_content ?? msg.reasoning ?? '').length, usage, neurons, validJson: parseTaskResult('check', text) !== null })
    } catch (err) {
      probes.push({ name, inputs: { ...inputs, messages: '(check task)' }, ok: false, ms: Date.now() - started, error: (err as Error).message })
    }
    const p = probes.at(-1)!
    console.log(`  probe "${name}": ${p.ok ? `${p.usage?.completion_tokens} output tokens, ${p.reasoningChars} reasoning chars, JSON ${p.validJson ? 'valid' : 'invalid'}, ${p.ms} ms` : p.error}`)
  }
}

function report(): string {
  const s = (ms?: number): string => (ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`)
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
  const lines = [`# Live cloud AI results: ${CLOUD_MODEL}`, '', `${mode}, ${new Date().toISOString()}. Images: tests/fixtures/handwriting/ (as Inkling sends them).`, '']
  if (probes.length) {
    lines.push('## Model settings probe (one small check request each)', '', '| Settings | Result | Output tokens | Reasoning chars | Valid JSON | Neurons | Time |', '|---|---|---|---|---|---|---|')
    for (const p of probes) lines.push(`| ${p.name} | ${p.ok ? 'ok' : `error: ${p.error}`} | ${p.usage?.completion_tokens ?? '–'} | ${p.reasoningChars ?? '–'} | ${p.validJson === undefined ? '–' : p.validJson ? 'yes' : 'no'} | ${p.neurons?.toFixed(1) ?? '–'} | ${s(p.ms)} |`)
    lines.push('')
  }
  lines.push('## Scenarios', '', '| Scenario | Task | Result | Chunks | First text | Total | Tokens in/out | Neurons | Structured | Checks |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const r of runs) {
    const passed = r.checks.filter((c) => c.pass).length
    lines.push(`| ${r.scenario} | ${r.task} | ${r.ok ? 'answered' : `error: ${r.error}`} | ${r.chunks} | ${s(r.firstTokenMs)} | ${s(r.totalMs)} | ${r.inputTokens ?? '–'}/${r.outputTokens ?? '–'} | ${r.neurons?.toFixed(1) ?? '–'} | ${r.validated === undefined ? 'n/a' : r.validated ? 'valid' : 'INVALID'} | ${passed}/${r.checks.length} |`)
  }
  const done = runs.filter((r) => r.ok && r.neurons !== undefined)
  const byTask = (t: string): number[] => done.filter((r) => r.task === t).map((r) => r.neurons!)
  const total = done.reduce((a, r) => a + r.neurons!, 0)
  const allChecks = runs.flatMap((r) => r.checks)
  lines.push('', '## Allowance', '')
  lines.push(`- Answers: ${done.length} of ${runs.length} succeeded; checks passed: ${allChecks.filter((c) => c.pass).length} of ${allChecks.length}.`)
  lines.push(`- Neurons used by this run (from the model’s token counts × Cloudflare’s published rates): **${total.toFixed(0)}**.`)
  if (quotaBefore && quotaAfter) lines.push(`- Server ledger, whole service, before → after: ${quotaBefore.globalUsed} → ${quotaAfter.globalUsed} of ${quotaAfter.globalLimit}. Installations used: ${installations}; per-installation limit reached ${installLimitHits} time(s); Workers AI capacity errors retried: ${capacityRetries}.`)
  lines.push('- Compare with the Cloudflare dashboard (Workers AI → Neurons used today) before and after the run.', '')
  lines.push('| Interaction | Answers | Mean Neurons | Mean first text | Mean total |', '|---|---|---|---|---|')
  for (const t of ['chat', 'annotate', 'practice', 'check']) {
    const rs = done.filter((r) => r.task === t)
    if (!rs.length) continue
    lines.push(`| ${t} | ${rs.length} | ${mean(byTask(t)).toFixed(1)} | ${s(mean(rs.map((r) => r.firstTokenMs ?? r.totalMs)))} | ${s(mean(rs.map((r) => r.totalMs)))} |`)
  }
  // A typical session: mostly questions, some markups, the odd practice set.
  const mix = { chat: 0.6, annotate: 0.25, practice: 0.05, check: 0.1 }
  const blended = Object.entries(mix).reduce((a, [t, w]) => a + (Number.isFinite(mean(byTask(t))) ? mean(byTask(t)) * w : 0), 0) / Object.entries(mix).reduce((a, [t, w]) => a + (Number.isFinite(mean(byTask(t))) ? w : 0), 0)
  if (Number.isFinite(blended)) {
    lines.push('', `Blended interaction (60% chat, 25% markup, 10% answer check, 5% practice set): **${blended.toFixed(0)} Neurons**.`)
    lines.push(`- Cloudflare’s free 10,000 Neurons a day ≈ **${Math.floor(10_000 / blended)} interactions** a day for everyone; the server’s 9,000 cap ≈ **${Math.floor(9000 / blended)}**.`)
    lines.push(`- One installation’s 900 Neurons ≈ ${Math.floor(900 / blended)} interactions a day, so about ${Math.floor(9000 / 900)} people can use their full allowance on the same day.`)
  }
  for (const r of runs) {
    lines.push('', `## ${r.scenario} · ${r.task}`, '')
    for (const c of r.checks) lines.push(`- ${c.pass ? '✅' : '❌'} ${c.name}${c.detail && !c.pass ? ` — ${c.detail.replace(/\n/g, ' ')}` : ''}`)
    lines.push('', '```', (r.text || r.error || '').slice(0, 3000), '```')
  }
  return lines.join('\n') + '\n'
}
