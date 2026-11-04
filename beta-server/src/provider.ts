/**
 * Inference providers behind Inkling's AI server.
 *
 * The handler talks to every provider through the same small interface the
 * Workers AI binding already has: `run(model, inputs)` resolves to either a
 * stream of OpenAI-style server-sent events or one JSON completion, and
 * throws on failure. So switching provider is configuration, not a rewrite:
 *
 *   workers-ai   Cloudflare's `AI` binding (the original path, kept as rollback)
 *   deepinfra    DeepInfra's OpenAI-compatible API (recommended)
 *   openrouter   OpenRouter, pinned to one upstream provider, no fallbacks
 *   openrouter-free  OpenRouter's free variant (qwen/qwen3.8-27b:free): no charge, a
 *                account-wide daily and per-minute request quota, and a request body
 *                locked so it can never be routed to a paid endpoint
 *   groq         Groq's free plan (qwen/qwen3.8-27b, a PREVIEW model there): no payment method
 *                on the account, so nothing can be billed; account-wide request AND token
 *                quotas (30 req/min, 1,000 req/day, 8,000 tokens/min, 200,000 tokens/day) that
 *                the server never plans to exceed, and a stop if the account's limits ever
 *                show it is no longer on the free plan
 *
 * The desktop app never knows which one answers; it talks only to the Worker.
 *
 * External providers add what the binding gave for free: an API key (a Worker
 * secret, never sent anywhere but the provider), timeouts, and a bounded retry
 * with exponential backoff for failures that happen BEFORE any answer starts.
 * Nothing is retried once tokens have streamed (the student would see a
 * repeated answer and we'd pay twice), and nothing is retried forever.
 *
 * Privacy: request bodies and provider error bodies are never logged; errors
 * carry only a kind and an HTTP status.
 */

export type ProviderId = 'workers-ai' | 'deepinfra' | 'openrouter' | 'openrouter-free' | 'groq' | 'openai-compatible'
export type ExternalProviderId = Exclude<ProviderId, 'workers-ai'>

/** How a provider is asked to turn Qwen's hidden ("thinking") reasoning off. */
type ThinkingStyle = 'chat_template_kwargs' | 'openrouter_reasoning' | 'reasoning_effort_none' | 'groq'

export interface ProviderPreset {
  baseUrl: string
  /** The provider's identifier for Qwen 3.8 27B. */
  model: string
  thinking: ThinkingStyle
  /** Sends stream_options.include_usage (standard OpenAI; OpenRouter always reports usage). */
  includeUsage: boolean
  /** Extra request fields the provider needs (never anything from the client). */
  extraBody?: Record<string, unknown>
  /**
   * Multiplier on reported or computed cost for fees the token price doesn't show
   * (OpenRouter's 5.5% platform fee on credits).
   */
  costMultiplier: number
  /**
   * Request fields merged LAST, over operator extras, so configuration can't remove them
   * (the free preset's zero price ceiling and no-fallback rule).
   */
  lockedBody?: Record<string, unknown>
  /** Fields the operator's extra body may not set (they could route a request to another, paid model). */
  forbiddenExtra?: string[]
  /** Answers cost nothing: a reported charge above zero is a misconfiguration to stop on. */
  free?: boolean
  /** The only model IDs this free preset may ask for (anything else could be a paid model). */
  freeModels?: string[]
  /**
   * The provider's documented FREE-plan limits for the model, account-wide. Configured quotas may
   * not exceed them, and the server refuses to start without request and token quotas set.
   */
  freeLimits?: { requestsPerDay: number; requestsPerMinute: number; tokensPerDay: number; tokensPerMinute: number }
  /**
   * Response headers that report the account's limits (Groq: x-ratelimit-limit-requests is the daily
   * request limit). A value above the free plan's means the account was upgraded to a paid plan:
   * the server stops answering rather than run up a bill.
   */
  planGuard?: { header: string; maxFree: number }[]
  /** Fixed input tokens the provider counts per image (Groq: 2,048); the estimate never counts fewer. */
  imageTokens?: number
}

