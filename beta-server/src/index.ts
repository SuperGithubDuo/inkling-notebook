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
import { handle } from './handler'
import { Ledger, type Identity, type LedgerLimits, type Quota, type ReserveResult, type SettleOptions, type UsageRecord } from './ledger'
import { accounts, inference, limits, type Env } from './config'
import type { Accounts } from './account'
import { isLegacyApp, serverConfig } from './bridge'

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

/** One verifier per isolate, so its short cache of verified tokens is shared by requests. */
let accountsCache: Accounts | undefined

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const inf = inference(env)
    if (typeof inf === 'string') {
      // Fail closed: a missing key, price or spending cap means no answers, never unbounded ones.
      return Response.json({ error: { code: 'beta_closed', message: `Inkling’s AI server is not configured. (${inf}.)` } }, { status: 503 })
    }
    const url = new URL(request.url)
    accountsCache ??= accounts(env)
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
        return handle(r, { ai: winf.ai, ledger: ledgerFor(stub, limits(wenv)), config: await serverConfig(wenv, winf, true), accounts: accountsCache, waitUntil: (p) => ctx.waitUntil(p) })
      }
    }
    const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
    // The emergency pause is one switch: with the bridge on, /admin/pause also pauses (or resumes) the
    // bridge's ledger, so older apps stop too. Only after the main pause succeeded (authorised, valid).
    const pausing = bridgeOn && url.pathname === '/admin/pause' && request.method === 'POST' ? request.clone() : null
    const res = await handle(request, { ai: inf.ai, ledger: ledgerFor(stub, limits(env)), config: await serverConfig(env, inf, false), accounts: accountsCache, waitUntil: (p) => ctx.waitUntil(p) })
    if (pausing && res.status === 200) {
      const body = (await pausing.json().catch(() => null)) as { paused?: unknown } | null
      if (typeof body?.paused === 'boolean') {
        const wenv = { ...env, INFERENCE_PROVIDER: 'workers-ai' } as WorkerEnv
        await env.LEDGER.get(env.LEDGER.idFromName('ledger-workers-ai-bridge')).setPaused(body.paused, limits(wenv))
      }
    }
    return res
  }
} satisfies ExportedHandler<WorkerEnv>
