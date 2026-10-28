/**
 * The AI service in the main process. Every model request passes through
 * here: it checks consent and the key, picks the task's instructions, guards
 * the free quota (one request at a time, a per-minute budget, no accidental
 * repeats, and waiting out rate limits instead of hammering the API), streams
 * the answer to the renderer and validates structured answers.
 *
 * It never changes the model by itself; when a free quota runs out it only
 * suggests the other free model, which the user can pick in Settings.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  GEMINI_MODELS,
  LITE_MODEL,
  DEFAULT_MODEL,
  type AiError,
  type AiEvent,
  type AiModelId,
  type AiRequest,
  type AiStartResult,
  type AiStatus,
  type AiTestResult,
  type ModelAvailability
} from '@shared/ai'
import { parseTaskResult } from '@shared/tutor'
import type { AiConfig } from './config'
import { ProviderError, type AiProvider, type ProviderModel } from './provider'
import { TASKS } from './prompts'

export interface AiServiceOptions {
  config: AiConfig
  makeProvider: (apiKey: string) => AiProvider
  emit: (event: AiEvent) => void
  now?: () => number
  limits?: Partial<Limits>
}

interface Limits {
  /** Minimum gap between two requests. */
  minIntervalMs: number
  /** Requests allowed in any 60 seconds (kept below the free tier's per-minute limits). */
  perMinute: number
  /** The same request again within this window is treated as an accidental repeat. */
  duplicateWindowMs: number
}
const DEFAULT_LIMITS: Limits = { minIntervalMs: 1500, perMinute: 8, duplicateWindowMs: 10_000 }

interface Cooldown {
  until: number
  reason: 'rate_limited' | 'daily_quota'
  message: string
}

export class AiService {
  private readonly config: AiConfig
  private readonly makeProvider: (apiKey: string) => AiProvider
  private readonly emit: (event: AiEvent) => void
  private readonly now: () => number
  private readonly limits: Limits
  private provider: AiProvider | null = null
  private providerKey: string | null = null
  private models: ProviderModel[] | null = null
  private modelsCheckedAt: string | null = null
  private readonly cooldowns = new Map<AiModelId, Cooldown>()
  private readonly started: number[] = []
  private active: { id: string; controller: AbortController } | null = null
  private last: { hash: string; at: number; failed: boolean } | null = null

  constructor(options: AiServiceOptions) {
    this.config = options.config
    this.makeProvider = options.makeProvider
    this.emit = options.emit
    this.now = options.now ?? Date.now
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
  }

  status(): AiStatus {
    const model = this.config.model
    const cd = this.cooldownFor(model)
    return {
      provider: 'gemini',
      model,
      hasKey: !!this.config.apiKey,
      keyHint: this.config.keyHint,
      keyProtection: this.config.keyProtection,
      consented: this.config.consented,
      models: this.availability(),
      modelsCheckedAt: this.modelsCheckedAt,
      cooldown: cd ? { until: new Date(cd.until).toISOString(), reason: cd.reason, model } : null
    }
  }

  async setKey(key: string): Promise<AiStatus> {
    await this.config.setKey(key)
    this.resetProvider()
    return this.status()
  }

  async clearKey(): Promise<AiStatus> {
    this.cancelActive()
    await this.config.clearKey()
    this.resetProvider()
    return this.status()
  }

  async setModel(model: AiModelId): Promise<AiStatus> {
    await this.config.setModel(model)
    return this.status()
  }

  async setConsent(accepted: boolean): Promise<AiStatus> {
    if (!accepted) this.cancelActive()
    await this.config.setConsent(accepted)
    return this.status()
  }

  /** Fetches the models this key can use and marks which supported ones exist. */
  async refreshModels(): Promise<{ ok: true; models: ModelAvailability[] } | { ok: false; error: AiError }> {
    const provider = this.getProvider()
    if (!provider) return { ok: false, error: noKey() }
    try {
      this.models = await provider.listModels()
      this.modelsCheckedAt = new Date(this.now()).toISOString()
      return { ok: true, models: this.availability() }
    } catch (err) {
      return { ok: false, error: toAiError(err) }
    }
  }

