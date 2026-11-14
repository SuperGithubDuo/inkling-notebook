/**
 * The public AI service's HTTP API, independent of the Workers runtime so it
 * can be tested in Node with a fake model and an in-memory ledger.
 *
 *   GET  /v1/status   → model, pause state, today's allowance for this installation (no model call)
 *   POST /v1/tutor    → { task, turns } → server-sent events: delta*, then done | error
 *   GET  /admin/summary, POST /admin/pause   → operator only (ADMIN_TOKEN secret)
 *
 * Anyone may ask: no account or code is needed (a signed-in app may add its
 * Supabase token for a per-account allowance, see identify()). Each request carries the
 * app's random installation ID (x-inkling-install); Cloudflare supplies the
 * client's IP (cf-connecting-ip, which clients can't set). The ledger limits
 * each installation, each network and the whole service per day.
 *
 * Not a general-purpose model proxy: callers send only a task and the
 * conversation, in Inkling's validated request format. The instructions,
 * output format, token caps, temperature and model are the server's (the
 * tutor prompts in src/main/ai/prompts.ts); nothing else is passed through.
 * Browsers on other sites can't call it (CORS headers only for the Inkling web app's origin, WEB_ORIGINS).
 *
 * Provider: the answer comes from Workers AI (through the `AI` binding) or
 * from an external OpenAI-compatible provider (provider.ts); the app can't
 * tell which. An external provider's API key is a Worker secret, sent only to
 * that provider. The operator's ADMIN_TOKEN is a Worker secret too; neither is
 * ever sent to users.
 *
 * Privacy: request content is never logged or stored. Logs carry only error
 * kinds; usage counts are kept per salted, daily-rotated hash (ledger.ts).
 */
import { aiRequestSchema, type AiRequest } from '../../src/shared/ai'
import { taskSpec } from '../../src/main/ai/prompts'
import { UPSTREAM_RETRY_MS, type Identity, type Ledger, type Quota, type RefusalCode } from './ledger'
import type { AiBinding, ProviderId } from './provider'
import type { Accounts } from './account'
import { classifyUpstream, costFor, reportedCost, estimateInputTokens, inputUpperBound, parseUpstream, readSse, toMessages, type Rates, type Usage } from './upstream'
import { chooseModel, type TextModelConfig } from './route'

export type { AiBinding } from './provider'

export interface ServerConfig {
  /**
   * Web origins whose pages may call /v1/* from a browser (the Inkling web app). Empty: none, as before.
   * Any other site's page gets no CORS headers, so its browser refuses the call. /admin/* never gets them.
   */
  allowedOrigins?: string[]
  /** The provider's identifier for the model (sent upstream). */
  model: string
  /** Which provider answers. Default 'workers-ai'. */
  provider?: ProviderId
  /** The model's name as reported to the app, the same whichever provider answers. Default: `model`. */
  publicModel?: string
  /**
   * Oldest app data notice (CLOUD_CONSENT_VERSION, sent as x-inkling-notice) that may
   * use this server. An app whose user agreed to an older notice, which names a
   * different provider, is asked to update instead of having its content sent
   * somewhere its notice doesn't mention. 0: any.
   */
  minNoticeVersion?: number
  rates: Rates
  /**
   * Multiplier on the input estimate when reserving (default 1). A provider's tokenizer and
   * image accounting can count more input than the server's estimate; the margin keeps the
   * worst case reserved before the call above what the provider will bill.
   */
  inputMargin?: number
  /**
   * External providers: how many attempts the adapter may make. A timed-out attempt may have been
   * billed, so the worst case reserves input for every attempt (default 1).
   */
  upstreamAttempts?: number
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
  /**
   * Workers AI only (route.ts): requests with no handwriting context may go to this text-only
   * model. Unset or null: every request goes to `model` (always so with an external provider).
   */
  textModel?: TextModelConfig | null
}

export interface Deps {
  ai: AiBinding
  ledger: Ledger
  config: ServerConfig
  /**
   * Verifies a signed-in request's Supabase token and returns the account's plan (account.ts).
   * Unset: accounts are off and every request is anonymous, whatever headers it carries.
   */
  accounts?: Accounts
  /** Keeps work (settling a reservation) alive after the response ends. */
  waitUntil(p: Promise<unknown>): void
  now?: () => number
}

