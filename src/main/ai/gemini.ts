/**
 * Google Gemini through the official Gen AI SDK (`@google/genai`).
 *
 * Kept free of Electron imports so it can be tested against a local fake of
 * the Gemini REST API (see tests/support/fakeGemini.mjs). Every failure is
 * translated into a ProviderError with a message a student can act on, plus a
 * `detail` that keeps what Google actually answered (HTTP status, Google's
 * status and reason, its message), with any key redacted.
 *
 * Transient failures (500/502/503/504 and dropped connections) are retried
 * with exponential backoff, but only before any text has been shown, so an
 * answer is never duplicated. Bad keys, permissions, quotas, unknown models
 * and bad requests are never retried: retrying cannot fix them and would only
 * spend the user's free quota.
 */
import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from '@google/genai'
import { redactKeys, type AiTurn } from '@shared/ai'
import { ProviderError, type AiProvider, type ProviderChunk, type ProviderModel, type ProviderRequest } from './provider'

const REQUEST_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 20_000
const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE'])

export interface RetryPolicy {
  /** Tries in all, including the first. 1 turns retrying off. */
  attempts: number
  /** Wait before the first retry; doubles each time (with jitter), up to maxDelayMs. */
  baseDelayMs: number
  maxDelayMs: number
}
/** Three tries, about 1 s then 2 s apart: rides out a brief overload without making the student wait long. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 }

export interface GeminiOptions {
  apiKey: string
  /** Overrides the API endpoint (used by tests with a local fake server). */
  baseUrl?: string
  retry?: Partial<RetryPolicy>
  /** Where diagnostic lines go (main-process console by default). Lines never contain a key. */
  log?: (line: string) => void
  /** Random source for jitter (tests make it fixed). */
  random?: () => number
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini'
  private readonly ai: GoogleGenAI
  private readonly retry: RetryPolicy
  private readonly log: (line: string) => void
  private readonly random: () => number

  constructor(options: GeminiOptions) {
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {})
    })
    this.retry = { ...DEFAULT_RETRY, ...options.retry }
    this.log = options.log ?? ((line) => console.warn(line))
    this.random = options.random ?? Math.random
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const { signal: s, timedOut } = withTimeout(signal, LIST_TIMEOUT_MS)
    const fail = (err: unknown): ProviderError => classifyError(err, { aborted: signal?.aborted ?? false, timedOut: timedOut() })
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.listOnce(s)
      } catch (err) {
        await this.afterFailure(fail(err), attempt, 'list models', s, fail)
      }
    }
  }

  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const { signal: s, timedOut } = withTimeout(signal, REQUEST_TIMEOUT_MS)
    const fail = (err: unknown): ProviderError => classifyError(err, { aborted: signal?.aborted ?? false, timedOut: timedOut(), model: request.model })
    for (let attempt = 1; ; attempt++) {
      let produced = false
      try {
        for await (const chunk of this.streamOnce(request, s)) {
          if (chunk.type === 'text') produced = true
          yield chunk
        }
        return
      } catch (err) {
        const error = fail(err)
        // Once text is on screen a retry would repeat it: report the failure instead.
        if (produced) throw this.report(error, attempt, request.model)
        await this.afterFailure(error, attempt, request.model, s, fail)
      }
    }
  }

  /** Throws the error if it should not be retried; otherwise logs and waits out the backoff. */
  private async afterFailure(error: ProviderError, attempt: number, what: string, signal: AbortSignal, fail: (err: unknown) => ProviderError): Promise<void> {
    if (!error.retryable || attempt >= this.retry.attempts) throw this.report(error, attempt, what)
    const delay = backoffDelay(attempt, this.retry, this.random)
    this.log(`[gemini] ${what}: attempt ${attempt} of ${this.retry.attempts} failed (${error.detail ?? error.code}); retrying in ${(delay / 1000).toFixed(1)} s`)
    try {
      await sleep(delay, signal)
    } catch (err) {
      throw fail(err)
    }
  }

  /** Logs the final failure and returns it, noting how many tries were made. */
  private report(error: ProviderError, attempt: number, what: string): ProviderError {
    if (error.code === 'canceled') return error
    const tries = attempt > 1 ? ` after ${attempt} attempts` : ''
    this.log(`[gemini] ${what} failed${tries}: ${error.detail ?? `${error.code}: ${error.message}`}`)
    if (!tries || !error.detail) return error
    return new ProviderError(error.code, error.message, error.retryAfter, { detail: `${error.detail} (${attempt} attempts)`, retryable: error.retryable })
  }


  private async listOnce(signal: AbortSignal): Promise<ProviderModel[]> {
    const pager = await this.ai.models.list({ config: { pageSize: 100, abortSignal: signal } })
    const out: ProviderModel[] = []
    for await (const m of pager) {
      if (!m.name) continue
      out.push({
        id: m.name.replace(/^models\//, ''),
        displayName: m.displayName,
        inputTokenLimit: m.inputTokenLimit,
        canGenerate: !m.supportedActions || m.supportedActions.includes('generateContent')
      })
      if (out.length > 500) break
    }
    return out
  }

  private async *streamOnce(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderChunk> {
    const stream: AsyncGenerator<GenerateContentResponse> = await this.ai.models.generateContentStream({
      model: request.model,
      contents: toContents(request.turns),
      config: {
        abortSignal: signal,
        systemInstruction: request.system,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema } : {})
      }
    })
    let usage = {}
    let finishReason: string | undefined
    let produced = false
    for await (const chunk of stream) {
      const blocked = chunk.promptFeedback?.blockReason
      if (blocked) throw new ProviderError('blocked', 'Gemini declined to answer this request. Try rephrasing it or selecting a different part of the page.', undefined, { detail: `promptFeedback.blockReason ${blocked}` })
      const candidate = chunk.candidates?.[0]
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('')
      if (text) {
        produced = true
        yield { type: 'text', text }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason
      if (chunk.usageMetadata) {
        usage = { inputTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount }
      }
    }
    if (finishReason && BLOCKED_REASONS.has(finishReason) && !produced) {
      throw new ProviderError('blocked', 'Gemini declined to answer this request. Try rephrasing it or selecting a different part of the page.', undefined, { detail: `finishReason ${finishReason}` })
    }
    yield { type: 'end', usage, finishReason }
  }
}