/**
 * Groq's documented free-plan limits for qwen/qwen3.8-27b (console.groq.com/docs/rate-limits,
 * read 3 Nov 2026). Rate limits there apply to the organization, not to a key.
 */
export const GROQ_FREE_LIMITS = { requestsPerDay: 1000, requestsPerMinute: 30, tokensPerDay: 200_000, tokensPerMinute: 8000 }

/** Checked against the providers' own documentation, Nov 2026 (docs/AI-PROVIDERS.md). */
export const PRESETS: Record<ExternalProviderId, ProviderPreset> = {
  deepinfra: { baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'Qwen/Qwen3.8-27B', thinking: 'chat_template_kwargs', includeUsage: true, costMultiplier: 1 },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3.8-27b',
    thinking: 'openrouter_reasoning',
    includeUsage: false,
    // One provider, no silent fallback to another host (no multi-provider routing),
    // and only endpoints that neither keep nor train on what is sent.
    extraBody: { provider: { order: ['deepinfra'], allow_fallbacks: false, data_collection: 'deny', zdr: true } },
    costMultiplier: 1.055
  },
  'openrouter-free': {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3.8-27b:free',
    thinking: 'openrouter_reasoning',
    includeUsage: false,
    costMultiplier: 1,
    free: true,
    // Locked, merged last: only endpoints whose host doesn't collect (store or train on) the data
    // (OpenRouter refuses the request when none qualifies); no fallback to another endpoint or model;
    // a price ceiling of zero, so OpenRouter refuses rather than bill.
    lockedBody: { provider: { data_collection: 'deny', allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } },
    forbiddenExtra: ['models', 'route', 'model', 'plugins']
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    thinking: 'groq',
    includeUsage: true,
    costMultiplier: 1,
    free: true,
    freeModels: ['qwen/qwen3.8-27b'],
    freeLimits: GROQ_FREE_LIMITS,
    // Groq: requests headers are per DAY, tokens headers per MINUTE.
    planGuard: [
      { header: 'x-ratelimit-limit-requests', maxFree: GROQ_FREE_LIMITS.requestsPerDay },
      { header: 'x-ratelimit-limit-tokens', maxFree: GROQ_FREE_LIMITS.tokensPerMinute }
    ],
    imageTokens: 2048,
    // Locked, merged last: the standard on-demand tier (never "flex"/"performance"/"auto", which can
    // pick a tier the free plan doesn't have), and any reasoning in its own field so it is counted, never shown.
    lockedBody: { service_tier: 'on_demand', reasoning_format: 'parsed' },
    forbiddenExtra: ['model', 'models', 'service_tier', 'tools', 'tool_choice', 'compound_custom', 'search_settings', 'documents']
  },
  'openai-compatible': { baseUrl: '', model: '', thinking: 'chat_template_kwargs', includeUsage: true, costMultiplier: 1 }
}

/** Merges plain objects one level deep (the `provider` preferences object), later wins. */
function mergeBody(...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of parts) {
    if (!p) continue
    for (const [k, v] of Object.entries(p)) {
      const prev = out[k]
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as object), ...(v as object) } : v
    }
  }
  return out
}

export type UpstreamKind =
  | 'free_allocation' // Workers Free daily allocation used up (4006)
  | 'credits' // the provider account is out of credit (402)
  | 'auth' // the provider refused our key (401/403): an operator problem
  | 'rate_limited'
  | 'capacity'
  | 'timeout'
  | 'model_unavailable'
  | 'json_mode'
  | 'bad_request'
  | 'malformed' // a reply we could not read
  | 'paid_plan' // the provider account's limits are no longer the free plan's: stop, don't bill
  | 'other'

/** A provider failure, by kind. The message never contains what was sent or what the provider said. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamKind,
    readonly status?: number,
    readonly retryAfterS?: number
  ) {
    super(`upstream ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'UpstreamError'
  }
}

export interface RunHooks {
  /** Called before each retry with why the previous attempt failed. */
  onRetry?(kind: UpstreamKind, attempt: number): void
}

