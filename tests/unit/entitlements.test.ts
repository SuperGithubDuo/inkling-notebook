/**
 * Free/Pro entitlements end to end: the Supabase schema and RLS (real migrations in
 * PGlite), the Worker's account verification against a fake Supabase that answers
 * my_entitlement() from that database, the AI server's per-account allowances, and
 * the rule that no notebook feature depends on a plan.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ALICE, BOB, startSupabaseDb } from './supabaseDb'
import { supabaseAccounts } from '../../beta-server/src/account'
import { Ledger, type Identity, type LedgerLimits } from '../../beta-server/src/ledger'
import { accounts as accountsFromEnv, limits as limitsFromEnv, type Env } from '../../beta-server/src/config'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { CORE_FEATURES, canUse, entitlementSchema, type Entitlement } from '../../src/shared/entitlements'

const CAROL = '33333333-3333-4333-8333-333333333333'
const SUPABASE = 'https://project.supabase.co'
const ANON_KEY = 'public-anon-key'
const INSTALL_A = 'inst_' + 'A'.repeat(32)
const INSTALL_B = 'inst_' + 'B'.repeat(32)

let db: Awaited<ReturnType<typeof startSupabaseDb>>['db']
let as: Awaited<ReturnType<typeof startSupabaseDb>>['as']

beforeAll(async () => {
  ;({ db, as } = await startSupabaseDb())
  await db.query(`insert into auth.users values ('${CAROL}')`)
})

/** Sets an account's subscription as the billing webhook (service role) would. */
async function subscribe(user: string, row: { plan?: string; status?: string; proUntil?: string | null } | null): Promise<void> {
  await db.query('delete from public.subscriptions where user_id = $1', [user])
  if (row) await db.query('insert into public.subscriptions (user_id, plan, status, pro_until) values ($1, $2, $3, $4)', [user, row.plan ?? 'pro', row.status ?? 'active', row.proUntil === undefined ? new Date(Date.now() + 30 * 86400_000).toISOString() : row.proUntil])
}
const entitlementOf = async (user: string | null): Promise<Entitlement | null> => (await as(user, 'select public.my_entitlement() as r'))[0].r

// ---------------------------------------------------------------- fake Supabase

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>): string => `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('signature').toString('base64url')}`

/**
 * Stands in for Supabase's PostgREST: only tokens it issued verify (a forged or edited
 * token has no valid signature), and my_entitlement() runs in the real database as that user.
 */
