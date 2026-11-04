/**
 * Cloudflare Worker entry for Inkling's free AI service. See handler.ts for
 * the API, ledger.ts for how the allowance is protected and provider.ts for
 * who answers.
 *
 * INFERENCE_PROVIDER chooses who answers:
 *
 *   "workers-ai" (default, the rollback path): Cloudflare Workers AI through
 *   the AI binding. Deploy on the Workers **Free** plan, where Workers AI stops
 *   with an error once the free 10,000 Neurons a day are used: it can't bill.
 *   The Worker refuses to serve unless ACCOUNT_PLAN is "free". Ledger unit:
 *   Neurons.
 *
 *   "deepinfra" | "openrouter" | "openai-compatible": an external provider,
 *   paid per token with a key in the INFERENCE_API_KEY secret. Cloudflare no
 *   longer bills inference, so the dollar caps (GLOBAL_DAILY_USD,
 *   GLOBAL_MONTHLY_USD) are what bound spending; the Worker refuses to serve
 *   unless both are set, along with the key and the prices. Ledger unit: µ$.
 */
import { DurableObject } from 'cloudflare:workers'
import { handle, sha256Hex, type ServerConfig } from './handler'
import { Ledger, type Identity, type LedgerLimits, type Quota, type ReserveResult, type SettleOptions } from './ledger'
import { inference, limits, type Env } from './config'

export type { Env } from './config'

/** The settings plus the bindings Cloudflare provides. */
type WorkerEnv = Env & { AI: Ai; LEDGER: DurableObjectNamespace<LedgerObject> }

/** One object holds the whole ledger, so every reservation is decided one at a time. */
export class LedgerObject extends DurableObject<WorkerEnv> {
  private readonly ledger: Ledger
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
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
  reserve(id: Identity, worst: number, expected: number, l?: LedgerLimits, fingerprint?: string): Promise<ReserveResult> {
    this.ledger.useLimits(l)
    return this.ledger.reserve(id, worst, expected, fingerprint)
  }
  settle(id: string, neurons: number | undefined, opts?: SettleOptions): Promise<void> {
    return this.ledger.settle(id, neurons, opts)
  }
  quota(id: Identity, l?: LedgerLimits): Promise<Quota> {
    this.ledger.useLimits(l)
    return this.ledger.quota(id)
  }
  isPaused(): Promise<boolean> {
    return this.ledger.isPaused()
  }
  setPaused(p: boolean): Promise<void> {
    return this.ledger.setPaused(p)
  }
  summary(l?: LedgerLimits): ReturnType<Ledger['summary']> {
    this.ledger.useLimits(l)
    return this.ledger.summary()
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const inf = inference(env)
    if (typeof inf === 'string') {
      // Fail closed: a missing key, price or spending cap means no answers, never unbounded ones.
      return Response.json({ error: { code: 'beta_closed', message: `Inkling’s AI server is not configured. (${inf}.)` } }, { status: 503 })
    }
    const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
    const config: ServerConfig = {
      model: inf.model,
      provider: inf.provider,
      publicModel: inf.publicModel,
      minNoticeVersion: inf.minNotice,
      inputMargin: inf.inputMargin,
      freeProvider: inf.freeProvider,
      rates: inf.rates,
      reasoningEffort: env.REASONING_EFFORT ?? '',
      disableThinking: env.DISABLE_THINKING === 'true',
      structured: env.STRUCTURED === 'json_schema' ? 'json_schema' : 'prompt',
      imagePatch: Number(env.IMAGE_PATCH) || 28,
      maxBodyBytes: 3_500_000,
      maxInputTokens: Number(env.MAX_INPUT_TOKENS) || 12_000,
      adminTokenHash: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 ? await sha256Hex(env.ADMIN_TOKEN) : null
    }
    // The stub's methods match Ledger's (RPC returns plain data); each call carries this version's limits.
    const l = limits(env)
    const ledger = {
      reserve: (id: Identity, worst: number, expected: number, fp?: string) => stub.reserve(id, worst, expected, l, fp),
      quota: (id: Identity) => stub.quota(id, l),
      summary: () => stub.summary(l),
      settle: (id: string, n: number | undefined, o?: SettleOptions) => stub.settle(id, n, o),
      isPaused: () => stub.isPaused(),
      setPaused: (p: boolean) => stub.setPaused(p)
    } as unknown as Ledger
    return handle(request, { ai: inf.ai, ledger, config, waitUntil: (p) => ctx.waitUntil(p) })
  }
} satisfies ExportedHandler<WorkerEnv>