/** The interface the handler calls; the Workers AI binding satisfies it as is. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, hooks?: RunHooks): Promise<unknown>
}

export interface ExternalOptions {
  id: ExternalProviderId
  apiKey: string
  baseUrl?: string
  extraBody?: Record<string, unknown>
  /** Attempts in all, including the first (1–4). */
  maxAttempts?: number
  /** Until the provider's response headers arrive. */
  firstByteTimeoutMs?: number
  /** Longest silence between streamed chunks. */
  idleTimeoutMs?: number
  /** Longest a whole answer may take. */
  totalTimeoutMs?: number
  /** Longest a single backoff may wait (a longer Retry-After is not waited for). */
  maxBackoffMs?: number
  /** Total time spent waiting between attempts. */
  retryBudgetMs?: number
  /** Whether a 429 is tried again (off for a quota-counted free endpoint: every attempt spends quota). */
  retryRateLimit?: boolean
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export const DEFAULT_RETRY = { maxAttempts: 3, firstByteTimeoutMs: 45_000, idleTimeoutMs: 45_000, totalTimeoutMs: 180_000, maxBackoffMs: 4_000, retryBudgetMs: 8_000 }

/** Statuses worth another attempt: the provider didn't start the work, or says try again. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])

export function kindOfStatus(status: number, body: string): UpstreamKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'credits'
  if (status === 404) return 'model_unavailable'
  if (status === 408 || status === 504 || status === 524) return 'timeout'
  if (status === 429) return /insufficient|credit|balance|quota exceeded/i.test(body) ? 'credits' : 'rate_limited'
  if (status === 400 || status === 413 || status === 422) {
    if (/model.*(not found|does not exist|unavailable)|no endpoints/i.test(body)) return 'model_unavailable'
    if (/json|response_format|schema/i.test(body) && /support/i.test(body)) return 'json_mode'
    return 'bad_request'
  }
  if (status >= 500) return 'capacity'
  return 'other'
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); undefined if absent or unreadable. */
export function retryAfterSeconds(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined
  const n = Number(h)
  if (Number.isFinite(n) && n >= 0) return n
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined
}

/** Seconds until an X-RateLimit-Reset time (epoch milliseconds or seconds, as OpenRouter sends it); undefined if absent. */
export function resetSeconds(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined
  const n = Number(h)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const ms = n > 1e12 ? n : n * 1000
  return Math.max(0, (ms - now) / 1000)
}

/** The request body for an OpenAI-compatible provider, from the inputs the handler builds for Workers AI. */
export function toProviderBody(preset: ProviderPreset, model: string, inputs: Record<string, unknown>, extraBody?: Record<string, unknown>): Record<string, unknown> {
  const { max_completion_tokens, chat_template_kwargs, reasoning_effort, stream, ...rest } = inputs as Record<string, unknown> & { chat_template_kwargs?: { enable_thinking?: boolean } }
  const thinkingOff = chat_template_kwargs?.enable_thinking === false
  const body: Record<string, unknown> = { ...rest, model }
  // max_tokens is the field every OpenAI-compatible host reads; it caps the answer, reasoning included.
  // Groq has deprecated it for max_completion_tokens.
  if (typeof max_completion_tokens === 'number') body[preset.thinking === 'groq' ? 'max_completion_tokens' : 'max_tokens'] = max_completion_tokens
  if (preset.thinking === 'chat_template_kwargs') {
    if (thinkingOff) body.chat_template_kwargs = { enable_thinking: false }
    else if (reasoning_effort) body.reasoning_effort = reasoning_effort
  } else if (preset.thinking === 'openrouter_reasoning') {
    body.reasoning = thinkingOff ? { enabled: false } : reasoning_effort ? { effort: reasoning_effort } : undefined
    if (body.reasoning === undefined) delete body.reasoning
  } else if (preset.thinking === 'groq') {
    // Groq's Qwen 3.8 27B reasons only when asked (its default is none, and the docs disagree on whether
    // "none" itself is accepted), so "off" sends nothing; on, only the efforts Groq lists for this model.
    if (!thinkingOff && typeof reasoning_effort === 'string' && ['low', 'medium', 'high'].includes(reasoning_effort)) body.reasoning_effort = reasoning_effort
  } else {
    body.reasoning_effort = thinkingOff ? 'none' : (reasoning_effort ?? undefined)
    if (body.reasoning_effort === undefined) delete body.reasoning_effort
  }
  if (stream) {
    body.stream = true
    if (preset.includeUsage) body.stream_options = { include_usage: true }
  }
  const extra = extraBody ? Object.fromEntries(Object.entries(extraBody).filter(([k]) => !(preset.forbiddenExtra ?? []).includes(k))) : undefined
  return mergeBody(body, preset.extraBody, extra, preset.lockedBody)
}

