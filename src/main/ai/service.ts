/**
 * The AI service in the main process. Every model request passes through
 * here, whichever provider answers it: it picks the task's instructions,
 * allows one request at a time (and no accidental repeats), streams the answer
 * to the renderer and validates structured answers before they are delivered.
 *
 * Local Ollama needs no key or consent, since nothing leaves the computer.
 * For Gemini it also checks the key and the user's consent and guards the
 * free quota (a per-minute budget, waiting out rate limits). For the cloud
 * beta it checks the access code and consent, paces requests, and keeps the
 * allowance the server reports with every answer; the server enforces the
 * daily limits itself. It never changes provider or model by itself; it may
 * only suggest one.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  CLOUD_MODEL,
  GEMINI_MODELS,
  LITE_MODEL,
  DEFAULT_MODEL,
  OLLAMA_MODELS,
  PROVIDERS,
  type AiProviderId,
  type OllamaState,
  type AiError,
  type AiEvent,
  type AiModelId,
  type AiRequest,
  type AiStartResult,
  type AiStatus,
  type AiTestResult,
  type CloudQuota,
  type CloudState,
  type ModelAvailability
} from '@shared/ai'
import { parseTaskResult } from '@shared/tutor'
import type { AiConfig } from './config'
import { ProviderError, type AiProvider, type ProviderModel } from './provider'
import { taskSpec } from './prompts'
import { OllamaProvider } from './ollama'
import { CloudProvider, type CloudStatus } from './cloud'

/** What the service needs from the cloud beta provider beyond AiProvider. */
export interface BetaProvider extends AiProvider {
  status(signal?: AbortSignal): Promise<CloudStatus>
}

/** What the service needs from a local provider beyond AiProvider. */
export interface LocalProvider extends AiProvider {
  readonly baseUrl: string
  version(signal?: AbortSignal): Promise<string>
}

export interface AiServiceOptions {
  config: AiConfig
  /** Creates the Gemini provider for a key. */
  makeProvider: (apiKey: string) => AiProvider
  /** Creates the local Ollama provider (default: 127.0.0.1:11434). */
  makeLocalProvider?: () => LocalProvider
  /** Creates the cloud beta provider for a server address and access code. */
  makeCloudProvider?: (opts: { baseUrl: string; token: string; onQuota: (q: CloudQuota, tester?: string) => void }) => BetaProvider
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
/** The beta server allows 6 a minute per tester; staying under it avoids needless refusals. */
const CLOUD_PER_MINUTE = 6
/** Re-check the local server when the status is asked for and the last check is older than this. */
const OLLAMA_RECHECK_MS = 15_000

interface Cooldown {
  until: number
  reason: 'rate_limited' | 'daily_quota'
  message: string
}

export class AiService {
  private readonly config: AiConfig
  private readonly makeProvider: (apiKey: string) => AiProvider
  private readonly local: LocalProvider
  private ollama: OllamaState
  private ollamaModels: ProviderModel[] | null = null
  private ollamaCheckedAt = 0
  private readonly emit: (event: AiEvent) => void
  private readonly now: () => number
  private readonly limits: Limits
  private provider: AiProvider | null = null
  private providerKey: string | null = null
  private readonly makeCloud: NonNullable<AiServiceOptions['makeCloudProvider']>
  private cloud: { provider: BetaProvider; key: string } | null = null
  private cloudInfo: { quota: CloudQuota | null; tester: string | null; checkedAt: string | null } = { quota: null, tester: null, checkedAt: null }
  private models: ProviderModel[] | null = null
  private modelsCheckedAt: string | null = null
  private readonly cooldowns = new Map<AiModelId, Cooldown>()
  private readonly started: number[] = []
  private active: { id: string; controller: AbortController } | null = null
  private last: { hash: string; at: number; failed: boolean } | null = null

  constructor(options: AiServiceOptions) {
    this.config = options.config
    this.makeProvider = options.makeProvider
    this.local = options.makeLocalProvider?.() ?? new OllamaProvider()
    this.makeCloud = options.makeCloudProvider ?? ((o) => new CloudProvider(o))
    this.ollama = { url: this.local.baseUrl, running: null, version: null, checkedAt: null }
    this.emit = options.emit
    this.now = options.now ?? Date.now
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
  }

