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
import { Ledger, type Identity, type LedgerLimits, type Quota, type ReserveResult, type SettleOptions, type UsageRecord } from './ledger'
import { inference, limits, type Env } from './config'
import { textModelFrom } from './route'

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
  settle(id: string, neurons: number | undefined, opts?: SettleOptions, l?: LedgerLimits): Promise<void> {
    this.ledger.useLimits(l)
    return this.ledger.settle(id, neurons, opts)
  }
  quota(id: Identity, l?: LedgerLimits): Promise<Quota> {
    this.ledger.useLimits(l)
    return this.ledger.quota(id)
  }
  // Every call carries the caller's limits: one class serves two ledgers (DeepInfra in µ$, the bridge
  // for older apps in Neurons), and a restarted object must never apply the other one's unit.
  record(r: UsageRecord, l?: LedgerLimits): Promise<void> {
    this.ledger.useLimits(l)
    return this.ledger.record(r)
  }
  isPaused(l?: LedgerLimits): Promise<boolean> {
    this.ledger.useLimits(l)
    return this.ledger.isPaused()
  }
  setPaused(p: boolean, l?: LedgerLimits): Promise<void> {
    this.ledger.useLimits(l)
    return this.ledger.setPaused(p)
  }
  summary(l?: LedgerLimits): ReturnType<Ledger['summary']> {
    this.ledger.useLimits(l)
    return this.ledger.summary()
  }
}

/** The Worker's server settings for one provider (shared by the main path and the bridge for older apps). */
async function serverConfig(env: WorkerEnv, inf: Exclude<ReturnType<typeof inference>, string>, legacy: boolean): Promise<ServerConfig> {
  return {
    model: inf.model,
    provider: inf.provider,
    publicModel: inf.publicModel,
    // The bridge answers apps whose notice names only Cloudflare: no notice gate there.
    minNoticeVersion: legacy ? 0 : inf.minNotice,
    inputMargin: inf.inputMargin,
    upstreamAttempts: inf.upstreamAttempts ?? 1,
    rates: inf.rates,
    reasoningEffort: env.REASONING_EFFORT ?? '',
    disableThinking: env.DISABLE_THINKING === 'true',
    structured: env.STRUCTURED === 'json_schema' ? 'json_schema' : 'prompt',
    imagePatch: Number(env.IMAGE_PATCH) || 28,
    maxBodyBytes: 3_500_000,
    maxInputTokens: Number(env.MAX_INPUT_TOKENS) || 12_000,
    adminTokenHash: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 ? await sha256Hex(env.ADMIN_TOKEN) : null,
    // Text-only routing (route.ts) is a Workers AI rollback feature only. An external provider, and the
    // bridge for older apps, answer every request with the one model (Qwen 3.8 27B).
    textModel: inf.provider === 'workers-ai' && !legacy ? textModelFrom(env, env.MODEL) : null
  }
}

/** A ledger client for one Durable Object; each call carries this version's limits. */
function ledgerFor(stub: DurableObjectStub<LedgerObject>, l: LedgerLimits): Ledger {
  return {
    reserve: (id: Identity, worst: number, expected: number, fp?: string) => stub.reserve(id, worst, expected, l, fp),
    quota: (id: Identity) => stub.quota(id, l),
    summary: () => stub.summary(l),
    settle: (id: string, n: number | undefined, o?: SettleOptions) => stub.settle(id, n, o, l),
    record: (r: UsageRecord) => stub.record(r, l),
    isPaused: () => stub.isPaused(l),
    setPaused: (p: boolean) => stub.setPaused(p, l)
  } as unknown as Ledger
}

/**
 * The bridge for apps released before the DeepInfra notice (CLOUD_CONSENT_VERSION 4), set by
 * LEGACY_WORKERS_AI="true" while the server uses an external provider. Those apps' users agreed to a
 * notice that names only Cloudflare, so their requests must not go to DeepInfra: they are answered by
 * Workers AI, as before the switch, with Qwen 3.8 27B, under the Workers Free plan's limits and in a
 * separate ledger (Neurons, GLOBAL_DAILY_NEURONS etc.). They cost nothing and never touch the dollar
 * budget. Apps on notice 4 or later go to the external provider. Turn the bridge off once old
 * versions are gone: those apps then get "Update Inkling".
 */
function isLegacyApp(request: Request, minNotice: number): boolean {
  const n = Number(request.headers.get('x-inkling-notice') ?? '0')
  return !(Number.isFinite(n) && n >= minNotice)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const inf = inference(env)
    if (typeof inf === 'string') {
      // Fail closed: a missing key, price or spending cap means no answers, never unbounded ones.
      return Response.json({ error: { code: 'beta_closed', message: `Inkling’s AI server is not configured. (${inf}.)` } }, { status: 503 })
    }
    const url = new URL(request.url)
    const external = inf.provider !== 'workers-ai'
    const bridgeOn = external && env.LEGACY_WORKERS_AI === 'true'
    // Older apps on the bridge: /v1/* without notice 4. The operator reads the bridge's ledger at /admin/legacy/*.
    const legacyAdmin = bridgeOn && url.pathname.startsWith('/admin/legacy/')
    const legacy = bridgeOn && (legacyAdmin || (url.pathname.startsWith('/v1/') && isLegacyApp(request, inf.minNotice)))
    if (legacy) {
      const wenv = { ...env, INFERENCE_PROVIDER: 'workers-ai' } as WorkerEnv
      const winf = inference(wenv)
      // The bridge needs the Workers Free guard like the rollback path; misconfigured, old apps are told to update.
      if (typeof winf === 'string') {
        console.error('legacy bridge not configured', winf)
      } else {
        const r = legacyAdmin ? new Request(new URL(url.pathname.replace('/admin/legacy/', '/admin/') + url.search, url), request) : request
        const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger-workers-ai-bridge'))
        return handle(r, { ai: winf.ai, ledger: ledgerFor(stub, limits(wenv)), config: await serverConfig(wenv, winf, true), waitUntil: (p) => ctx.waitUntil(p) })
      }
    }
    const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
    return handle(request, { ai: inf.ai, ledger: ledgerFor(stub, limits(env)), config: await serverConfig(env, inf, false), waitUntil: (p) => ctx.waitUntil(p) })
  }
} satisfies ExportedHandler<WorkerEnv>