async function readCappedText(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
      if (out.length > max) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    /* a broken body reads as what arrived */
  }
  return out.slice(0, max)
}

/**
 * Wraps a streamed body so that silence longer than `idleMs`, or a whole answer
 * longer than `totalMs`, ends it with a timeout error; cancelling the wrapper
 * cancels the provider's stream (the student pressed Stop).
 */
export function guardStream(source: ReadableStream<Uint8Array>, idleMs: number, totalMs: number): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let idle: ReturnType<typeof setTimeout> | undefined
  let total: ReturnType<typeof setTimeout> | undefined
  let rejectTimeout: ((e: unknown) => void) | undefined
  const timedOut = new Promise<never>((_, reject) => {
    rejectTimeout = reject
  })
  timedOut.catch(() => undefined)
  const fail = (): void => rejectTimeout?.(new UpstreamError('timeout'))
  const clear = (): void => {
    if (idle) clearTimeout(idle)
    if (total) clearTimeout(total)
  }
  return new ReadableStream<Uint8Array>({
    start() {
      total = setTimeout(fail, totalMs)
    },
    async pull(controller) {
      if (idle) clearTimeout(idle)
      idle = setTimeout(fail, idleMs)
      try {
        const r = await Promise.race([reader.read(), timedOut])
        if (r.done) {
          clear()
          controller.close()
        } else controller.enqueue(r.value)
      } catch (err) {
        clear()
        void reader.cancel().catch(() => undefined)
        controller.error(err instanceof UpstreamError ? err : new UpstreamError('malformed'))
      }
    },
    async cancel(reason) {
      clear()
      await reader.cancel(reason).catch(() => undefined)
    }
  })
}

/**
 * OpenRouter's key-information API (GET /api/v1/key): the account's free-request counter for
 * the UTC day and its credit limits. Only the fields the operator needs; no label or hash.
 */
export async function openRouterAccount(apiKey: string, doFetch: typeof fetch = (...a) => fetch(...a)): Promise<Record<string, unknown>> {
  const res = await doFetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) return { error: `http ${res.status}` }
  const d = ((await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null)?.data ?? {}
  return { freeRequestsToday: d.free_model_daily_requests, isFreeTier: d.is_free_tier, limit: d.limit, limitRemaining: d.limit_remaining, usage: d.usage }
}

/** True when a limit header shows more than the free plan allows (an upgraded, billable account). */
export function planUpgraded(preset: ProviderPreset, headers: Headers): boolean {
  for (const g of preset.planGuard ?? []) {
    const v = Number(headers.get(g.header))
    if (headers.has(g.header) && Number.isFinite(v) && v > g.maxFree) return true
  }
  return false
}