  status(): AiStatus {
    const provider = this.config.provider
    const model = this.config.model
    const cd = provider !== 'ollama' ? this.cooldownFor(model) : null
    return {
      provider,
      local: PROVIDERS[provider].local,
      model,
      needsKey: provider !== 'ollama',
      hasKey: !!this.config.apiKey,
      keyHint: this.config.keyHint,
      keyProtection: this.config.keyProtection,
      consented: provider === 'gemini' ? this.config.consented : provider === 'cloud' ? this.config.cloudConsented : true,
      geminiConsented: this.config.consented,
      models: this.availability(),
      ollama: { ...this.ollama },
      cloud: this.cloudState(),
      modelsCheckedAt: provider === 'gemini' ? this.modelsCheckedAt : provider === 'cloud' ? this.cloudInfo.checkedAt : this.ollama.checkedAt,
      cooldown: cd ? { until: new Date(cd.until).toISOString(), reason: cd.reason, model } : null
    }
  }

  private cloudState(): CloudState {
    return {
      url: this.config.cloudUrl,
      urlFromBuild: this.config.cloudUrlFromBuild,
      hasToken: !!this.config.betaToken,
      tokenHint: this.config.betaTokenHint,
      tokenProtection: this.config.betaTokenProtection,
      consented: this.config.cloudConsented,
      quota: this.cloudInfo.quota,
      tester: this.cloudInfo.tester,
      checkedAt: this.cloudInfo.checkedAt
    }
  }

  private noteQuota = (quota: CloudQuota, tester?: string): void => {
    this.cloudInfo = { quota, tester: tester ?? this.cloudInfo.tester, checkedAt: new Date(this.now()).toISOString() }
  }

  /**
   * Checks an access code (and server address) with the server before saving
   * it. Costs no model usage. Nothing is saved if the server refuses the code.
   */
  async setBetaAccess(token: string, url: string | null): Promise<AiStatus | { error: AiError }> {
    const baseUrl = url ?? this.config.cloudUrl
    if (!baseUrl) return { error: { code: 'no_key', message: 'Enter the beta server address you were given.' } }
    const probe = this.makeCloud({ baseUrl, token, onQuota: () => undefined })
    try {
      const s = await probe.status()
      this.cancelActive()
      await this.config.setBetaAccess(token, url)
      this.cloud = null
      this.noteQuota(s.quota, s.tester)
      this.cooldowns.delete(CLOUD_MODEL)
      this.last = null
      return this.status()
    } catch (err) {
      return { error: toAiError(err) }
    }
  }

  async clearBetaAccess(): Promise<AiStatus> {
    this.cancelActive()
    await this.config.clearBetaAccess()
    this.cloud = null
    this.cloudInfo = { quota: null, tester: null, checkedAt: null }
    this.cooldowns.delete(CLOUD_MODEL)
    return this.status()
  }

  /** The status, re-checking the local server first if that is due. */
  async freshStatus(): Promise<AiStatus> {
    if (this.config.provider === 'ollama' && this.now() - this.ollamaCheckedAt > OLLAMA_RECHECK_MS) await this.checkOllama()
    if (this.config.provider === 'cloud') {
      // Today's allowance, at most once a minute (the status call costs no model usage).
      const at = this.cloudInfo.checkedAt ? Date.parse(this.cloudInfo.checkedAt) : 0
      const beta = this.getCloud()
      if (beta && !this.active && this.now() - at > 60_000) await beta.status().then((st) => this.noteQuota(st.quota, st.tester), () => undefined)
    }
    return this.status()
  }

  async setProvider(provider: AiProviderId): Promise<AiStatus> {
    if (provider === this.config.provider) return this.status()
    this.cancelActive()
    await this.config.setProvider(provider)
    this.last = null
    if (provider === 'ollama') await this.checkOllama()
    return this.status()
  }

