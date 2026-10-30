/**
 * Cloudflare Worker entry for Inkling's free AI service. See handler.ts for
 * the API and ledger.ts for how the free allowance is protected.
 *
 * Deploy on the Workers **Free** plan. There, Workers AI stops with an error
 * once the account's free 10,000 Neurons for the day are used: it can't bill.
 * On Workers Paid the same usage would be billed, so this Worker refuses to
 * serve unless ACCOUNT_PLAN is "free" (a deliberate, manual declaration).
 */
import { DurableObject } from 'cloudflare:workers'
import { handle, sha256Hex, type ServerConfig } from './handler'
import { Ledger, type Identity, type LedgerLimits, type Quota, type ReserveResult } from './ledger'

export interface Env {
  AI: Ai
  LEDGER: DurableObjectNamespace<LedgerObject>
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
  /** Secret (wrangler secret put ADMIN_TOKEN): the operator's pause switch and summary. Without it the admin API is off. */
  ADMIN_TOKEN?: string
}

/** Cloudflare gives every account 10,000 free Neurons a day; the service never plans to use all of them. */
const CLOUDFLARE_FREE_NEURONS = 10_000

function limits(env: Env): LedgerLimits {
  const num = (v: string | undefined, d: number): number => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
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

/** One object holds the whole ledger, so every reservation is decided one at a time. */
export class LedgerObject extends DurableObject<Env> {
  private readonly ledger: Ledger
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const s = ctx.storage
    this.ledger = new Ledger(
      {
        get: (k) => s.get(k),
        put: (k, v) => s.put(k, v),
        delete: async (k) => void (await s.delete(k)),
        list: async (prefix) => [...(await s.list({ prefix })).keys()]
      },
      limits(env)
    )
  }
  reserve(id: Identity, worst: number, expected: number): Promise<ReserveResult> {
    return this.ledger.reserve(id, worst, expected)
  }
  settle(id: string, neurons: number | undefined, opts?: { upstreamExhausted?: boolean; failedBeforeModel?: boolean }): Promise<void> {
    return this.ledger.settle(id, neurons, opts)
  }
  quota(id: Identity): Promise<Quota> {
    return this.ledger.quota(id)
  }
  isPaused(): Promise<boolean> {
    return this.ledger.isPaused()
  }
  setPaused(p: boolean): Promise<void> {
    return this.ledger.setPaused(p)
  }
  summary(): ReturnType<Ledger['summary']> {
    return this.ledger.summary()
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (env.ACCOUNT_PLAN !== 'free') {
      // Refuse rather than risk billed usage on a Workers Paid account.
      return Response.json({ error: { code: 'beta_closed', message: 'Inkling’s AI server is not configured. (ACCOUNT_PLAN must be "free".)' } }, { status: 503 })
    }
    const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
    const config: ServerConfig = {
      model: env.MODEL,
      rates: { inputPerM: Number(env.INPUT_NEURONS_PER_M), outputPerM: Number(env.OUTPUT_NEURONS_PER_M) },
      reasoningEffort: env.REASONING_EFFORT ?? '',
      disableThinking: env.DISABLE_THINKING === 'true',
      structured: env.STRUCTURED === 'json_schema' ? 'json_schema' : 'prompt',
      imagePatch: Number(env.IMAGE_PATCH) || 28,
      maxBodyBytes: 3_500_000,
      maxInputTokens: Number(env.MAX_INPUT_TOKENS) || 12_000,
      adminTokenHash: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 ? await sha256Hex(env.ADMIN_TOKEN) : null
    }
    // The stub's methods match Ledger's; RPC returns plain data.
    const ledger = stub as unknown as Ledger
    return handle(request, { ai: env.AI as unknown as { run(m: string, i: Record<string, unknown>): Promise<unknown> }, ledger, config, waitUntil: (p) => ctx.waitUntil(p) })
  }
} satisfies ExportedHandler<Env>
