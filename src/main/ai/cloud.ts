/**
 * Inkling's free cloud AI as a tutor provider: a small server on Cloudflare
 * Workers (beta-server/) that answers with Workers AI (Qwen 3.8 27B).
 *
 * No account, code or key: each request carries this installation's random
 * ID, which the server uses (with the network address) to share out the free
 * daily allowance. The app sends the task and the conversation — the same
 * validated request every provider gets — and the server chooses the
 * instructions, output format and token caps. It reports what is left with
 * every answer.
 *
 * Plain fetch with server-sent events; no Electron imports, so it is tested
 * against the real server code with a fake model (tests/support/fakeBeta.mjs).
 */
import type { AiErrorCode, CloudQuota } from '@shared/ai'
import { CLOUD_MODEL, CLOUD_MODEL_LABEL } from '@shared/ai'
import { ProviderError, type AiProvider, type ProviderChunk, type ProviderModel, type ProviderRequest } from './provider'

/** The model works fast, but a big image and a long structured answer can take a while. */
const FIRST_TOKEN_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 60_000
const STATUS_TIMEOUT_MS = 15_000

export interface CloudOptions {
  baseUrl: string
  /** This installation's anonymous ID. */
  installId: string
  /** Called whenever the server reports the allowance (status and every answer). */
  onQuota?: (quota: CloudQuota) => void
}

export interface CloudStatus {
  model: string
  paused: boolean
  quota: CloudQuota
}

interface ServerError {
  code?: string
  message?: string
  retryAfter?: number
  scope?: string
  quota?: CloudQuota
}

const KNOWN_CODES = new Set<AiErrorCode>(['invalid_key', 'rate_limited', 'daily_quota', 'model_unavailable', 'server', 'bad_request', 'busy', 'bad_response', 'beta_closed'])

export class CloudProvider implements AiProvider {
  readonly id = 'cloud'
  private readonly baseUrl: string

  constructor(private readonly options: CloudOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  /** Today's allowance for this installation. Costs no model usage. */
  async status(signal?: AbortSignal): Promise<CloudStatus> {
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/status`, { headers: this.headers(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (err) {
      throw networkError(err, { aborted: !!signal?.aborted, timedOut: timeout.aborted && !signal?.aborted })
    }
    const body = (await res.json().catch(() => null)) as (CloudStatus & { error?: ServerError }) | null
    if (!res.ok || !body || body.error) throw serverError(res.status, body?.error)
    if (!body.quota) throw new ProviderError('bad_response', 'Something answered at this address, but it isn’t Inkling’s AI server.')
    this.options.onQuota?.(body.quota)
    return body
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const s = await this.status(signal)
    return [{ id: s.model, displayName: s.model === CLOUD_MODEL ? CLOUD_MODEL_LABEL : s.model, canGenerate: !s.paused, vision: true }]
  }

  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (!request.task) throw new ProviderError('bad_request', 'The cloud AI answers tutor tasks only.')
    const controller = new AbortController()
    const outer = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, ms)
    }
    arm(FIRST_TOKEN_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/tutor`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json', accept: 'text/event-stream' },
        // Only the task and the conversation: the server owns the instructions.
        body: JSON.stringify({ task: request.task, turns: request.turns }),
        signal: outer
      })
    } catch (err) {
      if (timer) clearTimeout(timer)
      throw networkError(err, { aborted: !!signal?.aborted, timedOut })
    }
    if (!res.ok || !res.body) {
      if (timer) clearTimeout(timer)
      const body = (await res.json().catch(() => null)) as { error?: ServerError } | null
      if (body?.error?.quota) this.options.onQuota?.(body.error.quota)
      throw serverError(res.status, body?.error)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let ended = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        arm(IDLE_TIMEOUT_MS)
        buf += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (!event || data === undefined) continue
          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(data)
          } catch {
            throw new ProviderError('bad_response', 'Inkling’s AI server sent a reply the app could not read. Try again.')
          }
          if (event === 'delta' && typeof payload.text === 'string') yield { type: 'text', text: payload.text }
          else if (event === 'error') {
            const e = payload as ServerError
            if (e.quota) this.options.onQuota?.(e.quota)
            throw serverError(502, e)
          } else if (event === 'done') {
            ended = true
            if (payload.quota) this.options.onQuota?.(payload.quota as CloudQuota)
            const u = (payload.usage ?? {}) as { inputTokens?: number; outputTokens?: number }
            yield {
              type: 'end',
              usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, ...(typeof payload.neurons === 'number' ? { neurons: payload.neurons } : {}) },
              finishReason: typeof payload.finishReason === 'string' ? payload.finishReason : undefined
            }
          }
        }
      }
      if (!ended) throw new ProviderError('network', 'The connection to Inkling’s AI server closed before the answer was complete. Try again.')
    } catch (err) {
      void reader.cancel().catch(() => undefined)
      throw networkError(err, { aborted: !!signal?.aborted, timedOut })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private headers(): Record<string, string> {
    return { 'x-inkling-install': this.options.installId }
  }
}

function serverError(status: number, e: ServerError | undefined): ProviderError {
  const code = (e?.code && KNOWN_CODES.has(e.code as AiErrorCode) ? e.code : status === 401 ? 'invalid_key' : status === 429 ? 'rate_limited' : status >= 500 ? 'server' : 'unknown') as AiErrorCode
  const message =
    e?.message ??
    (status === 404
      ? 'Inkling’s AI server could not be found. Update Inkling, or choose another AI in settings.'
      : `Inkling’s AI server returned an error (${status}). Try again in a moment.`)
  return new ProviderError(code, message, e?.retryAfter)
}

function networkError(err: unknown, ctx: { aborted: boolean; timedOut: boolean }): ProviderError {
  if (err instanceof ProviderError) return err
  if (ctx.aborted) return new ProviderError('canceled', 'Stopped.')
  if (ctx.timedOut) return new ProviderError('network', 'Inkling’s AI server took too long to answer. Try again, perhaps with a smaller selection.')
  const e = err as { name?: string; message?: string }
  if (e?.name === 'AbortError') return new ProviderError('canceled', 'Stopped.')
  return new ProviderError('network', 'Couldn’t reach Inkling’s AI server. Check your internet connection and try again. Your notebooks work as usual offline.')
}