function fakeSupabase() {
  const issued = new Map<string, string>()
  const state = { down: false, status: 200, calls: 0 }
  const token = (sub: string, claims: Record<string, unknown> = {}): string => {
    const t = jwt({ sub, role: 'authenticated', iss: `${SUPABASE}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })
    issued.set(t, sub)
    return t
  }
  const fetch = (async (url: string, init: RequestInit) => {
    state.calls++
    if (state.down) throw new TypeError('fetch failed')
    if (state.status !== 200) return new Response('{}', { status: state.status })
    const headers = init.headers as Record<string, string>
    expect(url).toBe(`${SUPABASE}/rest/v1/rpc/my_entitlement`)
    expect(headers.apikey).toBe(ANON_KEY)
    const sub = issued.get(headers.authorization!.replace(/^Bearer /, ''))
    if (!sub) return Response.json({ code: 'PGRST301', message: 'JWT invalid' }, { status: 401 })
    return Response.json(await entitlementOf(sub))
  }) as unknown as typeof globalThis.fetch
  return { state, token, fetch }
}

// ------------------------------------------------------------------- database

describe('entitlements in Supabase', () => {
  afterEach(async () => {
    for (const u of [ALICE, BOB, CAROL]) await subscribe(u, null)
  })

  it('an account with no subscription is Free, in the shared contract’s shape', async () => {
    const e = await entitlementOf(ALICE)
    expect(entitlementSchema.parse(e)).toMatchObject({ version: 1, user_id: ALICE, plan: 'free', status: 'none', pro_until: null })
  })

  it('Pro only while the subscription is in good standing and not past its end', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const cases: Array<[Parameters<typeof subscribe>[1], 'free' | 'pro']> = [
      [{ status: 'active' }, 'pro'],
      [{ status: 'trialing' }, 'pro'],
      [{ status: 'past_due' }, 'pro'], // within the grace the webhook set in pro_until
      [{ status: 'active', proUntil: past }, 'free'], // expired
      [{ status: 'past_due', proUntil: past }, 'free'], // grace over
      [{ status: 'canceled' }, 'free'],
      [{ status: 'expired' }, 'free'],
      [{ status: 'active', proUntil: null }, 'free'],
      [{ plan: 'free', status: 'active' }, 'free']
    ]
    for (const [row, plan] of cases) {
      await subscribe(ALICE, row)
      expect((await entitlementOf(ALICE))?.plan, JSON.stringify(row)).toBe(plan)
    }
  })

  it('each account reads only its own subscription; visitors read nothing', async () => {
    await subscribe(ALICE, { status: 'active' })
    await subscribe(BOB, { status: 'canceled' })
    expect((await as(ALICE, 'select user_id from subscriptions')).map((r) => r.user_id)).toEqual([ALICE])
    expect((await as(BOB, 'select user_id, status from subscriptions'))).toEqual([{ user_id: BOB, status: 'canceled' }])
    expect(await as(CAROL, 'select * from subscriptions')).toEqual([])
    expect((await entitlementOf(BOB))?.plan).toBe('free')
    await expect(as(null, 'select * from subscriptions')).rejects.toThrow(/permission denied/)
    await expect(entitlementOf(null)).rejects.toThrow(/permission denied/)
  })

  it('the revokes hold against Supabase’s default grants to the API roles', async () => {
    await db.exec('create table public.probe (x int)')
    // The stub grants new objects like Supabase does, so a missing revoke would show here.
    expect((await db.query<{ ok: boolean }>(`select has_table_privilege('anon', 'public.probe', 'insert') as ok`)).rows[0]!.ok).toBe(true)
    await db.exec('drop table public.probe')
    const priv = async (sql: string): Promise<boolean> => (await db.query<{ ok: boolean }>(`select ${sql} as ok`)).rows[0]!.ok
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) expect(await priv(`has_table_privilege('${role}', 'public.subscriptions', '${p}')`), `${role} ${p}`).toBe(false)
    }
    expect(await priv(`has_table_privilege('anon', 'public.subscriptions', 'select')`)).toBe(false)
    expect(await priv(`has_table_privilege('authenticated', 'public.subscriptions', 'select')`)).toBe(true)
    expect(await priv(`has_function_privilege('anon', 'public.my_entitlement()', 'execute')`)).toBe(false)
    expect(await priv(`has_function_privilege('authenticated', 'public.my_entitlement()', 'execute')`)).toBe(true)
    // Security invoker: it runs with the caller's rights (and RLS), never the owner's.
    expect((await db.query<{ d: boolean }>(`select prosecdef as d from pg_proc where proname = 'my_entitlement'`)).rows[0]!.d).toBe(false)
    expect((await db.query<{ r: boolean }>(`select relrowsecurity as r from pg_class where relname = 'subscriptions'`)).rows[0]!.r).toBe(true)
  })

  it('no client can grant itself (or anyone) Pro', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString()
    await expect(as(ALICE, `insert into subscriptions (user_id, plan, status, pro_until) values ('${ALICE}', 'pro', 'active', '${future}')`)).rejects.toThrow(/permission denied/)
    await subscribe(ALICE, { plan: 'free', status: 'canceled' })
    await expect(as(ALICE, `update subscriptions set plan = 'pro', status = 'active', pro_until = '${future}'`)).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, 'delete from subscriptions')).rejects.toThrow(/permission denied/)
    await expect(as(null, `insert into subscriptions (user_id, plan) values ('${BOB}', 'pro')`)).rejects.toThrow(/permission denied/)
    expect((await entitlementOf(ALICE))?.plan).toBe('free')
  })

  it('an expired subscription locks no notebook: reading, writing, deleting and files all still work', async () => {
    await subscribe(CAROL, { status: 'active', proUntil: new Date(Date.now() - 1000).toISOString() })
    expect((await entitlementOf(CAROL))?.plan).toBe('free')
    const path = 'page/notebook-9/page-000009'
    expect((await as(CAROL, 'select public.push_doc($1, 0, $2::jsonb, false, false, $3) as r', [path, '{"v":1}', 'dev']))[0].r).toEqual({ ok: true, rev: 1 })
    expect((await as(CAROL, 'select public.push_doc($1, 1, $2::jsonb, false, false, $3) as r', [path, '{"v":2}', 'dev']))[0].r).toEqual({ ok: true, rev: 2 })
    expect((await as(CAROL, 'select content from docs where path = $1', [path]))[0].content).toEqual({ v: 2 })
    expect((await as(CAROL, 'select count(*)::int as n from doc_versions where path = $1', [path]))[0].n).toBe(1)
    const file = `${CAROL}/notebook-9/abcdef123456.pdf`
    await as(CAROL, `insert into storage.objects (bucket_id, name) values ('assets', $1)`, [file])
    expect((await as(CAROL, 'select name from storage.objects where name = $1', [file])).length).toBe(1)
    expect((await as(CAROL, 'select public.push_doc($1, 2, null, true, false, $2) as r', [path, 'dev']))[0].r).toEqual({ ok: true, rev: 3 })
  })
})

describe('notebook features never depend on a plan', () => {
  it('every core feature is available with no, a Free, an expired or an unreadable entitlement', () => {
    const free = { version: 1, user_id: ALICE, plan: 'free', status: 'expired', pro_until: '2026-01-01T00:00:00Z', checked_at: '2026-11-14T00:00:00Z' } as const
    for (const f of CORE_FEATURES) for (const e of [null, undefined, free]) expect(canUse(f, e), f).toBe(true)
    expect(CORE_FEATURES).toEqual(expect.arrayContaining(['notebooks', 'handwriting', 'pdf_import', 'pdf_annotation', 'offline', 'sync', 'backup', 'export', 'existing_notes']))
    expect(canUse('ai_pro_allowance', free)).toBe(false)
    expect(canUse('ai_pro_allowance', { ...free, plan: 'pro', status: 'active' })).toBe(true)
  })
})

// ------------------------------------------------------- Worker: verification

describe('account verification in the AI server', () => {
  let sb: ReturnType<typeof fakeSupabase>
  let clock: number
  const verifier = () => supabaseAccounts({ url: SUPABASE, anonKey: ANON_KEY, fetch: sb.fetch, now: () => clock })
  beforeEach(() => {
    sb = fakeSupabase()
    clock = Date.now()
  })
  afterEach(async () => subscribe(ALICE, null))

  it('takes the account and its plan from Supabase, never from the token’s own claims', async () => {
    const verify = verifier()
    // A real session whose token also claims Pro and the service role: the claims are ignored.
    expect(await verify(sb.token(ALICE, { plan: 'pro', app_metadata: { plan: 'pro' } }))).toEqual({ userId: ALICE, plan: 'free' })
    await subscribe(BOB, { status: 'active' })
    expect(await verify(sb.token(BOB))).toEqual({ userId: BOB, plan: 'pro' })
    await subscribe(BOB, null)
  })

  it('refuses forged, expired, foreign and malformed tokens; the cheap ones without asking Supabase', async () => {
    const verify = verifier()
    const forged = jwt({ sub: ALICE, role: 'service_role', plan: 'pro', iss: `${SUPABASE}/auth/v1`, exp: Math.floor(clock / 1000) + 3600 })
    expect(await verify(forged)).toBe('invalid')
    expect(sb.state.calls).toBe(1)
    for (const t of [
      sb.token(ALICE, { exp: Math.floor(clock / 1000) - 1 }),
      sb.token(ALICE, { iss: 'https://other.supabase.co/auth/v1' }),
      sb.token(ALICE, { exp: undefined }),
      'not-a-jwt',
      ANON_KEY,
      'a.b.c',
      sb.token(ALICE, { pad: 'x'.repeat(5000) })
    ])
      expect(await verify(t)).toBe('invalid')
    expect(sb.state.calls).toBe(1)
  })

  it('a token Supabase answers with no account (no session) is invalid', async () => {
    const t = sb.token(ALICE)
    const verify = supabaseAccounts({ url: SUPABASE, anonKey: ANON_KEY, fetch: (async () => Response.json(null)) as unknown as typeof fetch })
    expect(await verify(t)).toBe('invalid')
    const lying = supabaseAccounts({ url: SUPABASE, anonKey: ANON_KEY, fetch: (async () => Response.json({ plan: 'pro' })) as unknown as typeof fetch })
    expect(await lying(t)).toBe('invalid')
  })

  it('Supabase down or failing is “unavailable” (not Free, not Pro), and is asked again next time', async () => {
    const verify = verifier()
    const t = sb.token(ALICE)
    sb.state.down = true
    expect(await verify(t)).toBe('unavailable')
    sb.state.down = false
    sb.state.status = 500
    expect(await verify(t)).toBe('unavailable')
    sb.state.status = 200
    expect(await verify(t)).toEqual({ userId: ALICE, plan: 'free' })
  })

  it('caches a verified token for a minute at most, and never past its expiry', async () => {
    const verify = verifier()
    const t = sb.token(ALICE)
    await verify(t)
    await verify(t)
    expect(sb.state.calls).toBe(1)
    await subscribe(ALICE, { status: 'active' })
    clock += 61_000
    expect(await verify(t)).toEqual({ userId: ALICE, plan: 'pro' })
    expect(sb.state.calls).toBe(2)
    // A token expiring in 5 s is not served from the cache after that.
    const short = sb.token(ALICE, { exp: Math.floor(clock / 1000) + 5 })
    await verify(short)
    clock += 6000
    expect(await verify(short)).toBe('invalid')
  })

  it('off only when neither Supabase setting is given; half a configuration refuses signed-in requests', async () => {
    expect(accountsFromEnv({} as Env)).toBeUndefined()
    expect(accountsFromEnv({ SUPABASE_URL: ' ', SUPABASE_ANON_KEY: '' } as Env)).toBeUndefined()
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(' '))
    try {
      for (const env of [{ SUPABASE_URL: SUPABASE }, { SUPABASE_ANON_KEY: ANON_KEY }, { SUPABASE_URL: 'http://project.supabase.co', SUPABASE_ANON_KEY: ANON_KEY }, { SUPABASE_URL: 'project.supabase.co', SUPABASE_ANON_KEY: ANON_KEY }]) {
        const verify = accountsFromEnv(env as Env)
        expect(verify, JSON.stringify(env)).toBeTypeOf('function')
        expect(await verify!(sb.token(ALICE))).toBe('unavailable')
      }
    } finally {
      console.error = orig
    }
    expect(errors).toHaveLength(4)
    expect(JSON.stringify(errors)).not.toContain(ANON_KEY)
    expect(accountsFromEnv({ SUPABASE_URL: SUPABASE + '/', SUPABASE_ANON_KEY: ANON_KEY } as Env)).toBeTypeOf('function')
  })

  it('refuses an answer for a different account than the token’s subject', async () => {
    const t = sb.token(ALICE)
    const swapped = supabaseAccounts({ url: SUPABASE, anonKey: ANON_KEY, fetch: (async () => Response.json(await entitlementOf(BOB))) as unknown as typeof fetch })
    expect(await swapped(t)).toBe('invalid')
  })
})

// ------------------------------------------------------------ Worker: limits

describe('per-account AI allowances', () => {
  const limits: LedgerLimits = {
    globalDailyNeurons: 1000,
    installDailyNeurons: 200,
    networkDailyNeurons: 800,
    installPerMinute: 100,
    networkPerMinute: 100,
    installConcurrent: 50,
    networkConcurrent: 50,
    globalConcurrent: 50,
    reservationTtlMs: 600_000,
    typicalNeuronsPerAnswer: 50,
    pro: { daily: 600 }
  }
  const t = Date.UTC(2026, 10, 14, 12)
  const fresh = (l: LedgerLimits = limits) => {
    const map = new Map<string, unknown>()
    return new Ledger({ get: async (k) => structuredClone(map.get(k)) as never, put: async (k, v) => void map.set(k, structuredClone(v)), delete: async (k) => void map.delete(k), list: async (p) => [...map.keys()].filter((k) => k.startsWith(p)) }, l, () => t)
  }
  const pro = (n: number, network = `10.0.0.${n}`): Identity => ({ install: `acct:${n}`, network, plan: 'pro' })

  it('simultaneous requests can’t together pass a Pro account’s allowance', async () => {
    const ledger = fresh()
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.reserve(pro(1), 100, 100)))
    expect(results.filter((r) => r.ok)).toHaveLength(6)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'install_quota')).toBe(true)
  })

  it('the global cap still bounds Pro, under simultaneous load from many Pro accounts', async () => {
    const ledger = fresh()
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => ledger.reserve(pro(i), 100, 100)))
    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect((await ledger.summary()).globalUsed).toBeLessThanOrEqual(1000)
    expect(results.some((r) => !r.ok && r.code === 'global_quota')).toBe(true)
  })

  it('Pro is not held to its network’s shared pool, and doesn’t use it up; the monthly caps still apply', async () => {
    const ledger = fresh({ ...limits, globalDailyNeurons: 2000 })
    const school = '198.51.100.1'
    const anon = (n: number): Identity => ({ install: 'inst_' + String(n).repeat(32), network: school })
    // Free use fills most of the school's shared 800 …
    for (const n of [1, 2, 3, 4]) {
      const r = await ledger.reserve(anon(n), 190, 190)
      if (!r.ok) throw new Error(r.code)
      await ledger.settle(r.reservationId, 190)
    }
    expect(await ledger.reserve(anon(5), 100, 50)).toMatchObject({ ok: false, code: 'network_quota' })
    // … yet two Pro students there still get their own 600 each,
    for (const n of [1, 2]) {
      const r = await ledger.reserve(pro(n, school), 500, 500)
      expect(r.ok, `pro ${n}`).toBe(true)
      if (r.ok) await ledger.settle(r.reservationId, 500)
    }
    expect((await ledger.quota(pro(1, school))).networkLimit).toBe(600)
    // … and a Pro student's use is not taken from the free pool (still 760 of 800 used).
    expect((await ledger.quota(anon(6))).networkUsed).toBe(760)
    // Each Pro account is still capped by its own allowance, and everyone by the global cap.
    expect(await ledger.reserve(pro(1, school), 200, 200)).toMatchObject({ ok: false, code: 'install_quota' })
    expect(await ledger.reserve(pro(3, school), 300, 100)).toMatchObject({ ok: false, code: 'global_quota' })
    // Free accounts are free to make: they stay in the shared pool.
    expect(await ledger.reserve({ install: `acct:${ALICE}`, network: school, plan: 'free' }, 100, 50)).toMatchObject({ ok: false, code: 'network_quota' })
    const monthly = fresh({ ...limits, unit: 'usd', globalMonthly: 300 })
    expect(await monthly.reserve(pro(3), 400, 100)).toMatchObject({ ok: false, code: 'global_monthly_quota' })
    // A Pro allowance without its own monthly cap keeps everyone's.
    const perMonth = fresh({ ...limits, installMonthly: 250 })
    expect(await perMonth.reserve(pro(4), 300, 300)).toMatchObject({ ok: false, code: 'install_monthly_quota' })
  })

  it('without a configured Pro allowance, Pro gets exactly the Free allowance: nothing is raised by default', async () => {
    const { pro: _, ...noPro } = limits
    const ledger = fresh(noPro)
    expect(await ledger.reserve(pro(1), 300, 300)).toMatchObject({ ok: false, code: 'too_large' })
    expect((await ledger.quota(pro(1))).installLimit).toBe(200)
    // The Worker's settings: no PRO_* variable, no Pro allowance; the hard caps are unchanged either way.
    const env = { INFERENCE_PROVIDER: 'deepinfra', GLOBAL_DAILY_USD: '5', GLOBAL_MONTHLY_USD: '100' } as Env
    expect(limitsFromEnv(env).pro).toBeUndefined()
    const withPro = limitsFromEnv({ ...env, PRO_DAILY_USD: '0.5', PRO_MONTHLY_USD: '6' })
    expect(withPro.pro).toEqual({ daily: 500_000, monthly: 6_000_000 })
    expect([withPro.globalDailyNeurons, withPro.globalMonthly]).toEqual([limitsFromEnv(env).globalDailyNeurons, limitsFromEnv(env).globalMonthly])
    expect(limitsFromEnv({ ACCOUNT_PLAN: 'free' } as Env).pro).toBeUndefined()
    expect(limitsFromEnv({ ACCOUNT_PLAN: 'free', PRO_DAILY_NEURONS: '1800' } as Env).pro).toEqual({ daily: 1800 })
  })

  it('switching between Free and Pro keeps the same account counters: nothing resets', async () => {
    const ledger = fresh()
    const as = (plan: 'free' | 'pro'): Identity => ({ install: `acct:${ALICE}`, network: '10.2.2.2', plan })
    const r = await ledger.reserve(as('free'), 150, 150)
    if (!r.ok) throw new Error(r.code)
    await ledger.settle(r.reservationId, 150)
    expect(await ledger.quota(as('pro'))).toMatchObject({ installUsed: 150, installLimit: 600, plan: 'pro' })
    const p = await ledger.reserve(as('pro'), 300, 300)
    if (!p.ok) throw new Error(p.code)
    await ledger.settle(p.reservationId, 300)
    // Pro lapses: 450 used counts against Free's 200 (refused), and coming back to Pro finds it too.
    expect(await ledger.reserve(as('free'), 10, 10)).toMatchObject({ ok: false, code: 'install_quota' })
    expect((await ledger.quota(as('pro'))).installUsed).toBe(450)
    // An answer in progress on Free is still in progress on Pro: one at a time per account.
    const one = fresh({ ...limits, installConcurrent: 1 })
    const open = await one.reserve(as('free'), 10, 10)
    expect(open.ok).toBe(true)
    expect(await one.reserve(as('pro'), 10, 10)).toMatchObject({ ok: false, code: 'busy' })
  })

  it('a Free account is counted per account and gets the anonymous allowance', async () => {
    const ledger = fresh()
    const free: Identity = { install: `acct:${ALICE}`, network: '10.1.1.1', plan: 'free' }
    expect((await ledger.quota(free))).toMatchObject({ installLimit: 200, plan: 'free' })
    expect((await ledger.quota({ install: INSTALL_A, network: '10.1.1.1' })).plan).toBeUndefined()
  })
})

// ------------------------------------------------------------- Worker: HTTP

describe('AI server with accounts', () => {
  let server: BetaServer
  let sb: ReturnType<typeof fakeSupabase>
  let clock: number
  afterEach(async () => {
    await server?.close()
    for (const u of [ALICE, BOB]) await subscribe(u, null)
  })
  const start = async (opts: Record<string, unknown> = {}) => {
    sb = fakeSupabase()
    clock = Date.now()
    server = await startBetaServer({ accounts: supabaseAccounts({ url: SUPABASE, anonKey: ANON_KEY, fetch: sb.fetch, now: () => clock }), limits: { pro: { daily: 2700 } }, ...opts })
  }
  const headers = (o: { token?: string; install?: string; ip?: string; extra?: Record<string, string> } = {}): Record<string, string> => ({
    'x-inkling-install': o.install ?? INSTALL_A,
    ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    ...(o.ip ? { 'x-test-ip': o.ip } : {}),
    ...o.extra
  })
  const chat = (text: string, extra: Record<string, unknown> = {}) => ({ task: 'chat', turns: [{ role: 'user', parts: [{ text }] }], ...extra })
  const post = async (body: unknown, o: Parameters<typeof headers>[0] = {}): Promise<{ status: number; json?: any; done?: any }> => {
    const res = await fetch(`${server.url}/v1/tutor`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers(o) }, body: JSON.stringify(body) })
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, json: await res.json() }
    const last = (await res.text()).split('\n\n').filter(Boolean).at(-1)!
    return { status: res.status, done: JSON.parse(/^data: (.*)$/m.exec(last)![1]!) }
  }
  const status = async (o: Parameters<typeof headers>[0] = {}) => (await fetch(`${server.url}/v1/status`, { headers: headers(o) })).json()
  /** One answer costing ≈ 914 Neurons (more than a Free day's 900). */
  const big = { text: 'x', usage: { inputTokens: 1000, outputTokens: 3000 } }

  it('Free and Pro accounts get their own plan’s allowance; anonymous apps are unchanged', async () => {
    await start()
    await subscribe(BOB, { status: 'active' })
    expect((await status({ token: sb.token(ALICE) })).quota).toMatchObject({ plan: 'free', installLimit: 900 })
    expect((await status({ token: sb.token(BOB) })).quota).toMatchObject({ plan: 'pro', installLimit: 2700 })
    const anon = (await status()).quota
    expect(anon).toMatchObject({ installLimit: 900 })
    expect(anon.plan).toBeUndefined()
    const r = await post(chat('hi'), { token: sb.token(BOB) })
    expect(r.status).toBe(200)
    expect(r.done.quota.plan).toBe('pro')
  })

  it('faking Pro in headers or the request body changes nothing', async () => {
    await start()
    const fake = { 'x-inkling-plan': 'pro', 'x-inkling-entitlement': '{"plan":"pro"}' }
    expect((await status({ extra: fake })).quota.installLimit).toBe(900)
    expect((await status({ token: sb.token(ALICE, { plan: 'pro' }), extra: fake })).quota).toMatchObject({ plan: 'free', installLimit: 900 })
    const r = await post(chat('hi', { plan: 'pro', entitlement: { plan: 'pro' }, quota: 1e9 }), { token: sb.token(ALICE), extra: fake })
    expect(r.done.quota).toMatchObject({ plan: 'free', installLimit: 900 })
    // A token edited to say Pro (or service_role) no longer verifies.
    const forged = jwt({ sub: ALICE, role: 'service_role', plan: 'pro', iss: `${SUPABASE}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 })
    expect((await post(chat('hi'), { token: forged })).status).toBe(401)
  })

  it('unauthorized requests are refused before the model, and nothing is reserved', async () => {
    await start()
    const expired = sb.token(ALICE, { exp: Math.floor(Date.now() / 1000) - 10 })
    for (const auth of [`Bearer ${expired}`, 'Bearer garbage', `Basic ${btoa('a:b')}`, 'Bearer ']) {
      const res = await fetch(`${server.url}/v1/tutor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': INSTALL_A, authorization: auth }, body: JSON.stringify(chat('hi')) })
      expect(res.status, auth).toBe(401)
      expect((await res.json()).error).toMatchObject({ code: 'invalid_key', scope: 'account' })
    }
    expect((await fetch(`${server.url}/v1/status`, { headers: headers({ token: expired }) })).status).toBe(401)
    sb.state.down = true
    const down = await post(chat('hi'), { token: sb.token(ALICE) })
    expect(down.status).toBe(503)
    expect(down.json.error).toMatchObject({ code: 'server', scope: 'account_unavailable', retryAfter: 30 })
    expect(server.ai.calls).toHaveLength(0)
    expect((await server.admin('GET', '/admin/summary')).body).toMatchObject({ globalUsed: 0, answering: 0 })
  })

  it('a server with accounts off ignores tokens: older and anonymous apps keep working as before', async () => {
    sb = fakeSupabase()
    server = await startBetaServer({})
    const r = await post(chat('hi'), { token: sb.token(ALICE) })
    expect(r.status).toBe(200)
    expect(r.done.quota.plan).toBeUndefined()
    expect(sb.state.calls).toBe(0)
  })

  it('never logs a token, whatever happens to it; the operator summary says whether accounts are on', async () => {
    await start()
    const logs: string[] = []
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(' '))
    const tokens = [sb.token(ALICE), sb.token(ALICE, { exp: Math.floor(Date.now() / 1000) - 5 }), jwt({ sub: ALICE, iss: `${SUPABASE}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 99 })]
    try {
      for (const t of tokens) await post(chat('hi'), { token: t })
      sb.state.down = true
      const t = sb.token(BOB)
      tokens.push(t)
      await post(chat('hi'), { token: t })
      sb.state.down = false
      sb.state.status = 500
      const u = sb.token(BOB)
      tokens.push(u)
      await post(chat('hi'), { token: u })
      await server.settled()
    } finally {
      Object.assign(console, orig)
    }
    expect(logs.length).toBeGreaterThan(0)
    for (const t of tokens) for (const part of t.split('.')) expect(logs.join('\n')).not.toContain(part)
    expect(logs.join('\n')).not.toContain(ALICE)
    expect((await server.admin('GET', '/admin/summary')).body.accounts).toBe('on')
  })

  it('the operator summary tells on, off and misconfigured apart, from the Worker’s own settings', async () => {
    const summaryFor = async (env: Partial<Env>): Promise<string> => {
      await server?.close()
      server = await startBetaServer({ accounts: accountsFromEnv(env as Env) })
      return (await server.admin('GET', '/admin/summary')).body.accounts
    }
    const orig = console.error
    console.error = () => undefined
    try {
      expect(await summaryFor({ SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: ANON_KEY })).toBe('on')
      expect(await summaryFor({})).toBe('off')
      expect(await summaryFor({ SUPABASE_URL: '', SUPABASE_ANON_KEY: ' ' })).toBe('off')
      for (const env of [{ SUPABASE_URL: SUPABASE }, { SUPABASE_ANON_KEY: ANON_KEY }, { SUPABASE_URL: 'http://project.supabase.co', SUPABASE_ANON_KEY: ANON_KEY }]) {
        expect(await summaryFor(env), JSON.stringify(env)).toBe('misconfigured')
        // Unchanged behaviour: a signed-in request is still refused, an anonymous one still answered.
        expect((await post(chat('hi'), { token: 'a.b.c' })).json.error.scope).toBe('account_unavailable')
        expect((await post(chat('hi'))).status).toBe(200)
      }
    } finally {
      console.error = orig
    }
  })

  it('CORS lets the web app send its token', async () => {
    await start({ allowedOrigins: ['https://app.example'] })
    const pre = await fetch(`${server.url}/v1/tutor`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } })
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/)
  })

  it('an account’s allowance is shared by all its devices and refused when used up', async () => {
    await start()
    server.ai.reply(big)
    expect((await post(chat('one'), { token: sb.token(ALICE), install: INSTALL_A })).status).toBe(200)
    await server.settled()
    const again = await post(chat('two'), { token: sb.token(ALICE), install: INSTALL_B, ip: '192.0.2.50' })
    expect(again.status).toBe(429)
    expect(again.json.error).toMatchObject({ code: 'daily_quota', scope: 'install_quota' })
    expect(again.json.error.message).toMatch(/on your account/)
    // Another account (or this computer anonymously) is not affected by Alice's account.
    expect((await post(chat('three'), { token: sb.token(BOB), install: INSTALL_B, ip: '192.0.2.51' })).status).toBe(200)
  })

  it('one answer at a time per account, across devices', async () => {
    await start()
    server.ai.reply({ chunks: ['a', 'b', 'c'], chunkDelayMs: 150 })
    const t = sb.token(ALICE)
    const [a, b] = await Promise.all([post(chat('one'), { token: t, install: INSTALL_A }), post(chat('two'), { token: t, install: INSTALL_B, ip: '192.0.2.60' })])
    expect([a.status, b.status].sort()).toEqual([200, 429])
    expect([a, b].find((r) => r.status === 429)!.json.error.scope).toBe('busy')
  })

  it('when Pro expires, the account falls back to the Free allowance (after the short cache), never more', async () => {
    await start()
    await subscribe(BOB, { status: 'active' })
    const t = sb.token(BOB)
    server.ai.reply(big)
    expect((await post(chat('one'), { token: t })).done.quota).toMatchObject({ plan: 'pro', installLimit: 2700 })
    await server.settled()
    await subscribe(BOB, { status: 'active', proUntil: new Date(Date.now() - 1000).toISOString() })
    clock += 61_000
    const after = await post(chat('two'), { token: t })
    expect(after.status).toBe(429)
    expect(after.json.error.quota).toMatchObject({ plan: 'free', installLimit: 900 })
  })

  it('the existing spending protections hold for Pro: global cap and pause; the shared network pool doesn’t block it', async () => {
    await start({ globalDailyNeurons: 1000, networkDailyNeurons: 5000 })
    await subscribe(BOB, { status: 'active' })
    server.ai.reply(big)
    expect((await post(chat('one'), { token: sb.token(BOB) })).status).toBe(200)
    await server.settled()
    const global = await post(chat('two'), { token: sb.token(BOB) })
    expect(global.status).toBe(429)
    expect(global.json.error.scope).toBe('global_quota')
    await server.close()

    await start({ networkDailyNeurons: 1000 })
    await subscribe(BOB, { status: 'active' })
    server.ai.reply(big)
    // An anonymous app uses up the network's shared 1,000; Bob (Pro) on the same network is still answered.
    await post(chat('one'), { ip: '192.0.2.70' })
    await server.settled()
    expect((await post(chat('two'), { install: INSTALL_B, ip: '192.0.2.70' })).json.error.scope).toBe('network_quota')
    expect((await post(chat('pro'), { token: sb.token(BOB), ip: '192.0.2.70' })).status).toBe(200)
    await server.pause()
    expect((await post(chat('three'), { token: sb.token(BOB), ip: '192.0.2.71' })).json.error.scope).toBe('paused')
  })
})
