/**
 * The Worker's settings (wrangler vars and secrets) turned into the server's
 * configuration: who answers, at what price, and the ledger's limits. No
 * Workers-runtime imports, so it is unit-tested in Node.
 */
import type { ServerConfig } from './handler'
import type { LedgerLimits } from './ledger'
import { externalProvider, PRESETS, type AiBinding, type ExternalProviderId, type ProviderId } from './provider'

export interface Env {
  /** The Workers AI binding (only used when INFERENCE_PROVIDER is "workers-ai"). */
  AI?: unknown
  LEDGER?: unknown
  MODEL: string
  ACCOUNT_PLAN: string
  GLOBAL_DAILY_NEURONS: string
  INSTALL_DAILY_NEURONS: string
  NETWORK_DAILY_NEURONS: string
  INSTALL_PER_MINUTE: string
  NETWORK_PER_MINUTE: string
  INSTALL_CONCURRENT: string
  NETWORK_CONCURRENT: string
  GLOBAL_CONCURRENT: string
  TYPICAL_NEURONS_PER_ANSWER: string
  INPUT_NEURONS_PER_M: string
  OUTPUT_NEURONS_PER_M: string
  REASONING_EFFORT: string
  DISABLE_THINKING: string
  STRUCTURED: string
  IMAGE_PATCH: string
  MAX_INPUT_TOKENS: string
  // ---- External provider (unset keeps Workers AI) ----
  /** "workers-ai" (default) | "deepinfra" | "openrouter" | "openrouter-free" | "groq" | "openai-compatible". */
  INFERENCE_PROVIDER?: string
  /** Secret (wrangler secret put INFERENCE_API_KEY): the provider's API key. Never leaves the Worker except to that provider. */
  INFERENCE_API_KEY?: string
  /** The provider's model ID; defaults to the preset's (Qwen/Qwen3.8-27B on DeepInfra, qwen/qwen3.8-27b on OpenRouter). */
  UPSTREAM_MODEL?: string
  /** Overrides the preset's https base URL (required for "openai-compatible"). */
  UPSTREAM_BASE_URL?: string
  /** Extra JSON merged into every provider request (operator-only, e.g. OpenRouter provider preferences). */
  UPSTREAM_EXTRA_BODY?: string
  /** USD per million tokens, at list price (not promotional), so accounting errs high. */
  PRICE_INPUT_USD_PER_M?: string
  PRICE_OUTPUT_USD_PER_M?: string
  PRICE_CACHED_INPUT_USD_PER_M?: string
  /** Overrides the preset's fee multiplier (OpenRouter 1.055). */
  COST_MULTIPLIER?: string
  /** Hard spending caps in USD: rolling 24 hours, and per calendar month (UTC). */
  GLOBAL_DAILY_USD?: string
  GLOBAL_MONTHLY_USD?: string
  INSTALL_DAILY_USD?: string
  INSTALL_MONTHLY_USD?: string
  NETWORK_DAILY_USD?: string
  TYPICAL_USD_PER_ANSWER?: string
  /** Budget protection: at this share of the daily or monthly cap, daily allowances are scaled by SOFT_FACTOR. */
  SOFT_LIMIT_FRACTION?: string
  SOFT_LIMIT_FACTOR?: string
  UPSTREAM_MAX_ATTEMPTS?: string
  UPSTREAM_TIMEOUT_MS?: string
  UPSTREAM_IDLE_TIMEOUT_MS?: string
  /**
   * The provider's account-wide request quota, per UTC day and per minute (required for
   * "openrouter-free": set a little under OpenRouter's 1,000 a day / 20 a minute).
   */
  GLOBAL_REQUESTS_PER_DAY?: string
  GLOBAL_REQUESTS_PER_MINUTE?: string
  /**
   * The provider's account-wide token quota (input + output), over any 24 hours and any minute
   * (required for "groq": set under Groq's free 200,000 a day / 8,000 a minute).
   */
  GLOBAL_TOKENS_PER_DAY?: string
  GLOBAL_TOKENS_PER_MINUTE?: string
  /** Reservation margin on the input estimate (default 1.5 on an external provider). */
  INPUT_ESTIMATE_MARGIN?: string
  /** Oldest app data notice accepted. Default: 4 with an external provider (its notice names it), 0 on Workers AI. */
  MIN_NOTICE_VERSION?: string
  /** Secret (wrangler secret put ADMIN_TOKEN): the operator's pause switch and summary. Without it the admin API is off. */
  ADMIN_TOKEN?: string
}

/** Cloudflare gives every account 10,000 free Neurons a day; the service never plans to use all of them. */
const CLOUDFLARE_FREE_NEURONS = 10_000

const num = (v: string | undefined, d: number): number => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
/** A positive number, or undefined. */
const pos = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined)
/** USD → the ledger's micro-dollars. */
const micro = (usd: number): number => Math.round(usd * 1e6)

/** Higher than any shipped app's notice version. */
export const NOTICE_NOT_YET_SHIPPED = 99