  /**
   * Checks the key and model with the smallest useful request: lists models,
   * then asks the selected model for a one-word reply. Sends no notebook content.
   */
  async test(): Promise<AiTestResult> {
    const provider = this.getProvider()
    if (!provider) return { ok: false, error: noKey() }
    const blocked = this.admit(null, { explicit: true })
    if (blocked) return { ok: false, error: blocked }
    const model = this.config.model
    const startedAt = this.now()
    this.started.push(startedAt)
    try {
      this.models = await provider.listModels()
      this.modelsCheckedAt = new Date(this.now()).toISOString()
      const listed = this.availability().find((m) => m.id === model)
      if (listed?.status === 'missing') {
        return { ok: false, error: { code: 'model_unavailable', message: `Your key works, but ${model} is not offered to it. Choose another model.`, suggestModel: other(model) } }
      }
      const stream = provider.stream({ model, system: 'Reply with exactly: OK', turns: [{ role: 'user', parts: [{ text: 'Connection test' }] }], maxOutputTokens: 64, temperature: 0 })
      for await (const chunk of stream) void chunk
      this.cooldowns.delete(model)
      return { ok: true, model, latencyMs: this.now() - startedAt, models: this.availability() }
    } catch (err) {
      const error = toAiError(err)
      this.noteFailure(model, error)
      return { ok: false, error: this.withSuggestion(model, error) }
    }
  }

  /** Starts a streamed request. Results arrive as AiEvents with the returned id. */
  start(request: AiRequest): AiStartResult {
    if (!this.config.consented) {
      return { error: { code: 'consent_required', message: 'Allow Inkling to send notebook content to Google Gemini first (AI settings).' } }
    }
    const provider = this.getProvider()
    if (!provider) return { error: noKey() }
    const model = this.config.model
    const hash = createHash('sha256').update(model).update(JSON.stringify(request)).digest('hex')
    const blocked = this.admit(hash)
    if (blocked) return { error: blocked }

    const id = randomUUID()
    const controller = new AbortController()
    this.active = { id, controller }
    this.started.push(this.now())
    this.last = { hash, at: this.now(), failed: false }
    void this.run(id, provider, model, request, controller)
    return { requestId: id }
  }

  cancel(requestId: string): void {
    if (this.active?.id === requestId) this.cancelActive()
  }

  private async run(id: string, provider: AiProvider, model: AiModelId, request: AiRequest, controller: AbortController): Promise<void> {
    const spec = TASKS[request.task]
    let text = ''
    try {
      let usage = {}
      let finishReason: string | undefined
      for await (const chunk of provider.stream(
        { model, system: spec.system, turns: request.turns, jsonSchema: spec.jsonSchema, maxOutputTokens: spec.maxOutputTokens, temperature: spec.temperature },
        controller.signal
      )) {
        if (chunk.type === 'text') {
          text += chunk.text
          // Structured answers are only useful once complete.
          if (!spec.jsonSchema) this.emit({ requestId: id, type: 'delta', text: chunk.text })
        } else {
          usage = chunk.usage
          finishReason = chunk.finishReason
        }
      }
      if (request.task !== 'chat' && !parseTaskResult(request.task, text)) {
        const cut = finishReason === 'MAX_TOKENS'
        throw new ProviderError('bad_response', cut ? 'Gemini’s answer was cut off before it was complete. Try again, perhaps with a smaller selection.' : 'Gemini’s answer was not in the expected format. Try again.')
      }
      if (!text.trim()) throw new ProviderError('bad_response', 'Gemini returned an empty answer. Try again.')
      this.cooldowns.delete(model)
      this.emit({ requestId: id, type: 'done', text, usage, model })
    } catch (err) {
      const error = this.withSuggestion(model, toAiError(err))
      if (this.last) this.last.failed = true
      this.noteFailure(model, error)
      this.emit({ requestId: id, type: 'error', error })
    } finally {
      if (this.active?.id === id) this.active = null
    }
  }