/** Exponential backoff with jitter: base, 2×base, 4×base… (each 50–100 % of that), capped at maxDelayMs. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(exp * (0.5 + random() * 0.5))
}

function toContents(turns: AiTurn[]): Content[] {
  return turns.map((t) => ({
    role: t.role,
    parts: t.parts.map((p): Part => ('text' in p ? { text: p.text } : { inlineData: { mimeType: p.image.mimeType, data: p.image.data } }))
  }))
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean } {
  const timeout = AbortSignal.timeout(ms)
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timedOut: () => timeout.aborted }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const done = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface GoogleErrorDetail {
  '@type'?: string
  retryDelay?: string
  reason?: string
  domain?: string
  metadata?: Record<string, string>
  violations?: Array<{ quotaId?: string; quotaValue?: string }>
}
interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: GoogleErrorDetail[] }
}

/**
 * Parses the JSON error body the SDK puts in ApiError.message: the whole body for an
 * HTTP error, or "got status: X. {body}" for an error sent inside a stream.
 */
function parseBody(message: string): GoogleErrorBody['error'] | undefined {
  const start = message.indexOf('{')
  if (start < 0) return undefined
  try {
    return (JSON.parse(message.slice(start)) as GoogleErrorBody).error
  } catch {
    return undefined
  }
}

const seconds = (delay: string | undefined): number | undefined => {
  const m = delay?.match(/^(\d+(?:\.\d+)?)s$/)
  return m ? Math.ceil(Number(m[1])) : undefined
}

/** Seconds until the next midnight in America/Los_Angeles, when daily quotas reset. */
export function secondsUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: Number(p.value) }), {})
  const elapsed = (parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)
  return Math.max(60, 86_400 - elapsed)
}

/** Key restrictions set in Google Cloud console that stop this app from using the key. */
const RESTRICTION_REASONS = new Set(['API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED'])