export function providerOf(env: Env): ProviderId {
  const p = (env.INFERENCE_PROVIDER ?? '').trim()
  return p === 'deepinfra' || p === 'openrouter' || p === 'openrouter-free' || p === 'groq' || p === 'openai-compatible' ? p : 'workers-ai'
}

/**
 * Limits for an external provider, in µ$. Each daily allowance defaults to a
 * fraction of the whole service's: an installation 1/50 of the day's budget, a
 * network 3× an installation.
 */
export function externalLimits(env: Env): LedgerLimits | string {
  const daily = pos(env.GLOBAL_DAILY_USD)
  const monthly = pos(env.GLOBAL_MONTHLY_USD)
  if (!daily || !monthly) return 'GLOBAL_DAILY_USD and GLOBAL_MONTHLY_USD must be set'
  const install = pos(env.INSTALL_DAILY_USD) ?? daily / 50
  return {
    unit: 'usd',
    globalDailyNeurons: micro(Math.min(daily, monthly)),
    globalMonthly: micro(monthly),
    installDailyNeurons: micro(install),
    installMonthly: pos(env.INSTALL_MONTHLY_USD) !== undefined ? micro(pos(env.INSTALL_MONTHLY_USD)!) : undefined,
    networkDailyNeurons: micro(pos(env.NETWORK_DAILY_USD) ?? install * 3),
    installPerMinute: num(env.INSTALL_PER_MINUTE, 6),
    networkPerMinute: num(env.NETWORK_PER_MINUTE, 20),
    installConcurrent: num(env.INSTALL_CONCURRENT, 1),
    networkConcurrent: num(env.NETWORK_CONCURRENT, 4),
    globalConcurrent: num(env.GLOBAL_CONCURRENT, 12),
    reservationTtlMs: 10 * 60_000,
    typicalNeuronsPerAnswer: micro(pos(env.TYPICAL_USD_PER_ANSWER) ?? 0.0008),
    softFraction: pos(env.SOFT_LIMIT_FRACTION) ?? 0.8,
    softFactor: pos(env.SOFT_LIMIT_FACTOR) ?? 0.5,
    globalRequestsPerDay: pos(env.GLOBAL_REQUESTS_PER_DAY),
    globalRequestsPerMinute: pos(env.GLOBAL_REQUESTS_PER_MINUTE),
    globalTokensPerDay: pos(env.GLOBAL_TOKENS_PER_DAY),
    globalTokensPerMinute: pos(env.GLOBAL_TOKENS_PER_MINUTE)
  }
}

export function limits(env: Env): LedgerLimits {
  if (providerOf(env) !== 'workers-ai') {
    const l = externalLimits(env)
    if (typeof l !== 'string') return l
  }
  return {
    globalDailyNeurons: Math.min(num(env.GLOBAL_DAILY_NEURONS, 9000), CLOUDFLARE_FREE_NEURONS * 0.95),
    installDailyNeurons: num(env.INSTALL_DAILY_NEURONS, 900),
    networkDailyNeurons: num(env.NETWORK_DAILY_NEURONS, 2700),
    installPerMinute: num(env.INSTALL_PER_MINUTE, 6),
    networkPerMinute: num(env.NETWORK_PER_MINUTE, 20),
    installConcurrent: num(env.INSTALL_CONCURRENT, 1),
    networkConcurrent: num(env.NETWORK_CONCURRENT, 4),
    globalConcurrent: num(env.GLOBAL_CONCURRENT, 12),
    reservationTtlMs: 10 * 60_000,
    typicalNeuronsPerAnswer: num(env.TYPICAL_NEURONS_PER_ANSWER, 90)
  }
}

