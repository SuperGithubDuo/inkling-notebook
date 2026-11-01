/**
 * The public AI service's HTTP API, independent of the Workers runtime so it
 * can be tested in Node with a fake model and an in-memory ledger.
 *
 *   GET  /v1/status   → model, pause state, today's allowance for this installation (no model call)
 *   POST /v1/tutor    → { task, turns } → server-sent events: delta*, then done | error
 *   GET  /admin/summary, POST /admin/pause   → operator only (ADMIN_TOKEN secret)
 *
 * Anyone may ask: there are no accounts or codes. Each request carries the
 * app's random installation ID (x-inkling-install); Cloudflare supplies the
 * client's IP (cf-connecting-ip, which clients can't set). The ledger limits
 * each installation, each network and the whole service per day.
 *
 * Not a general-purpose model proxy: callers send only a task and the
 * conversation, in Inkling's validated request format. The instructions,
 * output format, token caps, temperature and model are the server's (the
 * tutor prompts in src/main/ai/prompts.ts); nothing else is passed through.
 * Browsers on other sites can't call it (no CORS headers).
 *
 * Credentials: the Worker reaches Workers AI through its `AI` binding, so no
 * Cloudflare API token exists anywhere. The operator's ADMIN_TOKEN is a
 * Worker secret and is never sent to users.
 *
 * Privacy: request content is never logged or stored. Logs carry only error
 * kinds; usage counts are kept per salted, daily-rotated hash (ledger.ts).
 */
import { aiRequestSchema, type AiRequest } from '../../src/shared/ai'
import { taskSpec } from '../../src/main/ai/prompts'
import { UPSTREAM_RETRY_MS, type Identity, type Ledger, type Quota, type RefusalCode } from './ledger'
import { classifyUpstream, estimateInputTokens, neuronsFor, parseUpstream, readSse, toMessages, type Rates, type Usage } from './upstream'

/** The parts of the Workers AI binding the server uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}

export interface ServerConfig {
  model: string
  rates: Rates
  /** Reasoning effort sent to the model ('low' keeps hidden, billed reasoning short). Empty: not sent. */
  reasoningEffort: string
  /** Sends chat_template_kwargs.enable_thinking = false. */
  disableThinking: boolean
  /** 'json_schema': ask Workers AI's JSON mode (no streaming); 'prompt': schema in the instructions only. */
  structured: 'json_schema' | 'prompt'
  /** Image patch size used to estimate image tokens. */
  imagePatch: number
  /** Largest accepted request body, in bytes. */
  maxBodyBytes: number
  /** Largest accepted request, in estimated input tokens. */
  maxInputTokens: number
  adminTokenHash: string | null
}

export interface Deps {
  ai: AiBinding
  ledger: Ledger
  config: ServerConfig
  /** Keeps work (settling a reservation) alive after the response ends. */
  waitUntil(p: Promise<unknown>): void
  now?: () => number
}

const MIN_CHAT_TOKENS = 300
/**
 * Output tokens a typical answer uses, per task: what an installation needs room for.
 * Measured with the real model (docs/live-results/cloud-qwen3.8-27b.md).
 */
export const EXPECTED_OUTPUT_TOKENS: Record<AiRequest['task'], number> = { chat: 350, practice: 900, check: 180, annotate: 380 }

/** The app's random installation ID. */
export const INSTALL_ID = /^inst_[A-Za-z0-9_-]{22,64}$/

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/v1/status' && request.method === 'GET') return await status(request, deps)
    if (url.pathname === '/v1/tutor' && request.method === 'POST') return await tutor(request, deps)
    if (url.pathname.startsWith('/admin/')) return await admin(request, url, deps)
    if (url.pathname === '/' && request.method === 'GET') return new Response('Inkling AI server\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    // No CORS: a cross-site preflight (OPTIONS) gets no Access-Control-Allow-* headers, so browsers won't send the request.
    if (request.method === 'OPTIONS') return new Response(null, { status: 405 })
    return problem(404, 'bad_request', 'Not found.')
  } catch (err) {
    console.error('unhandled', (err as Error)?.name)
    return problem(500, 'server', 'Inkling’s AI server had a problem. Try again in a moment.')
  }
}

// --------------------------------------------------------------- public API

function identify(request: Request): Identity | Response {
  const install = request.headers.get('x-inkling-install') ?? ''
  if (!INSTALL_ID.test(install)) return problem(400, 'bad_request', 'This version of Inkling can’t use the AI service. Update Inkling.')
  return { install, network: request.headers.get('cf-connecting-ip') ?? 'unknown' }
}

/** A short wait in minutes ("in about 15 minutes"), for pauses well under an hour. */
const inMinutes = (seconds?: number): string => {
  const m = Math.max(1, Math.ceil((seconds ?? 60) / 60))
  return `in about ${m} minute${m === 1 ? '' : 's'}`
}

const inAbout = (seconds?: number): string => {
  if (!seconds || seconds < 3600) return 'within the hour'
  const h = Math.round(seconds / 3600)
  return `in about ${h} hour${h === 1 ? '' : 's'}`
}