const MIN_CHAT_TOKENS = 300
/** Characters per output token beyond which an answer has clearly passed its token cap (real text averages 3–4). */
export const RUNAWAY_CHARS_PER_TOKEN = 8
/**
 * Output tokens a typical answer uses, per task: what an installation needs room for.
 * Measured with the real model (docs/archive/live-results/cloud-qwen3.8-27b.md).
 */
export const EXPECTED_OUTPUT_TOKENS: Record<AiRequest['task'], number> = { chat: 350, practice: 900, check: 180, annotate: 380 }

/** The app's random installation ID. */
export const INSTALL_ID = /^inst_[A-Za-z0-9_-]{22,64}$/

/** Adds CORS for the Inkling web app's own origin(s) to the public API; everything else is answered as before. */
export async function handle(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get('origin')
  const allowed = !!origin && new URL(request.url).pathname.startsWith('/v1/') && (deps.config.allowedOrigins ?? []).includes(origin)
  if (!allowed) return route(request, deps)
  const cors = { 'access-control-allow-origin': origin, vary: 'origin' }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type, x-inkling-install, x-inkling-notice', 'access-control-max-age': '86400' }
    })
  }
  const res = await route(request, deps)
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
}

async function route(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/v1/status' && request.method === 'GET') return await status(request, deps)
    if (url.pathname === '/v1/tutor' && request.method === 'POST') return await tutor(request, deps)
    if (url.pathname.startsWith('/admin/')) return await admin(request, url, deps)
    if (url.pathname === '/' && request.method === 'GET') return new Response('Inkling AI server\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    // No CORS for other sites: their preflight (OPTIONS) gets no Access-Control-Allow-* headers, so browsers won't send the request.
    if (request.method === 'OPTIONS') return new Response(null, { status: 405 })
    return problem(404, 'bad_request', 'Not found.')
  } catch (err) {
    console.error('unhandled', (err as Error)?.name)
    return problem(500, 'server', 'Inkling’s AI server had a problem. Try again in a moment.')
  }
}

// --------------------------------------------------------------- public API

/**
 * Who is asking. Anonymous (installation + network) unless the request carries a Supabase access
 * token and this server has accounts on: then the account, verified by Supabase, with the plan
 * Supabase reports. The plan never comes from the request. A token that doesn't verify is refused
 * (never quietly downgraded or upgraded), and so is a request whose account can't be checked.
 */
async function identify(request: Request, deps: Deps): Promise<Identity | Response> {
  const install = request.headers.get('x-inkling-install') ?? ''
  if (!INSTALL_ID.test(install)) return problem(400, 'bad_request', 'This version of Inkling can’t use the AI service. Update Inkling.')
  const network = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const auth = request.headers.get('authorization')
  if (!auth || !deps.accounts) return { install, network }
  const token = /^Bearer ([^\s]+)$/.exec(auth)?.[1]
  const account = token ? await deps.accounts(token) : 'invalid'
  if (account === 'invalid') return problem(401, 'invalid_key', 'Your sign-in has expired. Sign in again to use the AI tutor with your account. Your notebooks work as usual.', undefined, { scope: 'account' })
  if (account === 'unavailable') return problem(503, 'server', 'Inkling couldn’t check your account just now. Try again in a moment. Your notebooks work as usual.', 30, { scope: 'account_unavailable' })
  // The account's allowance is per account, on every device; the network and global caps still apply.
  return { install: `acct:${account.userId}`, network, plan: account.plan }
}

/** A short wait in minutes ("in about 15 minutes"), for pauses well under an hour. */
const inMinutes = (seconds?: number): string => {
  const m = Math.max(1, Math.ceil((seconds ?? 60) / 60))
  return `in about ${m} minute${m === 1 ? '' : 's'}`
}

/** "in about 3 days" for waits until the next month; hours when it is that close. */
const inDays = (seconds?: number): string => {
  if (!seconds || seconds < 36 * 3600) return inAbout(seconds)
  const d = Math.round(seconds / 86400)
  return `in about ${d} day${d === 1 ? '' : 's'}`
}

const inAbout = (seconds?: number): string => {
  if (!seconds || seconds < 3600) return 'within the hour'
  const h = Math.round(seconds / 3600)
  return `in about ${h} hour${h === 1 ? '' : 's'}`
}

/** What each refusal tells the person, and with which app error code. */
/** Never a silent cut: when allowances are reduced near the budget, the refusal says so. */
const reducedWhy = (quota: Quota | undefined): string =>
  quota?.reduced ? ' (everyone’s allowance is smaller right now because Inkling’s shared AI budget is nearly used up)' : ''

