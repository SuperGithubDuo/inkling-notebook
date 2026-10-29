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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaProvider } from '../../src/main/ai/ollama'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OLLAMA_DEFAULT_URL, type AiEvent, type AiPart, type AiRequest } from '../../src/shared/ai'
import { parseTaskResult, type AnnotationSet } from '../../src/shared/tutor'
import { planAnnotations } from '../../src/renderer/src/ai/annotate'
import { buildTransaction } from '../../src/renderer/src/canvas/commands'
import { createPageDoc } from '../../src/shared/factory'

const url = process.env.INKLING_LIVE_OLLAMA_URL ?? OLLAMA_DEFAULT_URL
const model = process.env.INKLING_LIVE_MODEL ?? 'qwen3-vl:4b-instruct'
const root = join(import.meta.dirname, '../..')
const fixtures = join(root, 'tests/fixtures/handwriting')

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

interface Run {
  scenario: string
  task: string
  ok: boolean
  error?: string
  text: string
  chunks: number
  firstTokenMs?: number
  totalMs: number
  inputTokens?: number
  outputTokens?: number
  validated?: boolean
  checks: { name: string; pass: boolean; detail?: string }[]
}
const runs: Run[] = []

describe.skipIf(!available.ok)(`live local model ${model}`, () => {
  let service: AiService
  const events: AiEvent[] = []
  const img = async (name: string): Promise<AiPart> => ({ image: { mimeType: 'image/jpeg', data: (await readFile(join(fixtures, name))).toString('base64') } })
  const selection: AiPart = { text: '<selection>\nThe attached image shows the part of my page I selected (handwriting, drawings).\n</selection>' }

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
  const flat = (s: string): string => s.replace(/[\s$\\{}]/g, '').replace(/−/g, '-').replace(/\^2|²/g, '²').toLowerCase()
  const chatWith = (parts: AiPart[]): AiRequest => ({ task: 'chat', turns: [{ role: 'user', parts }] })
  const CHECK = 'Check my work. Find the first mistake, if any, explain why it is wrong and how to fix it.'
  // The two ways the app asks for a markup (src/renderer/src/ai/markupStore.ts):
  // "Mark up my selection", and "Show this on my page" under a chat answer.
  const markup = (image: AiPart): AiRequest => ({ task: 'annotate', turns: [{ role: 'user', parts: [{ text: 'Check my work in the image and mark it up.' }, image] }] })
  const showOnPage = (explanation: string, image: AiPart): AiRequest => ({
    task: 'annotate',
    turns: [{ role: 'user', parts: [{ text: `<tutor_explanation>\n${explanation.slice(0, 4000)}\n</tutor_explanation>\nMark up my work in the image so it matches this explanation.` }, image] }]
  })
  const claimsMistake = (s: string): boolean => /(incorrect|mistake|error|wrong|not correct|should be|instead of|negatives? of|sign)/i.test(s) && !/(no (mistakes?|errors?)|not wrong|isn't wrong)/i.test(s)

  const placeable = (set: AnnotationSet): boolean => {
    const page = createPageDoc('nb', 'pg')
    const placed = planAnnotations(set.annotations, { region: { x: 100, y: 100, width: 480, height: 250 }, page })
    try {
      return buildTransaction(page, placed.flatMap((p) => p.commands), { author: 'ai' }).created.length > 0
    } catch {
      return false
    }
  }

  it('A: finds the sign mistake (roots are −2 and −3)', { timeout: 900_000 }, async () => {
    const image = await img('scenario-a.jpg')
    const chat = await run('A', chatWith([selection, image, { text: CHECK }]))
    check(chat, 'answered', chat.ok, chat.error)
    check(chat, 'streamed in several chunks', chat.chunks > 1, `${chat.chunks} chunks`)
    const t = flat(chat.text)
    check(chat, 'read the factorisation', /\(x\+2\)\(x\+3\)/.test(t))
    check(chat, 'gives the roots −2 and −3', /-2/.test(t) && /-3/.test(t))
    check(chat, 'says x = 2, 3 is wrong', /(mistake|error|incorrect|wrong|sign|not correct|should be)/i.test(chat.text))

    // "Mark up my selection" (no explanation), then "Show this on my page" (with the chat answer).
    for (const [label, request] of [
      ['A', markup(image)],
      ['A+explanation', showOnPage(chat.text, image)]
    ] as const) {
      const mark = await run(label, request)
      check(mark, 'structured output validates', !!mark.validated, mark.error ?? mark.text.slice(0, 200))
      const set = parseTaskResult('annotate', mark.text)
      if (!set) continue
      const tr = flat(set.transcription)
      check(mark, 'transcribed line 1', /x²\+5x\+6=0/.test(tr), set.transcription)
      check(mark, 'transcribed line 2', /\(x\+2\)\(x\+3\)=0/.test(tr), set.transcription)
      check(mark, 'transcribed line 3', /x=2,?3/.test(tr), set.transcription)
      check(mark, 'marks a mistake', set.annotations.some((a) => a.kind === 'cross' || a.kind === 'correction'), set.annotations.map((a) => a.kind).join(','))
      const wrong = set.annotations.filter((a) => a.kind === 'cross' || a.kind === 'correction' || a.kind === 'circle' || a.kind === 'underline')
      const centreY = (b: number[]): number => (b[0]! + b[2]!) / 2
      check(mark, 'the mistake mark is on the last line', wrong.some((a) => centreY(a.box_2d) > 600), wrong.map((a) => `${a.kind}@${a.box_2d.join(',')}`).join(' '))
      check(mark, 'correction gives −2 and −3', set.annotations.some((a) => a.text && /-2/.test(flat(a.text)) && /-3/.test(flat(a.text))), set.annotations.map((a) => a.text ?? '').join(' | '))
      check(mark, 'summary says there is a mistake', claimsMistake(set.summary), set.summary)
      check(mark, 'marks become valid canvas commands', placeable(set))
    }
  })

  it('B: recognises correct work', { timeout: 900_000 }, async () => {
    const image = await img('scenario-b.jpg')
    const chat = await run('B', chatWith([selection, image, { text: CHECK }]))
    check(chat, 'answered', chat.ok, chat.error)
    const t = flat(chat.text)
    check(chat, 'read 2x + 3 = 11', /2x\+3=11/.test(t))
    check(chat, 'says it is correct', /(correct|right|well done|no mistake|valid)/i.test(chat.text) && !/(is wrong|incorrect|mistake is)/i.test(chat.text))
    const mark = await run('B', markup(image))
    check(mark, 'structured output validates', !!mark.validated, mark.error ?? mark.text.slice(0, 200))
    const set = parseTaskResult('annotate', mark.text)
    if (set) {
      check(mark, 'uses a check mark', set.annotations.some((a) => a.kind === 'check'), set.annotations.map((a) => a.kind).join(','))
      check(mark, 'no cross on correct work', !set.annotations.some((a) => a.kind === 'cross'), set.annotations.map((a) => a.kind).join(','))
      check(mark, 'summary and notes do not claim a mistake', !claimsMistake([set.summary, ...set.annotations.map((a) => a.text ?? '')].join(' ')), [set.summary, ...set.annotations.map((a) => a.text ?? '')].join(' | '))
    }
  })

  it('C: identifies the forces in a free-body diagram', { timeout: 900_000 }, async () => {
    const chat = await run('C', chatWith([selection, await img('scenario-c.jpg'), { text: 'This is my free-body diagram of a block being pushed along the floor. Which forces are shown, and what does each label stand for?' }]))
    check(chat, 'answered', chat.ok, chat.error)
    const t = chat.text.toLowerCase()
    check(chat, 'weight / gravity (W)', /weight|gravit/.test(t))
    check(chat, 'normal force (N)', /normal/.test(t))
    check(chat, 'applied force (F)', /applied|push|pull|force f\b|\bf\b.*(applied|push)/.test(t))
    check(chat, 'friction (f)', /friction/.test(t))
  })

  it('D: answers a question about a rich-text note', { timeout: 900_000 }, async () => {
    const note = `<notes title="Photosynthesis">\n# Photosynthesis\n\nPlants convert light energy into chemical energy in the **chloroplasts**.\n\n$$6CO_2 + 6H_2O \\xrightarrow{light} C_6H_{12}O_6 + 6O_2$$\n\n- Light-dependent reactions happen in the thylakoid membranes and release oxygen.\n- The Calvin cycle happens in the stroma and fixes carbon dioxide into glucose.\n</notes>`
    const chat = await run('D', chatWith([{ text: note }, { text: 'According to my notes, where does the Calvin cycle happen, and what gas is released by the light-dependent reactions?' }]))
    check(chat, 'answered', chat.ok, chat.error)
    check(chat, 'stroma', /stroma/i.test(chat.text))
    check(chat, 'oxygen', /oxygen|o_?2|o₂/i.test(chat.text))
  })

  it('E: answers from imported PDF text', { timeout: 900_000 }, async () => {
    const page = `<page title="Kinematics handout p. 3">\nText of the PDF page:\n3.2 Uniform acceleration\nA car starts from rest and accelerates uniformly at 2.5 m/s² for 8.0 s. The equations of motion for constant acceleration are v = u + at and s = ut + ½at².\nExercise 3.2.1: Find the final speed and the distance travelled.\n</page>`
    const chat = await run('E', chatWith([{ text: page }, { text: 'Solve exercise 3.2.1 from this PDF page. Give both answers with units.' }]))
    check(chat, 'answered', chat.ok, chat.error)
    // LaTeX units (20\ \text{m/s}) flattened to plain text first.
    const plain = chat.text.replace(/\\(text|mathrm)\{([^}]*)\}/g, '$2').replace(/\\[ ,;!]/g, ' ').replace(/\s+/g, ' ')
    check(chat, 'final speed 20 m/s', /\b20(\.0)?\s*m\s*\/\s*s\b/i.test(plain), plain.slice(0, 300))
    check(chat, 'distance 80 m', /\b80(\.0)?\s*m\b(?!\/)/i.test(plain), plain.slice(0, 300))
  })

  it('P: practice problems with hints, and checks answers', { timeout: 900_000 }, async () => {
    const gen = await run('P', { task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create 2 practice problems at easy difficulty on: solving linear equations.' }] }] })
    check(gen, 'structured output validates', !!gen.validated, gen.error ?? gen.text.slice(0, 200))
    const set = parseTaskResult('practice', gen.text)
    if (!set) return
    check(gen, 'two problems', set.problems.length === 2, String(set.problems.length))
    check(gen, 'every problem has hints', set.problems.every((p) => p.hints.length >= 1))
    const problem = set.problems[0]!
    const ask = (answer: string): AiRequest => ({
      task: 'check',
      turns: [{ role: 'user', parts: [{ text: `Practice problem:\n${problem.question}\n\nExpected final answer: ${problem.answer}` }, { text: `Student answer (typed): ${answer}` }] }]
    })
    const right = await run('P', ask(problem.answer.replace(/\$/g, '')))
    check(right, 'check validates', !!right.validated, right.error ?? right.text.slice(0, 200))
    check(right, 'right answer judged correct', parseTaskResult('check', right.text)?.verdict === 'correct', right.text.slice(0, 200))
    const wrong = await run('P', ask('x = 12345'))
    check(wrong, 'wrong answer not judged correct', !!parseTaskResult('check', wrong.text) && parseTaskResult('check', wrong.text)!.verdict !== 'correct', wrong.text.slice(0, 200))
  })
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
