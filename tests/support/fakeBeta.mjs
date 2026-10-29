/**
 * Inkling's real beta server code (beta-server/src/handler.ts + ledger.ts),
 * bundled on the fly and served over local HTTP, in front of a fake (or, for
 * live tests, real) Workers AI binding. The app talks to it exactly as it
 * would to the deployed Worker.
 *
 * The fake model speaks Workers AI's OpenAI-style output: server-sent
 * `chat.completion.chunk` events with a final `usage`, or one JSON body when
 * not streaming. Every call's inputs are recorded, so tests can assert what
 * reached the model (instructions, images, token caps, reasoning settings).
 */
import http from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { defaultAnswer as ollamaDefault } from './fakeOllama.mjs'

const root = resolve(import.meta.dirname, '../..')
let modulePromise = null

/** The server modules, bundled once per process (zod and the shared prompts included). */
export function loadServer() {
  modulePromise ??= (async () => {
    const out = await build({
      stdin: {
        contents: `export { handle, sha256Hex, newAccessCode } from './beta-server/src/handler.ts'\nexport { Ledger } from './beta-server/src/ledger.ts'\nexport * as upstream from './beta-server/src/upstream.ts'`,
        resolveDir: root,
        loader: 'ts'
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      alias: { '@shared': join(root, 'src/shared') },
      write: false,
      logLevel: 'silent'
    })
    const dir = await mkdtemp(join(tmpdir(), 'inkling-beta-server-'))
    const file = join(dir, 'server.mjs')
    await writeFile(file, out.outputFiles[0].text)
    return import(pathToFileURL(file).href)
  })()
  return modulePromise
}

export const RATES = { inputPerM: 40909, outputPerM: 290909 }

/** The task of a Workers AI request, from its system message. */
export function taskOf(inputs) {
  const sys = (inputs?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('')
  if (/Create practice problems/.test(sys)) return 'practice'
  if (/Judge the student's answer/.test(sys)) return 'check'
  if (/Mark it up the way a teacher would/.test(sys)) return 'annotate'
  return 'chat'
}

const hasImage = (inputs) => (inputs.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))

/** The same default answers as the fake Ollama (Qwen-style boxes), keyed off the request. */
export function defaultAnswer(inputs) {
  const asOllama = { messages: (inputs.messages ?? []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n\n'), images: Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map(() => 'x') : undefined })) }
  return ollamaDefault(asOllama)
}

const enc = new TextEncoder()
const sse = (obj) => enc.encode(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`)

/**
 * A fake Workers AI binding. `reply(answer)` queues the next answer:
 * {text} | {chunks} | {json} plus usage {inputTokens, outputTokens}, reasoning
 * (text sent as reasoning_content first), error (thrown by run(), e.g. '4006: …'),
 * midStreamError, chunkDelayMs, hang.
 */
export function fakeWorkersAi() {
  const queue = []
  const calls = []
  return {
    calls,
    reply(a) {
      queue.push(a)
    },
    async run(model, inputs) {
      const call = { model, inputs, task: taskOf(inputs), cancelled: false }
      calls.push(call)
      const scripted = queue.shift()
      const answer = (typeof scripted === 'function' ? await scripted(call) : scripted) ?? defaultAnswer(inputs)
      if (answer.error) throw new Error(answer.error)
      const text = answer.json ? JSON.stringify(answer.json) : (answer.chunks ?? [answer.text ?? '']).join('')
      const chunks = answer.chunks ?? (answer.json ? text.match(/.{1,12}/gs) : [text])
      const promptTokens = answer.usage?.inputTokens ?? 900 + (hasImage(inputs) ? 700 : 0)
      const completionTokens = answer.usage?.outputTokens ?? Math.ceil((text.length + (answer.reasoning?.length ?? 0)) / 4)
      const usage = answer.noUsage ? undefined : { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      if (!inputs.stream) {
        return { id: 'chatcmpl-fake', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: answer.finishReason ?? 'stop' }], ...(usage ? { usage } : {}) }
      }
      return new ReadableStream({
        async start(controller) {
          try {
            if (answer.reasoning) controller.enqueue(sse({ choices: [{ index: 0, delta: { reasoning_content: answer.reasoning } }] }))
            for (const c of chunks) {
              if (call.cancelled) return
              controller.enqueue(sse({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }))
              if (answer.chunkDelayMs) await new Promise((r) => setTimeout(r, answer.chunkDelayMs))
            }
            if (answer.hang) return
            if (answer.midStreamError) return controller.error(new Error(answer.midStreamError))
            controller.enqueue(sse({ choices: [{ index: 0, delta: {}, finish_reason: answer.finishReason ?? 'stop' }], ...(usage ? { usage } : {}) }))
            controller.enqueue(sse('[DONE]'))
            controller.close()
          } catch {
            /* cancelled */
          }
        },
        cancel() {
          call.cancelled = true
        }
      })
    }
  }
}

/** Serves `handle` over HTTP on 127.0.0.1. */
export async function startBetaServer(options = {}) {
  const mod = await loadServer()
  const store = new Map()
  const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => void store.set(k, structuredClone(v)), delete: async (k) => void store.delete(k) }
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const limits = {
    globalDailyNeurons: options.globalDailyNeurons ?? 9000,
    testerDailyNeurons: options.testerDailyNeurons ?? 900,
    perMinute: options.perMinute ?? 6,
    reservationTtlMs: 10 * 60_000,
    typicalNeuronsPerAnswer: options.typicalNeuronsPerAnswer ?? 150
  }
  const ledger = new mod.Ledger(storage, limits, now)
  const ai = options.ai ?? fakeWorkersAi()
  const adminToken = 'admin-token-for-tests-0123456789abcdef'
  const config = {
    model: options.model ?? '@cf/qwen/qwen3.8-27b',
    rates: options.rates ?? RATES,
    reasoningEffort: options.reasoningEffort ?? 'low',
    disableThinking: options.disableThinking ?? true,
    structured: options.structured ?? 'prompt',
    imagePatch: options.imagePatch ?? 28,
    maxBodyBytes: 3_500_000,
    adminTokenHash: await mod.sha256Hex(adminToken)
  }
  const pending = new Set()
  const waitUntil = (p) => {
    pending.add(p)
    p.finally(() => pending.delete(p))
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, ...(body.length && req.method !== 'GET' ? { body } : {}) })
    const response = await mod.handle(request, { ai, ledger, config, waitUntil, now })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) return res.end()
    const reader = response.body.getReader()
    res.on('close', () => void reader.cancel().catch(() => undefined))
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  })
  await new Promise((r) => server.listen(options.port ?? 0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  const addTester = async (name, dailyNeurons) => {
    const r = await fetch(`${url}/admin/testers`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, ...(dailyNeurons !== undefined ? { dailyNeurons } : {}) }) })
    return r.json()
  }
  return {
    url,
    ai,
    ledger,
    config,
    adminToken,
    clock,
    addTester,
    /** Waits until every answer has been settled in the ledger. */
    settled: () => Promise.all([...pending]),
    close: () => new Promise((r) => server.close(r))
  }
}