/** Who answers, and at what price, from the Worker's settings; a string explains a setting that is missing (serve nothing). */
export function inference(env: Env):
  | { ai: AiBinding; provider: ProviderId; model: string; publicModel: string; rates: ServerConfig['rates']; minNotice: number; inputMargin: number; freeProvider?: boolean; tokenQuota?: boolean; imageMinTokens?: number }
  | string {
  const provider = providerOf(env)
  if (provider === 'workers-ai') {
    // Refuse rather than risk billed usage on a Workers Paid account.
    if (env.ACCOUNT_PLAN !== 'free') return 'ACCOUNT_PLAN must be "free"'
    return {
      ai: env.AI as unknown as AiBinding,
      provider,
      model: env.MODEL,
      publicModel: env.MODEL,
      rates: { unit: 'neurons', inputPerM: Number(env.INPUT_NEURONS_PER_M), outputPerM: Number(env.OUTPUT_NEURONS_PER_M) },
      minNotice: num(env.MIN_NOTICE_VERSION, 0),
      // Measured: the server's count matches Cloudflare's to 0.1 Neuron.
      inputMargin: num(env.INPUT_ESTIMATE_MARGIN, 1)
    }
  }
  const id = provider as ExternalProviderId
  const key = env.INFERENCE_API_KEY?.trim()
  if (!key) return 'INFERENCE_API_KEY secret is missing'
  const l = externalLimits(env)
  if (typeof l === 'string') return l
  const free = PRESETS[id].free === true
  // On the free endpoint prices are a SHADOW price (default DeepInfra's list price): nothing is billed,
  // but allowances in dollars still share out the free quota fairly.
  const input = pos(env.PRICE_INPUT_USD_PER_M) ?? (free ? 0.2 : undefined)
  const output = pos(env.PRICE_OUTPUT_USD_PER_M) ?? (free ? 2.5 : undefined)
  if (!input || !output) return 'PRICE_INPUT_USD_PER_M and PRICE_OUTPUT_USD_PER_M must be set'
  const model = env.UPSTREAM_MODEL?.trim() || PRESETS[id].model
  if (!model) return 'UPSTREAM_MODEL must be set'
  const preset = PRESETS[id]
  if (free) {
    // Never a paid model: only a ":free" variant (OpenRouter) or the preset's own free model (Groq).
    if (preset.freeModels ? !preset.freeModels.includes(model) : !model.endsWith(':free')) return `UPSTREAM_MODEL must be ${preset.freeModels ? preset.freeModels.join(' or ') : 'a ":free" model'} for ${id}`
    // The account-wide request quota must be set.
    if (!l.globalRequestsPerDay || !l.globalRequestsPerMinute) return `GLOBAL_REQUESTS_PER_DAY and GLOBAL_REQUESTS_PER_MINUTE must be set for ${id}`
  }
  if (preset.freeLimits) {
    // A token quota too, and no quota above the provider's documented free plan: the server never plans to pass it.
    const f = preset.freeLimits
    if (!l.globalTokensPerDay || !l.globalTokensPerMinute) return `GLOBAL_TOKENS_PER_DAY and GLOBAL_TOKENS_PER_MINUTE must be set for ${id}`
    if (l.globalRequestsPerDay! > f.requestsPerDay) return `GLOBAL_REQUESTS_PER_DAY must be at most ${f.requestsPerDay} (${id} free plan)`
    if (l.globalRequestsPerMinute! > f.requestsPerMinute) return `GLOBAL_REQUESTS_PER_MINUTE must be at most ${f.requestsPerMinute} (${id} free plan)`
    if (l.globalTokensPerDay > f.tokensPerDay) return `GLOBAL_TOKENS_PER_DAY must be at most ${f.tokensPerDay} (${id} free plan)`
    if (l.globalTokensPerMinute > f.tokensPerMinute) return `GLOBAL_TOKENS_PER_MINUTE must be at most ${f.tokensPerMinute} (${id} free plan)`
    // The base URL is the provider's own: an override could point the key and requests somewhere else.
    // (A local test double is allowed: a deployed Worker can't reach this machine's localhost.)
    const base = env.UPSTREAM_BASE_URL?.replace(/\/+$/, '')
    if (base && base !== preset.baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base)) return `UPSTREAM_BASE_URL can't be changed for ${id}`
  }
  let extraBody: Record<string, unknown> | undefined
  if (env.UPSTREAM_EXTRA_BODY) {
    try {
      extraBody = JSON.parse(env.UPSTREAM_EXTRA_BODY)
    } catch {
      return 'UPSTREAM_EXTRA_BODY is not JSON'
    }
  }
  let ai: AiBinding
  try {
    ai = externalProvider({
      id,
      apiKey: key,
      baseUrl: env.UPSTREAM_BASE_URL,
      extraBody,
      // On a quota-counted free endpoint every attempt spends quota: one retry at most, never after a 429.
      maxAttempts: num(env.UPSTREAM_MAX_ATTEMPTS, free ? 2 : 3),
      retryRateLimit: !free,
      firstByteTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 45_000),
      idleTimeoutMs: num(env.UPSTREAM_IDLE_TIMEOUT_MS, 45_000)
    })
  } catch {
    return 'UPSTREAM_BASE_URL must be https'
  }
  const cached = pos(env.PRICE_CACHED_INPUT_USD_PER_M)
  return {
    ai,
    provider,
    model,
    // The same name whoever hosts it: the app doesn't need to know the provider.
    publicModel: 'qwen3.8-27b',
    rates: {
      unit: 'usd',
      inputPerM: input * 1e6,
      outputPerM: output * 1e6,
      ...(cached ? { cachedInputPerM: cached * 1e6 } : {}),
      costMultiplier: pos(env.COST_MULTIPLIER) ?? PRESETS[id].costMultiplier,
      ...(free ? { ignoreReportedCost: true } : {})
    },
    freeProvider: free,
    ...(preset.freeLimits ? { tokenQuota: true } : {}),
    ...(preset.imageTokens ? { imageMinTokens: preset.imageTokens } : {}),
    // DeepInfra is named in the app's data notice from version 4. Any other host isn't named in a
    // shipped notice yet: it needs a new notice (and CLOUD_CONSENT_VERSION) before real users reach it.
    minNotice: num(env.MIN_NOTICE_VERSION, id === 'deepinfra' ? 4 : NOTICE_NOT_YET_SHIPPED),
    inputMargin: num(env.INPUT_ESTIMATE_MARGIN, 1.5)
  }
}

