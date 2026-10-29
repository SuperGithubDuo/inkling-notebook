/**
 * The beta server's HTTP API, independent of the Workers runtime so it can be
 * tested in Node with a fake model and an in-memory ledger.
 *
 *   GET  /v1/status   → tester name, today's allowance, model (no model call)
 *   POST /v1/tutor    → { task, turns } → server-sent events: delta*, then done | error
 *   GET|POST|PATCH /admin/...  → testers and pause switch (ADMIN_TOKEN only)
 *
 * The app sends only a task and the conversation, the same validated request
 * it uses for every provider. The instructions, output schema and token caps
 * come from Inkling's own prompts module on the server, so an access code
 * can't be used as a general-purpose free model API.
 *
 * Credentials: the Worker reaches Workers AI through its `AI` binding, so no
 * Cloudflare API token exists anywhere: not in the app, not in the Worker.
 * Testers hold only their own revocable access code.
 */
import { aiRequestSchema, type AiRequest } from '../../src/shared/ai'
import { taskSpec } from '../../src/main/ai/prompts'
import type { Ledger, Quota, Tester } from './ledger'
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
 * Output tokens a typical answer uses, per task: what a tester needs room for.
 * Measured with the real model (docs/live-results/cloud-qwen3.8-27b.md).
 */
export const EXPECTED_OUTPUT_TOKENS: Record<AiRequest['task'], number> = { chat: 350, practice: 900, check: 180, annotate: 380 }

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/v1/status' && request.method === 'GET') return await status(request, deps)
    if (url.pathname === '/v1/tutor' && request.method === 'POST') return await tutor(request, deps)
    if (url.pathname.startsWith('/admin/')) return await admin(request, url, deps)
    if (url.pathname === '/' && request.method === 'GET') return new Response('Inkling AI beta server\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    return problem(404, 'bad_request', 'Not found.')
  } catch (err) {
    console.error('unhandled', (err as Error)?.message)
    return problem(500, 'server', 'The beta server had a problem. Try again in a moment.')
  }
}

// --------------------------------------------------------------- tester API

async function authenticate(request: Request, ledger: Ledger): Promise<Tester | Response> {
  const auth = request.headers.get('authorization') ?? ''
  const m = /^Bearer (ink_[A-Za-z0-9_-]{32})$/.exec(auth)
  if (!m) return problem(401, 'invalid_key', 'This beta access code isn’t valid. Check it in AI settings.')
  const tester = await ledger.findByTokenHash(await sha256Hex(m[1]!))
  if (!tester) return problem(401, 'invalid_key', 'This beta access code isn’t valid. Check it in AI settings.')
  if (tester.revoked) return problem(403, 'beta_closed', 'This beta access code has been switched off. Ask the Inkling team for a new one.')
  return tester
}

async function status(request: Request, deps: Deps): Promise<Response> {
  const tester = await authenticate(request, deps.ledger)
  if (tester instanceof Response) return tester
  return json(200, { tester: tester.name, model: deps.config.model, paused: await deps.ledger.isPaused(), quota: await deps.ledger.quota(tester) })
}

