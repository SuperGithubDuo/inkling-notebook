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
  /**
   * Workers AI only (route.ts): the text-only model. Empty: every request goes to MODEL. Ignored
   * with an external provider, which answers everything with one model.
   */
  MODEL_TEXT?: string
  TEXT_INPUT_NEURONS_PER_M?: string
  TEXT_OUTPUT_NEURONS_PER_M?: string
  /** Tasks the text model may answer: a comma-separated subset of chat, practice, check (default practice). */
  TEXT_MODEL_TASKS?: string
  // ---- External provider (unset keeps Workers AI) ----
  /** "workers-ai" (default) | "deepinfra" | "openrouter" | "openai-compatible". */
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
  /** External providers: each day's global cap is at most (monthly budget left ÷ days left) × this. Unset: off. */
  MONTHLY_PACING?: string
  /**
   * "true": while an external provider answers, apps on an older data notice (before 4, which names
   * only Cloudflare) are answered by Workers AI on the Free plan instead of being told to update.
   */
  LEGACY_WORKERS_AI?: string
  UPSTREAM_MAX_ATTEMPTS?: string
  UPSTREAM_TIMEOUT_MS?: string
  UPSTREAM_IDLE_TIMEOUT_MS?: string
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
  return p === 'deepinfra' || p === 'openrouter' || p === 'openai-compatible' ? p : 'workers-ai'
}

/**
 * Limits for an external provider, in µ$. Each daily allowance defaults to a
 * fraction of the whole service's: an installation 1/50 of the day's budget, a
 * network 10× an installation (a school shares one address).
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
    networkDailyNeurons: micro(pos(env.NETWORK_DAILY_USD) ?? install * 10),
    installPerMinute: num(env.INSTALL_PER_MINUTE, 6),
    networkPerMinute: num(env.NETWORK_PER_MINUTE, 20),
    installConcurrent: num(env.INSTALL_CONCURRENT, 1),
    networkConcurrent: num(env.NETWORK_CONCURRENT, 4),
    globalConcurrent: num(env.GLOBAL_CONCURRENT, 12),
    reservationTtlMs: 10 * 60_000,
    typicalNeuronsPerAnswer: micro(pos(env.TYPICAL_USD_PER_ANSWER) ?? 0.0008),
    // Reduced allowances near the cap are opt-in (set both): monthly pacing spreads the budget instead,
    // and when they are on the app is told (quota.reduced) and says so.
    softFraction: pos(env.SOFT_LIMIT_FRACTION),
    softFactor: pos(env.SOFT_LIMIT_FACTOR),
    monthlyPacing: pos(env.MONTHLY_PACING)
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
export function inference(env: Env): { ai: AiBinding; provider: ProviderId; model: string; publicModel: string; rates: ServerConfig['rates']; minNotice: number; inputMargin: number; upstreamAttempts?: number } | string {
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
  const input = pos(env.PRICE_INPUT_USD_PER_M)
  const output = pos(env.PRICE_OUTPUT_USD_PER_M)
  if (!input || !output) return 'PRICE_INPUT_USD_PER_M and PRICE_OUTPUT_USD_PER_M must be set'
  const model = env.UPSTREAM_MODEL?.trim() || PRESETS[id].model
  if (!model) return 'UPSTREAM_MODEL must be set'
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
      maxAttempts: num(env.UPSTREAM_MAX_ATTEMPTS, 3),
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
      costMultiplier: pos(env.COST_MULTIPLIER) ?? PRESETS[id].costMultiplier
    },
    // DeepInfra is named in the app's data notice from version 4. Any other host isn't named in a
    // shipped notice yet: it needs a new notice (and CLOUD_CONSENT_VERSION) before real users reach it.
    minNotice: num(env.MIN_NOTICE_VERSION, id === 'deepinfra' ? 4 : NOTICE_NOT_YET_SHIPPED),
    inputMargin: num(env.INPUT_ESTIMATE_MARGIN, 1.5),
    // Each attempt the adapter may make (timed-out attempts may be billed): the worst case reserves input for each.
    upstreamAttempts: Math.min(4, Math.max(1, num(env.UPSTREAM_MAX_ATTEMPTS, 3)))
  }
}

