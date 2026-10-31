/**
 * Google Gemini through the official Gen AI SDK (`@google/genai`).
 *
 * Kept free of Electron imports so it can be tested against a local fake of
 * the Gemini REST API (see tests/support/fakeGemini.mjs). Every failure is
 * translated into a ProviderError with a message a student can act on.
 */
import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from '@google/genai'
import { redactKeys, type AiTurn } from '@shared/ai'
import { ProviderError, type AiProvider, type ProviderChunk, type ProviderModel, type ProviderRequest } from './provider'

const REQUEST_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 20_000
const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE'])

export interface GeminiOptions {
  apiKey: string
  /** Overrides the API endpoint (used by tests with a local fake server). */
  baseUrl?: string
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini'
  private readonly ai: GoogleGenAI

  constructor(options: GeminiOptions) {
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {})
    })
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const { signal: s, timedOut } = withTimeout(signal, LIST_TIMEOUT_MS)
    try {
      const pager = await this.ai.models.list({ config: { pageSize: 100, abortSignal: s } })
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
    } catch (err) {
      throw classifyError(err, { aborted: signal?.aborted ?? false, timedOut: timedOut() })
    }
  }

  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const { signal: s, timedOut } = withTimeout(signal, REQUEST_TIMEOUT_MS)
    const fail = (err: unknown): ProviderError => classifyError(err, { aborted: signal?.aborted ?? false, timedOut: timedOut(), model: request.model })
    let stream: AsyncGenerator<GenerateContentResponse>
    try {
      stream = await this.ai.models.generateContentStream({
        model: request.model,
        contents: toContents(request.turns),
        config: {
          abortSignal: s,
          systemInstruction: request.system,
          maxOutputTokens: request.maxOutputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema } : {})
        }
      })
    } catch (err) {
      throw fail(err)
    }
    let usage = {}
    let finishReason: string | undefined
    let produced = false
    try {
      for await (const chunk of stream) {
        const blocked = chunk.promptFeedback?.blockReason
        if (blocked) throw new ProviderError('blocked', 'Gemini declined to answer this request. Try rephrasing it or selecting a different part of the page.')
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
    } catch (err) {
      throw err instanceof ProviderError ? err : fail(err)
    }
    if (finishReason && BLOCKED_REASONS.has(finishReason) && !produced) {
      throw new ProviderError('blocked', 'Gemini declined to answer this request. Try rephrasing it or selecting a different part of the page.')
    }
    yield { type: 'end', usage, finishReason }
  }
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

interface GoogleErrorBody {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Array<{ '@type'?: string; retryDelay?: string; reason?: string; violations?: Array<{ quotaId?: string; quotaValue?: string }> }>
  }
}

/** Parses the JSON error body the SDK puts in ApiError.message. */
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

export function classifyError(err: unknown, ctx: { aborted: boolean; timedOut: boolean; model?: string }): ProviderError {
  if (err instanceof ProviderError) return err
  if (ctx.aborted) return new ProviderError('canceled', 'Stopped.')
  if (ctx.timedOut) return new ProviderError('network', 'Gemini took too long to respond. Check your connection and try again.')
  const model = ctx.model ? `“${ctx.model}”` : 'this model'

  if (err instanceof ApiError) {
    const body = parseBody(err.message)
    const text = body?.message ?? err.message
    const details = body?.details ?? []
    const retry = seconds(details.find((d) => d['@type']?.endsWith('RetryInfo'))?.retryDelay)
    const reasons = details.map((d) => d.reason).filter(Boolean)
    const violations = details.flatMap((d) => d.violations ?? [])
    switch (err.status) {
      case 400:
        if (reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(text)) {
          return new ProviderError('invalid_key', 'Google rejected this API key. Check that you copied the whole key from Google AI Studio.')
        }
        if (/location is not supported/i.test(text)) {
          return new ProviderError('bad_request', 'The Gemini API free tier is not available in your region.')
        }
        return new ProviderError('bad_request', `Gemini could not process this request: ${shorten(text)}`)
      case 401:
      case 403:
        return new ProviderError('invalid_key', `Google refused access with this API key (${shorten(text)}). Create a new key in Google AI Studio and try again.`)
      case 404:
        return new ProviderError('model_unavailable', `The model ${model} is not available for this API key. Choose another model in Settings.`)
      case 429: {
        const noFreeQuota = violations.some((v) => v.quotaValue === '0') || /limit:\s*0\b/.test(text)
        if (noFreeQuota) {
          return new ProviderError('not_free', `${cap(model)} has no free quota for this API key's project. Inkling only uses free models; choose another model in Settings.`)
        }
        const daily = violations.some((v) => /per\s*day|PerDay/i.test(v.quotaId ?? '')) || /per day|daily/i.test(text)
        if (daily) {
          return new ProviderError(
            'daily_quota',
            `You've used today's free Gemini requests for ${model}. The quota resets at midnight Pacific time.`,
            secondsUntilPacificMidnight()
          )
        }
        return new ProviderError('rate_limited', `Gemini's free tier allows only a few requests per minute. Try again in ${retry ?? 30} seconds.`, retry ?? 30)
      }
      case 500:
      case 502:
      case 503:
      case 504:
        return new ProviderError('server', 'Gemini is busy or temporarily unavailable. Try again in a moment.', 10)
      default:
        return new ProviderError('unknown', `Gemini returned an error (${err.status}): ${shorten(text)}`)
    }
  }

  const e = err as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError') return new ProviderError('canceled', 'Stopped.')
  const code = e?.cause?.code ?? ''
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|UND_ERR/.test(code) || /fetch failed|network/i.test(e?.message ?? '')) {
    return new ProviderError('network', 'Could not reach Gemini. Check your internet connection and try again.')
  }
  return new ProviderError('unknown', `Something went wrong talking to Gemini: ${shorten(e?.message ?? String(err))}`)
}

/** Google's message, shortened, with anything shaped like a key hidden: error text is shown to people. */
const shorten = (raw: string): string => {
  const s = redactKeys(raw)
  return s.length > 200 ? `${s.slice(0, 197)}…` : s
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