async function tutor(request: Request, deps: Deps): Promise<Response> {
  const { ledger, config } = deps
  const now = deps.now ?? Date.now
  const tester = await authenticate(request, ledger)
  if (tester instanceof Response) return tester

  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > config.maxBodyBytes) return problem(413, 'bad_request', 'This request is too large. Select a smaller part of the page.')
  const raw = await request.text()
  if (raw.length > config.maxBodyBytes) return problem(413, 'bad_request', 'This request is too large. Select a smaller part of the page.')
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
  const outRate = config.rates.outputPerM / 1e6
  const inputCost = inputTokens * (config.rates.inputPerM / 1e6)

  // Reserve the worst case against the beta's cap; the tester needs room for a typical answer.
  // Near the beta's cap a chat answer may be shortened to fit; a structured answer can't be.
  let maxTokens = spec.maxOutputTokens
  let reserved = Math.ceil(inputCost + maxTokens * outRate)
  const expected = Math.ceil(inputCost + Math.min(maxTokens, EXPECTED_OUTPUT_TOKENS[body.task]) * outRate)
  let res = await ledger.reserve(tester, reserved, expected)
  if (!res.ok && body.task === 'chat' && res.code === 'global_quota' && res.quota) {
    const fit = Math.floor((res.quota.globalLimit - res.quota.globalUsed - inputCost) / outRate)
    if (fit >= MIN_CHAT_TOKENS) {
      maxTokens = Math.min(maxTokens, fit)
      reserved = Math.ceil(inputCost + maxTokens * outRate)
      res = await ledger.reserve(tester, reserved, Math.min(expected, reserved))
    }
  }
  if (!res.ok) {
    const statusCode = res.code === 'rate_limited' || res.code === 'busy' ? 429 : res.code === 'paused' || res.code === 'revoked' ? 503 : res.code === 'too_large' ? 413 : 429
    const code = res.code === 'tester_quota' || res.code === 'global_quota' ? 'daily_quota' : res.code === 'paused' || res.code === 'revoked' ? 'beta_closed' : res.code === 'busy' ? 'busy' : res.code === 'too_large' ? 'bad_request' : 'rate_limited'
    return problem(statusCode, code, res.message, res.retryAfter, { scope: res.code, ...(res.quota ? { quota: res.quota } : {}) })
  }
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
    console.warn('workers-ai error', kind, detail)
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
      failed = classifyUpstream(err).detail
      console.warn('stream failed', failed)
    }
    // Unknown usage: estimate from what was produced, never below the input estimate; and never above the reservation.
    // A stream stopped early has no usage report, and the model may have run on a little: charge the reservation.
    const cost = usage ? neuronsFor(usage, config.rates) : clientGone || (failed && !text) ? reserved : Math.min(reserved, inputCost + ((text.length + reasoningChars) / 3) * outRate)
    await ledger.settle(reservationId, cost)
    const quota = await ledger.quota(tester)
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
      return problem(429, 'daily_quota', 'Cloudflare’s free AI allowance for the beta is used up for today. It resets at midnight UTC. The local Ollama tutor still works in the meantime.', secondsToUtcMidnight(), { scope: 'global_quota' })
    case 'rate_limited':
      return problem(429, 'rate_limited', 'The AI service is busy. Try again in a few seconds.', 10)
    case 'capacity':
      return problem(503, 'server', 'The AI service is at capacity right now. Try again in a minute.', 30)
    case 'model_unavailable':
      return problem(503, 'model_unavailable', 'The beta’s AI model isn’t available right now. Try again later.')
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
  if (url.pathname === '/admin/testers' && request.method === 'GET') return json(200, { testers: await ledger.listTesters() })
  if (url.pathname === '/admin/testers' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { name?: unknown; dailyNeurons?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''
    if (!name) return problem(400, 'bad_request', 'A tester name is required.')
    const dailyNeurons = typeof body?.dailyNeurons === 'number' && body.dailyNeurons >= 0 ? body.dailyNeurons : undefined
    const token = newAccessCode()
    const tester = await ledger.addTester({ name, tokenHash: await sha256Hex(token), dailyNeurons })
    // The only time the code exists outside the tester's app.
    return json(201, { id: tester.id, name: tester.name, dailyNeurons: tester.dailyNeurons, accessCode: token })
  }
  const one = /^\/admin\/testers\/(t_[a-z0-9]{1,20})$/.exec(url.pathname)
  if (one && request.method === 'PATCH') {
    const body = (await request.json().catch(() => ({}))) as { revoked?: unknown; dailyNeurons?: unknown; name?: unknown }
    const t = await ledger.updateTester(one[1]!, {
      ...(typeof body.revoked === 'boolean' ? { revoked: body.revoked } : {}),
      ...(typeof body.dailyNeurons === 'number' && body.dailyNeurons >= 0 ? { dailyNeurons: body.dailyNeurons } : {}),
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim().slice(0, 60) } : {})
    })
    if (!t) return problem(404, 'bad_request', 'No such tester.')
    const { tokenHash: _, ...rest } = t
    return json(200, rest)
  }
  if (url.pathname === '/admin/pause' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { paused?: unknown }
    await ledger.setPaused(body.paused !== false)
    return json(200, { paused: await ledger.isPaused() })
  }
  return problem(404, 'bad_request', 'Not found.')
}

// ----------------------------------------------------------------- helpers

export function newAccessCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `ink_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')}`
}

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

function secondsToUtcMidnight(): number {
  const now = Date.now()
  const d = new Date(now)
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function problem(status: number, code: string, message: string, retryAfter?: number, extra?: { scope?: string; quota?: Quota }): Response {
  const res = json(status, { error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}), ...extra } })
  if (retryAfter !== undefined) res.headers.set('retry-after', String(retryAfter))
  return res
}