export function classifyError(err: unknown, ctx: { aborted: boolean; timedOut: boolean; model?: string }): ProviderError {
  if (err instanceof ProviderError) return err
  if (ctx.aborted) return new ProviderError('canceled', 'Stopped.')
  if (ctx.timedOut) return new ProviderError('network', 'Gemini took too long to respond. Check your connection and try again.', undefined, { detail: 'No complete answer within the time limit' })
  const model = ctx.model ? `“${ctx.model}”` : 'this model'

  if (err instanceof ApiError) {
    const body = parseBody(err.message)
    const text = body?.message ?? err.message
    const details = body?.details ?? []
    const retry = seconds(details.find((d) => d['@type']?.endsWith('RetryInfo'))?.retryDelay)
    const reasons = details.map((d) => d.reason).filter((r): r is string => !!r)
    const violations = details.flatMap((d) => d.violations ?? [])
    const said = shorten(text)
    const detail = `HTTP ${err.status}${body?.status ? ` ${body.status}` : ''}${reasons.length ? ` (${reasons.join(', ')})` : ''}: ${said}`
    const make = (code: ConstructorParameters<typeof ProviderError>[0], message: string, retryAfter?: number, retryable = false): ProviderError =>
      new ProviderError(code, message, retryAfter, { detail, retryable })

    switch (err.status) {
      case 400:
        if (reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(text)) {
          return make('invalid_key', 'Google rejected this API key as not valid. Check that you copied the whole key from Google AI Studio, or create a new one.')
        }
        if (reasons.includes('API_KEY_EXPIRED') || /api key expired/i.test(text)) {
          return make('invalid_key', 'This API key has expired. Create a new key in Google AI Studio.')
        }
        if (/location is not supported/i.test(text)) {
          return make('bad_request', 'Google does not offer the Gemini API free tier in your region.')
        }
        if (body?.status === 'FAILED_PRECONDITION') {
          return make('permission_denied', `Google won’t serve this key’s project yet: ${said}`)
        }
        return make('bad_request', `Google could not process this request: ${said}`)
      case 401:
        return make('invalid_key', `Google could not authenticate this key (${said}). Check that you copied the whole key from Google AI Studio, or create a new one.`)
      case 403:
        if (/unregistered callers/i.test(text)) {
          // Google didn't recognise any key on the request.
          return make('invalid_key', 'Google did not recognise this API key. Check that you copied the whole key from Google AI Studio, or create a new one.')
        }
        if (/reported as leaked/i.test(text)) {
          return make('invalid_key', 'Google has blocked this key because it was reported as leaked. Create a new key in Google AI Studio.')
        }
        if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(text)) {
          return make('permission_denied', 'Your key is real, but the Gemini API (Generative Language API) is turned off for its Google Cloud project. Turn it on in Google Cloud console, or use a key made in Google AI Studio.')
        }
        if (reasons.some((r) => RESTRICTION_REASONS.has(r))) {
          return make('permission_denied', 'Your key is real, but restrictions set on it in Google Cloud console block Inkling from using the Gemini API. Allow the Generative Language API for this key, or use an unrestricted key from Google AI Studio.')
        }
        if (/billing/i.test(text)) {
          return make('permission_denied', `Google refused this request for a billing reason: ${said}`)
        }
        return make('permission_denied', `Google refused access with this key: ${said}`)
      case 404:
        return make('model_unavailable', `Google says the model ${model} is not available to this key. Choose another model in Settings.`)
      case 429: {
        // Never retried automatically: the service waits out the cooldown this sets.
        const noFreeQuota = violations.some((v) => v.quotaValue === '0') || /limit:\s*0\b/.test(text)
        if (noFreeQuota) {
          return make('not_free', `${cap(model)} has no free quota for this API key's project. Inkling only uses free models; choose another model in Settings.`)
        }
        const daily = violations.some((v) => /per\s*day|PerDay/i.test(v.quotaId ?? '')) || /per day|daily/i.test(text)
        if (daily) {
          return make('daily_quota', `You've used today's free Gemini requests for ${model}. The quota resets at midnight Pacific time.`, secondsUntilPacificMidnight())
        }
        return make('rate_limited', `Gemini's free tier allows only a few requests per minute. Try again in ${retry ?? 30} seconds.`, retry ?? 30)
      }
      case 500:
        return make('server', `Google’s Gemini service had an internal error (500) with ${model}. This is on Google’s side, not your key. Try again; if it keeps happening, try a smaller selection or another model.`, 10, true)
      case 502:
        return make('server', 'Google’s servers returned a bad gateway error (502). This is on Google’s side, not your key. Try again in a moment.', 10, true)
      case 503:
        return make('server', `Google says ${model} is overloaded or temporarily unavailable (503). Your key is fine; this is a capacity problem at Google. Try again in a minute, or switch models.`, 10, true)
      case 504:
        return make('server', `Google timed out (504) before ${model} finished. Try again; a smaller selection can help.`, 10, true)
      default:
        return make('unknown', `Gemini returned an unexpected error (${err.status}): ${said}`, undefined, err.status === 408)
    }
  }

  const e = err as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError') return new ProviderError('canceled', 'Stopped.')
  const code = e?.cause?.code ?? ''
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|UND_ERR/.test(code) || /fetch failed|network|terminated/i.test(e?.message ?? '')) {
    // A dropped connection may be momentary; no DNS at all means offline, so retrying won't help.
    const offline = /ENOTFOUND|ENETUNREACH/.test(code)
    return new ProviderError('network', 'Could not reach Gemini. Check your internet connection and try again.', undefined, {
      detail: `Network error${code ? ` ${code}` : ''}: ${shorten(e?.message ?? '')}`,
      retryable: !offline
    })
  }
  return new ProviderError('unknown', `Something went wrong talking to Gemini: ${shorten(e?.message ?? String(err))}`)
}

/** Google's message, shortened, with anything shaped like a key hidden: error text is shown to people. */
const shorten = (raw: string): string => {
  const s = redactKeys(raw)
  return s.length > 200 ? `${s.slice(0, 197)}…` : s
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