  /**
   * Returns why a request may not be sent now, or null if it may. An explicit
   * connection test skips the anti-double-click gap and a known cooldown (the
   * user wants to know if it has passed) but still counts toward the budget.
   */
  private admit(hash: string | null, opts: { explicit?: boolean } = {}): AiError | null {
    const now = this.now()
    if (this.active) return { code: 'busy', message: 'The tutor is still answering. Wait for it to finish or press Stop.' }
    const model = this.config.model
    const cd = this.cooldownFor(model)
    if (cd && !opts.explicit) {
      const wait = Math.ceil((cd.until - now) / 1000)
      return this.withSuggestion(model, { code: cd.reason, message: cd.reason === 'rate_limited' ? `Gemini's free tier needs a short pause. Try again in ${wait} seconds.` : cd.message, retryAfter: wait })
    }
    if (hash && this.last && this.last.hash === hash && !this.last.failed && now - this.last.at < this.limits.duplicateWindowMs) {
      return { code: 'duplicate', message: 'That request was just sent. Its answer is above.' }
    }
    while (this.started.length && now - this.started[0]! >= 60_000) this.started.shift()
    const lastStart = this.started[this.started.length - 1]
    if (!opts.explicit && lastStart !== undefined && now - lastStart < this.limits.minIntervalMs) {
      return { code: 'rate_limited', message: 'One moment — sending requests too quickly.', retryAfter: Math.ceil((this.limits.minIntervalMs - (now - lastStart)) / 1000) }
    }
    if (this.started.length >= this.limits.perMinute) {
      const wait = Math.ceil((60_000 - (now - this.started[0]!)) / 1000)
      return { code: 'rate_limited', message: `To stay within Gemini's free limits, Inkling sends at most ${this.limits.perMinute} requests a minute. Try again in ${wait} seconds.`, retryAfter: wait }
    }
    return null
  }

  private noteFailure(model: AiModelId, error: AiError): void {
    if ((error.code === 'rate_limited' || error.code === 'daily_quota') && error.retryAfter) {
      this.cooldowns.set(model, { until: this.now() + error.retryAfter * 1000, reason: error.code, message: error.message })
    }
  }

  private withSuggestion(model: AiModelId, error: AiError): AiError {
    const alt = other(model)
    const altFree = !this.cooldownFor(alt) && this.availability().find((m) => m.id === alt)?.status !== 'missing'
    if (altFree && (error.code === 'daily_quota' || error.code === 'not_free' || error.code === 'model_unavailable')) return { ...error, suggestModel: alt }
    return error
  }

  private cooldownFor(model: AiModelId): Cooldown | null {
    const cd = this.cooldowns.get(model)
    if (cd && cd.until > this.now()) return cd
    if (cd) this.cooldowns.delete(model)
    return null
  }

  private availability(): ModelAvailability[] {
    return GEMINI_MODELS.map((m) => {
      const id = m.id as AiModelId
      if (!this.models) return { id, status: 'unknown' as const }
      const found = this.models.find((x) => x.id === id && x.canGenerate)
      return found ? { id, status: 'available' as const, inputTokenLimit: found.inputTokenLimit } : { id, status: 'missing' as const }
    })
  }

  private getProvider(): AiProvider | null {
    const key = this.config.apiKey
    if (!key) return null
    if (!this.provider || this.providerKey !== key) {
      this.provider = this.makeProvider(key)
      this.providerKey = key
    }
    return this.provider
  }

  private resetProvider(): void {
    this.provider = null
    this.providerKey = null
    this.models = null
    this.modelsCheckedAt = null
    this.cooldowns.clear()
    this.last = null
  }

  private cancelActive(): void {
    this.active?.controller.abort()
  }
}

const other = (model: AiModelId): AiModelId => (model === LITE_MODEL ? DEFAULT_MODEL : LITE_MODEL)
const noKey = (): AiError => ({ code: 'no_key', message: 'Add a free Gemini API key in AI settings to use the tutor.' })

function toAiError(err: unknown): AiError {
  if (err instanceof ProviderError) return err.toJSON()
  return { code: 'unknown', message: `Something went wrong: ${(err as Error)?.message ?? String(err)}` }
}