  /** Whether Ollama runs and which models it has. Never throws. */
  private async checkOllama(): Promise<void> {
    this.ollamaCheckedAt = this.now()
    const checkedAt = new Date(this.now()).toISOString()
    try {
      const version = await this.local.version()
      this.ollamaModels = await this.local.listModels()
      this.ollama = { url: this.local.baseUrl, running: true, version, checkedAt }
    } catch (err) {
      const offline = err instanceof ProviderError && err.code === 'offline'
      this.ollama = { url: this.local.baseUrl, running: offline ? false : this.ollama.running, version: offline ? null : this.ollama.version, checkedAt }
      if (offline) this.ollamaModels = null
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

  /** Chooses a model of the active provider. A name that isn't valid for it is ignored. */
  async setModel(model: AiModelId): Promise<AiStatus> {
    try {
      await this.config.setModel(model)
      this.last = null
    } catch {
      /* not a model of this provider */
    }
    return this.status()
  }

  /** Consent for the active cloud provider (Gemini or the beta). */
  async setConsent(accepted: boolean): Promise<AiStatus> {
    if (!accepted) this.cancelActive()
    if (this.config.provider === 'cloud') await this.config.setCloudConsent(accepted)
    else await this.config.setConsent(accepted)
    return this.status()
  }

  /** Fetches the models the active provider offers and marks which supported ones exist. */
  async refreshModels(): Promise<{ ok: true; models: ModelAvailability[] } | { ok: false; error: AiError }> {
    if (this.config.provider === 'ollama') {
      await this.checkOllama()
      if (this.ollama.running === false) return { ok: false, error: offline() }
      return { ok: true, models: this.availability() }
    }
    if (this.config.provider === 'cloud') {
      const beta = this.getCloud()
      if (!beta) return { ok: false, error: noBetaAccess(this.config.cloudUrl) }
      try {
        const s = await beta.status()
        this.noteQuota(s.quota, s.tester)
        return { ok: true, models: this.availability() }
      } catch (err) {
        return { ok: false, error: toAiError(err) }
      }
    }
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
   * Checks the provider and model with the smallest useful request: lists
   * models, then asks the selected model for a one-word reply. Sends no
   * notebook content. For Ollama this also loads the model into memory.
   */
  async test(): Promise<AiTestResult> {
    const providerId = this.config.provider
    if (providerId === 'cloud') {
      // The server's status check proves the address and the access code; a model call would spend the allowance.
      const beta = this.getCloud()
      if (!beta) return { ok: false, error: noBetaAccess(this.config.cloudUrl) }
      const startedAt = this.now()
      try {
        const s = await beta.status()
        this.noteQuota(s.quota, s.tester)
        if (s.paused) return { ok: false, error: { code: 'beta_closed', message: 'The Inkling AI beta is paused right now. Try again later, or use the local Ollama tutor.' } }
        if (s.quota.approxAnswersLeft > 0) this.cooldowns.delete(CLOUD_MODEL)
        return { ok: true, model: CLOUD_MODEL, latencyMs: this.now() - startedAt, models: this.availability() }
      } catch (err) {
        return { ok: false, error: toAiError(err) }
      }
    }
    const provider = this.getProvider()
    if (!provider) return { ok: false, error: noKey() }
    const blocked = this.admit(null, { explicit: true })
    if (blocked) return { ok: false, error: blocked }
    const model = this.config.model
    const startedAt = this.now()
    this.started.push(startedAt)
    try {
      if (providerId === 'ollama') {
        await this.checkOllama()
        if (this.ollama.running === false) return { ok: false, error: offline() }
        const listed = this.ollamaModels?.find((m) => m.id === model)
        if (!listed) return { ok: false, error: { code: 'model_unavailable', message: notInstalled(model) } }
        if (listed.vision === false) return { ok: false, error: { code: 'model_unavailable', message: `${model} can't read images, so it can't see handwriting. Choose a vision model such as qwen3-vl:4b-instruct.` } }
      } else {
        this.models = await provider.listModels()
        this.modelsCheckedAt = new Date(this.now()).toISOString()
        const listed = this.availability().find((m) => m.id === model)
        if (listed?.status === 'missing') {
          return { ok: false, error: { code: 'model_unavailable', message: `Your key works, but ${model} is not offered to it. Choose another model.`, suggestModel: other(model) } }
        }
      }
      const stream = provider.stream({ model, system: 'Reply with exactly: OK', turns: [{ role: 'user', parts: [{ text: 'Connection test' }] }], maxOutputTokens: 64, temperature: 0 })
      for await (const chunk of stream) void chunk
      this.cooldowns.delete(model)
      return { ok: true, model, latencyMs: this.now() - startedAt, models: this.availability() }
    } catch (err) {
      const error = toAiError(err)
      if (providerId === 'ollama' && error.code === 'offline') this.ollama = { ...this.ollama, running: false }
      this.noteFailure(model, error)
      return { ok: false, error: this.withSuggestion(model, error) }
    }
  }

  /** Starts a streamed request. Results arrive as AiEvents with the returned id. */
  start(request: AiRequest): AiStartResult {
    if (this.config.provider === 'gemini' && !this.config.consented) {
      return { error: { code: 'consent_required', message: 'Allow Inkling to send notebook content to Google Gemini first (AI settings).' } }
    }
    if (this.config.provider === 'cloud' && !this.config.cloudConsented) {
      return { error: { code: 'consent_required', message: 'Allow Inkling to send notebook content to its beta server first (AI settings).' } }
    }
    const provider = this.config.provider === 'cloud' ? this.getCloud() : this.getProvider()
    if (!provider) return { error: this.config.provider === 'cloud' ? noBetaAccess(this.config.cloudUrl) : noKey() }
    const model = this.config.model
    const hash = createHash('sha256').update(this.config.provider).update(model).update(JSON.stringify(request)).digest('hex')
    const blocked = this.admit(hash)
    if (blocked) return { error: blocked }

    const id = randomUUID()
    const controller = new AbortController()
    this.active = { id, controller }
    this.started.push(this.now())
    this.last = { hash, at: this.now(), failed: false }
    void this.run(id, provider, model, request, controller, this.now())
    return { requestId: id }
  }

  cancel(requestId: string): void {
    if (this.active?.id === requestId) this.cancelActive()
  }

  private async run(id: string, provider: AiProvider, model: AiModelId, request: AiRequest, controller: AbortController, startedAt: number): Promise<void> {
    const spec = taskSpec(request.task, provider.id)
    const name = provider.id === 'ollama' ? 'The local model' : provider.id === 'cloud' ? 'The beta tutor' : 'Gemini'
    let firstTokenMs: number | undefined
    let text = ''
    try {
      let usage = {}
      let finishReason: string | undefined
      for await (const chunk of provider.stream(
        { model, task: request.task, system: spec.system, turns: request.turns, jsonSchema: spec.jsonSchema, maxOutputTokens: spec.maxOutputTokens, temperature: spec.temperature },
        controller.signal
      )) {
        if (chunk.type === 'text') {
          firstTokenMs ??= this.now() - startedAt
          text += chunk.text
          // Structured answers are only useful once complete.
          if (!spec.jsonSchema) this.emit({ requestId: id, type: 'delta', text: chunk.text })
        } else {
          usage = chunk.usage
          finishReason = chunk.finishReason
        }
      }
      if (spec.normalize) text = spec.normalize(text)
      if (request.task !== 'chat' && !parseTaskResult(request.task, text)) {
        const cut = finishReason === 'MAX_TOKENS'
        throw new ProviderError('bad_response', cut ? `${name}’s answer was cut off before it was complete. Try again, perhaps with a smaller selection.` : `${name}’s answer was not in the expected format. Try again.`)
      }
      if (!text.trim()) throw new ProviderError('bad_response', `${name} returned an empty answer. Try again.`)
      this.cooldowns.delete(model)
      this.emit({ requestId: id, type: 'done', text, usage: { ...usage, firstTokenMs, totalMs: this.now() - startedAt }, model })
    } catch (err) {
      const error = this.withSuggestion(model, toAiError(err))
      if (provider.id === 'ollama' && error.code === 'offline') this.ollama = { ...this.ollama, running: false }
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
    if (this.config.provider === 'ollama') {
      // Local: no quota to protect, only accidental double-sends.
      if (hash && this.last && this.last.hash === hash && !this.last.failed && now - this.last.at < this.limits.duplicateWindowMs) {
        return { code: 'duplicate', message: 'You just sent this exact request, and its answer is already shown. Change something and try again.' }
      }
      return null
    }
    const model = this.config.model
    const cloud = this.config.provider === 'cloud'
    const cd = this.cooldownFor(model)
    if (cd && !opts.explicit) {
      const wait = Math.ceil((cd.until - now) / 1000)
      const pause = cloud ? `The beta needs a short pause. Try again in ${wait} seconds.` : `Gemini's free tier needs a short pause. Try again in ${wait} seconds.`
      return this.withSuggestion(model, { code: cd.reason, message: cd.reason === 'rate_limited' ? pause : cd.message, retryAfter: wait })
    }
    if (hash && this.last && this.last.hash === hash && !this.last.failed && now - this.last.at < this.limits.duplicateWindowMs) {
      return { code: 'duplicate', message: 'You just sent this exact request, and its answer is already shown. Change something and try again.' }
    }
    while (this.started.length && now - this.started[0]! >= 60_000) this.started.shift()
    const lastStart = this.started[this.started.length - 1]
    if (!opts.explicit && lastStart !== undefined && now - lastStart < this.limits.minIntervalMs) {
      return { code: 'rate_limited', message: 'One moment — sending requests too quickly.', retryAfter: Math.ceil((this.limits.minIntervalMs - (now - lastStart)) / 1000) }
    }
    const perMinute = cloud ? Math.min(this.limits.perMinute, CLOUD_PER_MINUTE) : this.limits.perMinute
    if (this.started.length >= perMinute) {
      const wait = Math.ceil((60_000 - (now - this.started[0]!)) / 1000)
      const why = cloud ? 'The beta allows' : "To stay within Gemini's free limits, Inkling sends at most"
      return { code: 'rate_limited', message: cloud ? `${why} ${perMinute} requests a minute. Try again in ${wait} seconds.` : `${why} ${perMinute} requests a minute. Try again in ${wait} seconds.`, retryAfter: wait }
    }
    return null
  }

  private noteFailure(model: AiModelId, error: AiError): void {
    if ((error.code === 'rate_limited' || error.code === 'daily_quota') && error.retryAfter) {
      this.cooldowns.set(model, { until: this.now() + error.retryAfter * 1000, reason: error.code, message: error.message })
    }
  }

  private withSuggestion(model: AiModelId, error: AiError): AiError {
    if (this.config.provider === 'cloud') return error
    if (this.config.provider === 'ollama') {
      // Memory or speed trouble with a bigger model: the smaller one is installed, so offer it.
      const small = 'qwen3-vl:2b-instruct'
      const hasSmall = this.ollamaModels?.some((m) => m.id === small)
      if (model !== small && hasSmall && (error.code === 'server' || (error.code === 'network' && /took too long/.test(error.message)))) return { ...error, suggestModel: small }
      return error
    }
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
    if (this.config.provider === 'ollama') return this.ollamaAvailability()
    if (this.config.provider === 'cloud') return [{ id: CLOUD_MODEL, status: this.cloudInfo.checkedAt ? 'available' : 'unknown', vision: true }]
    return GEMINI_MODELS.map((m) => {
      const id = m.id as AiModelId
      if (!this.models) return { id, status: 'unknown' as const }
      const found = this.models.find((x) => x.id === id && x.canGenerate)
      return found ? { id, status: 'available' as const, inputTokenLimit: found.inputTokenLimit } : { id, status: 'missing' as const }
    })
  }

  /** The recommended models (installed or not), then any other installed vision models. */
  private ollamaAvailability(): ModelAvailability[] {
    const installed = this.ollamaModels
    const find = (id: string): ProviderModel | undefined => installed?.find((m) => m.id === id || m.id === `${id}:latest`)
    const recommended = OLLAMA_MODELS.map((m): ModelAvailability => {
      const found = find(m.id)
      if (!installed) return { id: m.id, status: 'unknown' }
      return found ? { id: m.id, status: 'available', sizeBytes: found.sizeBytes, vision: found.vision, thinking: found.thinking } : { id: m.id, status: 'missing' }
    })
    const extra = (installed ?? [])
      .filter((m) => m.canGenerate && m.vision && !OLLAMA_MODELS.some((r) => r.id === m.id))
      .map((m): ModelAvailability => ({ id: m.id, status: 'available', label: m.id, sizeBytes: m.sizeBytes, vision: true, thinking: m.thinking }))
    const chosen = this.config.ollamaModel
    // A chosen model that is neither recommended nor an installed vision model still shows up, as missing or non-vision.
    const orphan: ModelAvailability[] =
      recommended.some((m) => m.id === chosen) || extra.some((m) => m.id === chosen)
        ? []
        : [{ id: chosen, label: chosen, ...(find(chosen) ? { status: 'available' as const, vision: find(chosen)!.vision } : { status: installed ? ('missing' as const) : ('unknown' as const) }) }]
    return [...recommended, ...extra, ...orphan]
  }

  private getCloud(): BetaProvider | null {
    const url = this.config.cloudUrl
    const token = this.config.betaToken
    if (!url || !token) return null
    const key = `${url}\n${token}`
    if (this.cloud?.key !== key) this.cloud = { provider: this.makeCloud({ baseUrl: url, token, onQuota: this.noteQuota }), key }
    return this.cloud.provider
  }

  private getProvider(): AiProvider | null {
    if (this.config.provider === 'cloud') return this.getCloud()
    if (this.config.provider === 'ollama') return this.local
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
const noBetaAccess = (url: string | null): AiError => ({
  code: 'no_key',
  message: url ? 'Enter your beta access code in AI settings to use the tutor.' : 'Enter the beta server address and your access code in AI settings to use the tutor.'
})
const offline = (): AiError => ({ code: 'offline', message: 'Ollama isn’t running. Start the Ollama app (or run “ollama serve” in a terminal), then try again.' })
const notInstalled = (model: string): string => `${model} isn't installed in Ollama yet. To install it (a one-time download), run: ollama pull ${model}`

function toAiError(err: unknown): AiError {
  if (err instanceof ProviderError) return err.toJSON()
  return { code: 'unknown', message: `Something went wrong: ${(err as Error)?.message ?? String(err)}` }
}