/** An OpenAI-compatible provider with Inkling's timeouts and bounded retries. */
export function externalProvider(opts: ExternalOptions): AiBinding {
  const preset = PRESETS[opts.id]
  const baseUrl = (opts.baseUrl || preset.baseUrl).replace(/\/+$/, '')
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(baseUrl)) throw new Error('provider base URL must be https')
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = opts.random ?? Math.random
  const maxAttempts = Math.min(4, Math.max(1, opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts))
  const firstByteMs = opts.firstByteTimeoutMs ?? DEFAULT_RETRY.firstByteTimeoutMs
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_RETRY.idleTimeoutMs
  const totalMs = opts.totalTimeoutMs ?? DEFAULT_RETRY.totalTimeoutMs
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_RETRY.maxBackoffMs
  const budget = opts.retryBudgetMs ?? DEFAULT_RETRY.retryBudgetMs

  return {
    async run(model, inputs, hooks) {
      const body = JSON.stringify(toProviderBody(preset, model, inputs, opts.extraBody))
      const streamed = inputs.stream === true
      let waited = 0
      for (let attempt = 1; ; attempt++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), firstByteMs)
        let failure: UpstreamError
        try {
          const res = await doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${opts.apiKey}`,
              'content-type': 'application/json',
              accept: streamed ? 'text/event-stream' : 'application/json',
              ...(opts.id === 'openrouter' ? { 'x-title': 'Inkling' } : {})
            },
            body,
            signal: ctrl.signal
          })
          clearTimeout(timer)
          // The account's limits say it is on a paid plan: don't read on (or retry), stop everything.
          if (planUpgraded(preset, res.headers)) {
            void res.body?.cancel().catch(() => undefined)
            throw new UpstreamError('paid_plan', res.status)
          }
          if (res.ok) {
            const type = res.headers.get('content-type') ?? ''
            if (streamed && res.body && /event-stream/i.test(type)) return guardStream(res.body, idleMs, totalMs)
            // A whole JSON body (non-streamed request, or a host that ignored stream): read it, capped
            // and within the whole-answer time limit (aborting the request also ends the body).
            const bodyTimer = setTimeout(() => ctrl.abort(), totalMs)
            const text = await readCappedText(res, 2_000_000).finally(() => clearTimeout(bodyTimer))
            if (ctrl.signal.aborted) throw new UpstreamError('timeout', res.status)
            let json: unknown
            try {
              json = JSON.parse(text)
            } catch {
              // The provider has done (and billed) the work: don't ask again.
              throw new UpstreamError('malformed', res.status)
            }
            const err = (json as { error?: { code?: unknown; status?: unknown } } | null)?.error
            if (err) {
              const status = typeof err.code === 'number' ? err.code : typeof err.status === 'number' ? err.status : 500
              throw new UpstreamError(kindOfStatus(status, JSON.stringify(err).slice(0, 500)), status)
            }
            if (!json || typeof json !== 'object' || !Array.isArray((json as { choices?: unknown }).choices)) throw new UpstreamError('malformed', res.status)
            return json
          }
          const errBody = await readCappedText(res, 4_000)
          const kind = kindOfStatus(res.status, errBody)
          failure = new UpstreamError(kind, res.status, retryAfterSeconds(res.headers.get('retry-after')) ?? resetSeconds(res.headers.get('x-ratelimit-reset')))
          if (!RETRYABLE.has(res.status) || kind === 'credits' || (res.status === 429 && opts.retryRateLimit === false)) throw failure
        } catch (err) {
          clearTimeout(timer)
          if (err instanceof UpstreamError && err.kind === 'paid_plan') throw err
          if (err instanceof UpstreamError && !(err.status && RETRYABLE.has(err.status) && err.kind !== 'credits' && !(err.status === 429 && opts.retryRateLimit === false))) throw err
          failure = err instanceof UpstreamError ? err : new UpstreamError(ctrl.signal.aborted ? 'timeout' : 'other')
        }
        // Retry: bounded attempts, exponential backoff with jitter, honouring a short Retry-After.
        if (attempt >= maxAttempts) throw failure
        const backoff = Math.min(maxBackoff, 500 * 2 ** (attempt - 1)) * (0.5 + random())
        const asked = failure.retryAfterS !== undefined ? failure.retryAfterS * 1000 : undefined
        if (asked !== undefined && asked > maxBackoff) throw failure
        const delay = Math.min(maxBackoff, Math.max(backoff, asked ?? 0))
        if (waited + delay > budget) throw failure
        hooks?.onRetry?.(failure.kind, attempt)
        waited += delay
        await sleep(delay)
      }
    }
  }
}