function refusal(code: RefusalCode, retryAfter: number | undefined, quota?: Quota): Response {
  const later = inAbout(retryAfter)
  const keepGoing = 'Your notebooks work as usual, and you can use the tutor on this computer (Ollama) meanwhile.'
  switch (code) {
    case 'install_quota':
      return problem(429, 'daily_quota', `You’ve used today’s ${quota?.plan === 'pro' ? '' : 'free '}AI answers ${quota?.plan ? 'on your account' : 'on this computer'}${reducedWhy(quota)}. More are available ${later}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'network_quota':
      return problem(429, 'daily_quota', `Today’s free AI answers for your internet connection (shared by everyone on it, such as a school or office) are used up${reducedWhy(quota)}. More are available ${later}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'global_quota':
      // Paced: today's share was set lower to keep budget for the rest of the month; say so.
      return problem(
        429,
        'daily_quota',
        `Inkling’s free AI answers for today are used up for everyone${quota?.paced ? ', to keep enough for the rest of the month' : ''}. More are available ${later}. ${keepGoing}`,
        retryAfter,
        { scope: code, quota }
      )
    case 'install_monthly_quota':
      return problem(429, 'daily_quota', `You’ve used this month’s ${quota?.plan === 'pro' ? '' : 'free '}AI answers ${quota?.plan ? 'on your account' : 'on this computer'}. More are available ${inDays(retryAfter)}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'global_monthly_quota':
      return problem(429, 'daily_quota', `Inkling’s free AI answers for this month are used up for everyone. More are available ${inDays(retryAfter)}. ${keepGoing}`, retryAfter, { scope: code, quota })
    case 'duplicate':
      return problem(429, 'rate_limited', 'You just sent this exact request, and its answer is already shown. Change something and try again.', retryAfter, { scope: code })
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
  const id = await identify(request, deps)
  if (id instanceof Response) return id
  return json(200, { model: deps.config.publicModel ?? deps.config.model, paused: await deps.ledger.isPaused(), quota: await deps.ledger.quota(id) })
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
  const id = await identify(request, deps)
  if (id instanceof Response) return id
  const notice = Number(request.headers.get('x-inkling-notice') ?? '0')
  if ((config.minNoticeVersion ?? 0) > 0 && !(notice >= (config.minNoticeVersion ?? 0))) {
    return problem(400, 'bad_request', 'Inkling’s free AI now uses a different service to answer. Update Inkling to read what changed and keep using it. Your notebooks work as usual.', undefined, { scope: 'update_required' })
  }
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

  // Identical requests from one installation are the same request (the ledger refuses a repeat of an answered one).
  const fingerprint = await requestFingerprint(body)
  const spec = taskSpec(body.task, 'cloud')
  const inputTokens = estimateInputTokens(spec.system, body.turns, config.imagePatch)
  if (inputTokens > config.maxInputTokens) return tooLarge()
  // One model on an external provider (no routing, whatever the settings say). On Workers AI
  // (the rollback), the text-only rule (route.ts) may apply as it does today.
  const providerName = config.provider ?? 'workers-ai'
  const external = providerName !== 'workers-ai'
  const choice = chooseModel(body.task, body.turns, { model: config.model, rates: config.rates, reasoningEffort: config.reasoningEffort, disableThinking: config.disableThinking }, external ? null : config.textModel)
  const hasImage = body.turns.some((t) => t.parts.some((p) => 'image' in p))
  const outRate = choice.rates.outputPerM / 1e6
  const inputRate = choice.rates.inputPerM / 1e6
  // What a typical answer's input costs (the installation's and network's room) …
  const inputCost = inputTokens * inputRate * Math.max(1, config.inputMargin ?? 1)
  // … and what it can cost at most (the service's caps): never below the provider's real count.
  const worstInputCost = Math.max(inputCost, inputUpperBound(spec.system, body.turns, config.imagePatch) * inputRate)

  // Reserve the worst case against the service's cap; the installation and network need room for a typical answer.
  // Near the cap a chat answer may be shortened to fit; a structured answer can't be.
  // Retried attempts that timed out may each have been billed for their input: the worst case covers them,
  // so the settled cost (retries + answer) can never exceed what was reserved against the caps.
  const retryInputs = external ? Math.max(0, (config.upstreamAttempts ?? 1) - 1) * worstInputCost : 0
  let maxTokens = spec.maxOutputTokens
  let reserved = Math.ceil(retryInputs + worstInputCost + maxTokens * outRate)
  const expected = Math.ceil(inputCost + Math.min(maxTokens, EXPECTED_OUTPUT_TOKENS[body.task]) * outRate)
  let res = await ledger.reserve(id, reserved, expected, fingerprint)
  if (!res.ok && body.task === 'chat' && res.code === 'global_quota' && res.quota) {
    const fit = Math.floor((res.quota.globalLimit - res.quota.globalUsed - worstInputCost - retryInputs) / outRate)
    if (fit >= MIN_CHAT_TOKENS) {
      maxTokens = Math.min(maxTokens, fit)
      reserved = Math.ceil(retryInputs + worstInputCost + maxTokens * outRate)
      res = await ledger.reserve(id, reserved, Math.min(expected, reserved), fingerprint)
    }
  }
  if (!res.ok) return refusal(res.code, res.retryAfter, res.quota)
  const reservationId = res.reservationId

  const inputs: Record<string, unknown> = {
    messages: toMessages(spec.system, body.turns),
    max_completion_tokens: maxTokens,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(choice.reasoningEffort ? { reasoning_effort: choice.reasoningEffort } : {}),
    ...(choice.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {})
  }
  const useJsonMode = !!spec.jsonSchema && config.structured === 'json_schema'
  if (useJsonMode) inputs.response_format = { type: 'json_schema', json_schema: spec.jsonSchema }
  const streamed = !useJsonMode
  if (streamed) inputs.stream = true

  const startedAt = now()
  // A retried attempt that timed out may have been processed (and billed) by the provider: count its input, to be safe.
  let retryCharge = 0
  const hooks = { onRetry: (kind: string) => void (kind === 'timeout' || kind === 'other' ? (retryCharge += worstInputCost) : undefined) }
  let upstream: unknown
  try {
    // The Workers AI binding's third argument means something else; only external providers get the hooks.
    upstream = external ? await deps.ai.run(choice.model, inputs, hooks) : await deps.ai.run(choice.model, inputs)
  } catch (err) {
    const { kind } = classifyUpstream(err)
    // The kind only: an error message could in principle quote what was sent.
    // Operator problems are errors (alert-worthy): a refused key, or the provider account out of credit.
    if (kind === 'auth') console.error(`${providerName} refused the API key`)
    else if (kind === 'credits') console.error(`${providerName} account has no credit: answers paused`)
    else console.warn(`${providerName} error`, kind)
    // An error before any answer: the model did no work (charge only what timed-out retries may have cost).
    const exhausted = kind === 'free_allocation' || kind === 'credits'
    if (retryCharge > 0) await ledger.settle(reservationId, Math.min(reserved, retryCharge), { upstreamExhausted: exhausted })
    else await ledger.settle(reservationId, undefined, { failedBeforeModel: true, upstreamExhausted: exhausted })
    await ledger.record({ model: choice.model, route: choice.route, task: body.task, image: hasImage, neurons: Math.min(reserved, retryCharge), error: kind })
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
    let runaway = false
    try {
      if (streamed && upstream instanceof ReadableStream) {
        for await (const ev of readSse(upstream as ReadableStream<Uint8Array>)) {
          if (ev.error) {
            // The provider reported a failure inside the stream.
            if (ev.usage) usage = ev.usage
            failed = 'upstream error event'
            console.warn('stream failed', 'error_event')
            break
          }
          if (ev.reasoning) reasoningChars += ev.reasoning.length
          if (ev.text) {
            firstTokenMs ??= now() - startedAt
            text += ev.text
            await send('delta', { text: ev.text })
            if (clientGone) break
          }
          // A provider that ignores the token cap would spend past the reservation: stop reading
          // (which cancels the upstream answer) and charge the whole reservation.
          if (text.length + reasoningChars > maxTokens * RUNAWAY_CHARS_PER_TOKEN) {
            runaway = true
            finishReason = 'length'
            console.warn('stream stopped', 'runaway_output')
            break
          }
          if (ev.usage) usage = ev.usage
          if (ev.finishReason) finishReason = ev.finishReason
        }
      } else {
        const ev = parseUpstream(upstream, true)
        if (ev.error) failed = 'upstream error body'
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
    // A finished stream with nothing in it is a failure too (an empty answer helps no one).
    if (!failed && !text && !clientGone) failed = 'empty'
    // This attempt's worst case (the reservation minus the allowance for retries that may not have happened).
    const attemptWorst = Math.ceil(worstInputCost + maxTokens * outRate)
    const cost =
      retryCharge + (runaway ? attemptWorst : usage ? costFor(usage, choice.rates) : clientGone || (failed && !text) ? attemptWorst : Math.min(attemptWorst, inputCost + ((text.length + reasoningChars) / 3) * outRate))
    // Tokens: the provider's own count when it reported one; otherwise the server's estimate, flagged.
    const tokens = usage
      ? { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedInputTokens ?? 0 }
      : { input: inputTokens, output: Math.ceil((text.length + reasoningChars) / 3), estimated: true }
    // The real cost is always what's charged. If the provider billed more than the worst case reserved
    // (its token count above the estimate's margin), the excess is counted and reported, never hidden.
    if (cost > reserved) console.warn('cost above reservation', Math.round(cost - reserved))
    await ledger.settle(reservationId, cost, { answered: !failed && !clientGone && !!text, tokens, overshoot: Math.max(0, cost - reserved) })
    // Counts only (no content, no identity): which model, what kind of request, its cost (ledger unit), tokens, whether it failed.
    const providerReported = usage ? reportedCost(usage, choice.rates) : undefined
    await ledger.record({ model: choice.model, route: choice.route, task: body.task, image: hasImage, neurons: cost, tokens, ...(providerReported !== undefined ? { providerReported } : {}), error: failed && !text ? (failed === 'empty' ? 'empty' : 'stream') : undefined })
    const quota = await ledger.quota(id)
    if (failed && !text) {
      await send('error', { code: 'server', message: 'The model stopped before answering. Try again in a moment.', quota })
    } else {
      await send('done', {
        usage: { ...(usage ?? {}), firstTokenMs, totalMs: now() - startedAt, estimated: !usage },
        // The answer's cost in the ledger's unit (Neurons, or µ$ with an external provider); the field keeps its name for older apps.
        neurons: Math.round(cost * 10) / 10,
        unit: config.rates.unit ?? 'neurons',
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
    case 'credits':
      return refusal('upstream_unavailable', UPSTREAM_RETRY_MS / 1000)
    case 'rate_limited':
      return problem(429, 'rate_limited', 'The AI service is busy. Try again in a few seconds.', 10)
    case 'capacity':
      return problem(503, 'server', 'The AI service is at capacity right now. Try again in a minute.', 30)
    case 'timeout':
      return problem(503, 'server', 'The AI service took too long to answer. Try again in a moment, perhaps with a smaller selection.', 10)
    case 'auth':
      // Our key, not the student's: say it plainly without details.
      return problem(503, 'server', 'Inkling’s AI server can’t reach its AI service right now. Try again later; your notebooks work as usual.', 300)
    case 'malformed':
      return problem(502, 'bad_response', 'The AI service sent a reply Inkling could not read. Try again.', 5)
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

  // accounts: whether signed-in requests are verified ('off': all anonymous), so a rollout can check it.
  if (url.pathname === '/admin/summary' && request.method === 'GET') return json(200, { ...(await ledger.summary()), accounts: deps.accounts ? 'on' : 'off' })
  if (url.pathname === '/admin/pause' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { paused?: unknown }
    await ledger.setPaused(body.paused !== false)
    return json(200, { paused: await ledger.isPaused() })
  }
  return problem(404, 'bad_request', 'Not found.')
}

// ----------------------------------------------------------------- helpers

/**
 * A short digest identifying a request: its task, every text part, and each
 * image by type, size and its first and last bytes (hashing whole images would
 * cost CPU time for nothing a duplicate check needs).
 */
export async function requestFingerprint(body: AiRequest): Promise<string> {
  const parts = body.turns.map((t) => [t.role, ...t.parts.map((p) => ('text' in p ? `t:${p.text}` : `i:${p.image.mimeType}:${p.image.data.length}:${p.image.data.slice(0, 96)}:${p.image.data.slice(-96)}`))])
  return (await sha256Hex(JSON.stringify([body.task, parts]))).slice(0, 32)
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function problem(status: number, code: string, message: string, retryAfter?: number, extra?: { scope?: string; quota?: Quota | undefined }): Response {
  const res = json(status, { error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}), ...(extra?.scope ? { scope: extra.scope } : {}), ...(extra?.quota ? { quota: extra.quota } : {}) } })
  if (retryAfter !== undefined) res.headers.set('retry-after', String(retryAfter))
  return res
}