/** What each refusal tells the person, and with which app error code. */
function refusal(code: RefusalCode, retryAfter: number | undefined, quota?: Quota): Response {
  const later = inAbout(retryAfter)
  const keepGoing = 'Your notebooks work as usual, and you can use the tutor on this computer (Ollama) meanwhile.'
  switch (code) {
    case 'install_quota':
      return problem(429, 'daily_quota', `You’ve used today’s free AI answers on this computer. More are available ${later}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'network_quota':
      return problem(429, 'daily_quota', `Today’s free AI answers for your internet connection (shared by everyone on it, such as a school or office) are used up. More are available ${later}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'global_quota':
      return problem(429, 'daily_quota', `Inkling’s free AI answers for today are used up for everyone. More are available ${later}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'upstream_unavailable':
      // Not Inkling's daily allowance: a short pause after Cloudflare refused, with the real retry time.
      // 'server' (not 'daily_quota') so the app keeps no day-long pause and the next try reaches the server.
      return problem(503, 'server', `Inkling’s free AI is briefly unavailable from its provider. Try again ${inMinutes(retryAfter)}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'too_large':
      return problem(413, 'bad_request', 'This request is too large for the free AI. Select a smaller part of the page or ask for fewer problems.', undefined, { scope: code })
    case 'busy':
      return problem(429, 'busy', 'Another answer is still being written on this computer or connection. Wait for it to finish.', retryAfter, { scope: code })
    case 'capacity':
      return problem(503, 'server', 'Inkling’s free AI is busy right now. Try again in a few seconds.', retryAfter, { scope: code })
    case 'paused':
      return problem(503, 'beta_closed', 'Inkling’s free AI is paused for maintenance. Try again later; your notebooks work as usual.', undefined, { scope: code })
    case 'rate_limited':
    default:
      return problem(429, 'rate_limited', 'That’s a lot of questions in a minute. Try again in a few seconds.', retryAfter, { scope: code })
  }
}

async function status(request: Request, deps: Deps): Promise<Response> {
  const id = identify(request)
  if (id instanceof Response) return id
  return json(200, { model: deps.config.model, paused: await deps.ledger.isPaused(), quota: await deps.ledger.quota(id) })
}

/** Reads at most `max` bytes of the body; null if it is longer. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

async function tutor(request: Request, deps: Deps): Promise<Response> {
  const { ledger, config } = deps
  const now = deps.now ?? Date.now
  const id = identify(request)
  if (id instanceof Response) return id
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return problem(415, 'bad_request', 'The request was not in the format Inkling uses.')

  const tooLarge = (): Response => problem(413, 'bad_request', 'This request is too large. Select a smaller part of the page.')
  if (Number(request.headers.get('content-length') ?? '0') > config.maxBodyBytes) return tooLarge()
  const raw = await readCapped(request, config.maxBodyBytes)
  if (raw === null) return tooLarge()
  let body: AiRequest
  try {
    const parsed = aiRequestSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return problem(400, 'bad_request', 'The request was not in the format Inkling uses.')
    body = parsed.data
  } catch {
    return problem(400, 'bad_request', 'The request was not in the format Inkling uses.')
  }

  const spec = taskSpec(body.task, 'cloud')
  const inputTokens = estimateInputTokens(spec.system, body.turns, config.imagePatch)
  if (inputTokens > config.maxInputTokens) return tooLarge()
  const outRate = config.rates.outputPerM / 1e6
  const inputCost = inputTokens * (config.rates.inputPerM / 1e6)

  // Reserve the worst case against the service's cap; the installation and network need room for a typical answer.
  // Near the cap a chat answer may be shortened to fit; a structured answer can't be.
  let maxTokens = spec.maxOutputTokens
  let reserved = Math.ceil(inputCost + maxTokens * outRate)
  const expected = Math.ceil(inputCost + Math.min(maxTokens, EXPECTED_OUTPUT_TOKENS[body.task]) * outRate)
  let res = await ledger.reserve(id, reserved, expected)
  if (!res.ok && body.task === 'chat' && res.code === 'global_quota' && res.quota) {
    const fit = Math.floor((res.quota.globalLimit - res.quota.globalUsed - inputCost) / outRate)
    if (fit >= MIN_CHAT_TOKENS) {
      maxTokens = Math.min(maxTokens, fit)
      reserved = Math.ceil(inputCost + maxTokens * outRate)
      res = await ledger.reserve(id, reserved, Math.min(expected, reserved))
    }
  }
  if (!res.ok) return refusal(res.code, res.retryAfter, res.quota)
  const reservationId = res.reservationId

  const inputs: Record<string, unknown> = {
    messages: toMessages(spec.system, body.turns),
    max_completion_tokens: maxTokens,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    ...(config.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {})
  }
  const useJsonMode = !!spec.jsonSchema && config.structured === 'json_schema'
  if (useJsonMode) inputs.response_format = { type: 'json_schema', json_schema: spec.jsonSchema }
  const streamed = !useJsonMode
  if (streamed) inputs.stream = true

  const startedAt = now()
  let upstream: unknown
  try {
    upstream = await deps.ai.run(config.model, inputs)
  } catch (err) {
    const { kind, detail } = classifyUpstream(err)
    // The kind only: an error message could in principle quote what was sent.
    console.warn('workers-ai error', kind)
    // An error before any answer: the model did no work, except possibly for capacity errors mid-way (not knowable): charge nothing.
    await ledger.settle(reservationId, undefined, { failedBeforeModel: true, upstreamExhausted: kind === 'free_allocation' })
    return upstreamProblem(kind)
  }

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  let clientGone = false
  const send = async (event: string, data: unknown): Promise<void> => {
    if (clientGone) return
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {
      clientGone = true
    })
  }

  const work = (async () => {
    let text = ''
    let reasoningChars = 0
    let usage: Usage | undefined
    let finishReason: string | undefined
    let firstTokenMs: number | undefined
    let failed: string | null = null
    try {
      if (streamed && upstream instanceof ReadableStream) {
        for await (const ev of readSse(upstream as ReadableStream<Uint8Array>)) {
          if (ev.reasoning) reasoningChars += ev.reasoning.length
          if (ev.text) {
            firstTokenMs ??= now() - startedAt
            text += ev.text
            await send('delta', { text: ev.text })
            if (clientGone) break
          }
          if (ev.usage) usage = ev.usage
          if (ev.finishReason) finishReason = ev.finishReason
        }
      } else {
        const ev = parseUpstream(upstream, true)
        text = ev.text ?? ''
        usage = ev.usage
        finishReason = ev.finishReason
        firstTokenMs = now() - startedAt
        if (text) await send('delta', { text })
      }
    } catch (err) {
      const c = classifyUpstream(err)
      failed = c.detail
      console.warn('stream failed', c.kind)
    }
    // Unknown usage: estimate from what was produced, never below the input estimate; and never above the reservation.
    // A stream stopped early has no usage report, and the model may have run on a little: charge the reservation.
    const cost = usage ? neuronsFor(usage, config.rates) : clientGone || (failed && !text) ? reserved : Math.min(reserved, inputCost + ((text.length + reasoningChars) / 3) * outRate)
    await ledger.settle(reservationId, cost)
    const quota = await ledger.quota(id)
    if (failed && !text) {
      await send('error', { code: 'server', message: 'The model stopped before answering. Try again in a moment.', quota })
    } else {
      await send('done', {
        usage: { ...(usage ?? {}), firstTokenMs, totalMs: now() - startedAt, estimated: !usage },
        neurons: Math.round(cost * 10) / 10,
        finishReason: finishReason === 'length' ? 'MAX_TOKENS' : finishReason?.toUpperCase(),
        quota
      })
    }
    await writer.close().catch(() => undefined)
  })()
  deps.waitUntil(work)

  return new Response(readable, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  })
}

function upstreamProblem(kind: ReturnType<typeof classifyUpstream>['kind']): Response {
  switch (kind) {
    case 'free_allocation':
      return refusal('upstream_unavailable', UPSTREAM_RETRY_MS / 1000)
    case 'rate_limited':
      return problem(429, 'rate_limited', 'The AI service is busy. Try again in a few seconds.', 10)
    case 'capacity':
      return problem(503, 'server', 'The AI service is at capacity right now. Try again in a minute.', 30)
    case 'model_unavailable':
      return problem(503, 'model_unavailable', 'Inkling’s AI model isn’t available right now. Try again later.')
    case 'json_mode':
      return problem(502, 'bad_response', 'The model couldn’t give its answer in the expected format. Try again.')
    case 'bad_request':
      return problem(400, 'bad_request', 'The AI service couldn’t process this request. Try a smaller selection.')
    default:
      return problem(502, 'server', 'The AI service had a problem. Try again in a moment.', 5)
  }
}

// --------------------------------------------------------------- admin API

async function admin(request: Request, url: URL, deps: Deps): Promise<Response> {
  const { ledger, config } = deps
  const auth = /^Bearer (.{32,200})$/.exec(request.headers.get('authorization') ?? '')
  // Without an ADMIN_TOKEN secret the admin API is off.
  if (!config.adminTokenHash || !auth || !timingSafeHexEqual(await sha256Hex(auth[1]!), config.adminTokenHash)) return problem(404, 'bad_request', 'Not found.')

  if (url.pathname === '/admin/summary' && request.method === 'GET') return json(200, await ledger.summary())
  if (url.pathname === '/admin/pause' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { paused?: unknown }
    await ledger.setPaused(body.paused !== false)
    return json(200, { paused: await ledger.isPaused() })
  }
  return problem(404, 'bad_request', 'Not found.')
}

// ----------------------------------------------------------------- helpers

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function problem(status: number, code: string, message: string, retryAfter?: number, extra?: { scope?: string; quota?: Quota | undefined }): Response {
  const res = json(status, { error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}), ...(extra?.scope ? { scope: extra.scope } : {}), ...(extra?.quota ? { quota: extra.quota } : {}) } })
  if (retryAfter !== undefined) res.headers.set('retry-after', String(retryAfter))
  return res
}
