/**
 * The public AI service's allowance ledger: how much of the day's free
 * Workers AI allowance each installation, each network and the whole service
 * have used, and who is answering right now.
 *
 * Anyone may ask, without an account. Requests are attributed to two
 * anonymous identities:
 *   - the installation: a random ID the app creates on first run;
 *   - the network: the client's IP address as Cloudflare reports it (an IPv6
 *     client is grouped by its /64, the block a home or office gets).
 * Either can be changed by someone determined (reinstalling, another
 * network), so per-installation and per-network limits only spread the
 * allowance fairly among ordinary users; the global cap is what bounds use.
 *
 * Privacy: identities are stored only as SHA-256 hashes with a random salt
 * that changes every UTC day; at the day's end the salt and all per-identity
 * counts are deleted, so nothing links usage across days or back to an IP.
 *
 * Atomicity: one Durable Object holds the ledger, and every read-modify-write
 * runs inside `exclusive()`, a promise chain that admits one operation at a
 * time. Simultaneous requests therefore can't both take the last of the
 * budget, whatever the runtime interleaves between awaits.
 *
 * Accounting is conservative. Before a request reaches the model its worst
 * case (estimated input + the full output cap) is reserved against the global
 * cap; installation and network need room for a typical answer. The real cost
 * replaces the reservation afterwards; unknown cost (a cancelled stream, a
 * crash) stays charged in full. The global cap is set below Cloudflare's free
 * 10,000 Neurons a day, and Cloudflare's Workers Free plan refuses (never
 * bills) anything beyond its allowance.
 */

export interface LedgerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Keys starting with `prefix`. */
  list(prefix: string): Promise<string[]>
}

/**
 * All amounts are in the ledger's cost unit: Neurons when Workers AI answers,
 * micro-dollars (µ$, 1e-6 USD) when an external provider does. Field names keep
 * "Neurons" for compatibility with the Worker versions already deployed.
 */
export interface LedgerLimits {
  /**
   * Cap for the whole service over ANY 24 hours (not only a UTC day), below Cloudflare's
   * free 10,000. Cloudflare counts its allocation over a rolling window, so a calendar-day
   * cap alone let late use one day plus early use the next exceed it.
   */
  globalDailyNeurons: number
  installDailyNeurons: number
  networkDailyNeurons: number
  installPerMinute: number
  networkPerMinute: number
  installConcurrent: number
  networkConcurrent: number
  globalConcurrent: number
  /** A reservation not settled within this time is kept as charged and released. */
  reservationTtlMs: number
  /** Used to tell people roughly how many answers they have left. */
  typicalNeuronsPerAnswer: number
  /** The cost unit. When it changes (a provider switch or rollback), the day's counts restart in the new unit. */
  unit?: 'neurons' | 'usd'
  /** Whole-service cap per calendar month (UTC). Unset: none (Workers Free bounds itself). */
  globalMonthly?: number
  /** Per-installation cap per calendar month (UTC). Unset: none. */
  installMonthly?: number
  /**
   * Budget protection: once the whole service has used this share of its daily
   * or monthly cap, each installation's and network's daily allowance is scaled
   * by `softFactor`, so the remaining budget is spread over more people instead
   * of running out for everyone. Unset or 1: off.
   */
  softFraction?: number
  softFactor?: number
  /** An identical request from the same installation, already answered within this time, is refused. Unset: 10 s. */
  duplicateWindowMs?: number
  /**
   * Monthly pacing (needs `globalMonthly`): each UTC day's whole-service cap is at most
   * (monthly cap − spent before today) ÷ days left in the month × this factor, and never above
   * `globalDailyNeurons`. So a busy start can't spend the month before its last days. Unset: off.
   * The day's cap is fixed for the whole day (it only uses what was spent before today).
   */
  monthlyPacing?: number
  /**
   * A verified Pro account's own allowance, in place of installDailyNeurons / installMonthly.
   * Unset: Pro gets the same as Free (no allowance is raised without a cost analysis).
   * The network, global and monthly caps apply to Pro exactly as to everyone.
   */
  pro?: { daily: number; monthly?: number }
}

export interface Identity {
  /** The app's random installation ID, or `acct:<user id>` for a verified account (its allowance is per account). */
  install: string
  /** Set by the server from the verified account only, never from the request. Absent: anonymous (Free). */
  plan?: 'free' | 'pro'
  /** The client's network (IP address, or IPv6 /64). */
  network: string
}

export interface Quota {
  installUsed: number
  /** Today's allowance for this installation (reduced while budget protection is on). */
  installLimit: number
  networkUsed: number
  networkLimit: number
  globalUsed: number
  globalLimit: number
  approxAnswersLeft: number
  resetAt: string
  /** This calendar month, when a monthly allowance is set. */
  installMonthUsed?: number
  installMonthLimit?: number
  /** True while budget protection has reduced the daily allowances. */
  reduced?: boolean
  /** Today's whole-service cap is lower than configured, to keep budget for the rest of the month. */
  paced?: boolean
  /** Signed-in requests: the account's plan; install* figures are then the account's. */
  plan?: 'free' | 'pro'
}

export type RefusalCode =
  | 'install_quota'
  | 'install_monthly_quota'
  | 'network_quota'
  | 'global_quota'
  | 'global_monthly_quota'
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'duplicate'
  | 'busy'
  | 'capacity'
  | 'paused'
  | 'too_large'
export type ReserveResult = { ok: true; reservationId: string; quota: Quota } | { ok: false; code: RefusalCode; retryAfter?: number; quota?: Quota }

interface Day {
  day: string
  salt: string
  global: number
  requests: number
  /** Older servers latched this for the whole day; now ignored (see upstreamExhaustedAt). */
  upstreamExhausted?: boolean
  /** When Cloudflare last reported the free allocation used up. Answers stop for UPSTREAM_RETRY_MS, then are tried again. */
  upstreamExhaustedAt?: number
  /** Answers whose real cost exceeded their reservation today, and by how much in total. */
  overshoots?: number
  overshootTotal?: number
  /** Today's tokens, as the provider reported them (estimated when it didn't). */
  inputTokens?: number
  outputTokens?: number
  /** Today's counts per model (record()). Counts only: no content, no identity. */
  models?: Record<string, ModelStats>
}

/** Tokens one answer used, as the provider reported them (or estimated, flagged). */
export interface TokenCount {
  input: number
  output: number
  /** Input tokens read from the provider's prompt cache. */
  cached?: number
  /** True when the provider gave no usage and the server estimated. */
  estimated?: boolean
}

/** One model's day: requests, what kind they were, cost, tokens and failures. No content, no identity. */
export interface ModelStats {
  requests: number
  /** Requests carrying a handwriting image somewhere in the conversation. */
  image: number
  text: number
  /** Which side of the routing rule sent it here: 'main' = main model, 'text' = text model (Workers AI only). */
  routes: Record<string, number>
  tasks: Record<string, number>
  /** Cost in the ledger's unit (Neurons, or µ$ with an external provider); the name is kept for older readers. */
  neurons: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  /** Answers whose usage the provider didn't report (the server estimated). */
  estimated?: number
  /** What the provider itself reported charging, in the ledger's unit, for answers where it reported a cost. */
  providerReported?: number
  /** How many answers carried a provider-reported cost. */
  providerReportedAnswers?: number
  errors: number
  errorKinds: Record<string, number>
}

/** What the handler reports after each model call. */
export interface UsageRecord {
  model: string
  route: 'main' | 'text'
  task: string
  image: boolean
  /** Cost in the ledger's unit. */
  neurons: number
  tokens?: TokenCount
  /** The provider's own reported charge for this call (ledger unit), when given. */
  providerReported?: number
  /** The upstream error kind, when the call failed. */
  error?: string
}

const emptyStats = (): ModelStats => ({ requests: 0, image: 0, text: 0, routes: {}, tasks: {}, neurons: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimated: 0, errors: 0, errorKinds: {} })
const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1
}

/**
 * How long answers stop after Cloudflare reports the free allocation used up. A
 * real exhaustion just repeats (Workers Free errors instead of billing, so a retry
 * costs nothing); a transient or misread error no longer closes the whole day.
 */
export const UPSTREAM_RETRY_MS = 15 * 60_000

interface Counter {
  neurons: number
  requests: number
  /** Tokens (provider-reported when available). Absent on counts written by older versions. */
  inputTokens?: number
  outputTokens?: number
}

/** The whole service's calendar month (UTC), and the salt for per-installation monthly counts. */
interface Month {
  month: string
  salt: string
  used: number
  requests: number
  inputTokens?: number
  outputTokens?: number
}

interface Allowance {
  daily: number
  monthly?: number
  plan?: 'free' | 'pro'
  /**
   * A paid account (with its own allowance configured) is not counted in its network's shared daily
   * pool: that pool exists because anonymous IDs and free accounts cost nothing to make, and a Pro
   * student at a school would otherwise run into everyone else's use (and use up theirs). Its
   * "network" is then the account itself. Global caps, and its own daily and monthly caps, still bound it.
   */
  ownNetwork?: boolean
}

interface Keys {
  install: string
  network: string
  installMonth: string
}

interface Reservation {
  id: string
  install: string
  network: string
  /** The installation's monthly key (absent on reservations made by older versions). */
  installMonth?: string
  neurons: number
  day: string
  at: number
}

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)
export const utcMonth = (t: number): string => new Date(t).toISOString().slice(0, 7)
export const nextUtcMonth = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
export const nextUtcMidnight = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The network part of an IP address: IPv4 as is, IPv6 by its /64 prefix. */
export function networkOf(ip: string): string {
  const addr = ip.trim().toLowerCase()
  if (!addr.includes(':')) return addr || 'unknown'
  // Expand "::" and keep the first four 16-bit groups.
  const [head = '', tail = ''] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/** One hour, the width of a rolling-usage bucket. */
const HOUR_MS = 3_600_000
/**
 * How long a bucket's Neurons count against the whole-service cap: 24 hours from the END of
 * its hour, so use anywhere in the hour is still counted a full 24 hours later (slightly
 * stricter than Cloudflare's own window).
 */
export const ROLLING_WINDOW_MS = 25 * HOUR_MS

export interface SettleOptions {
  upstreamExhausted?: boolean
  failedBeforeModel?: boolean
  /** A complete answer was delivered: an identical request soon after is a duplicate. */
  answered?: boolean
  /** The answer's tokens, for usage tracking (cost is what the caps count). */
  tokens?: TokenCount
  /** How far the real cost went above the reservation (0 normally); reported in the summary. */
  overshoot?: number
}

export class Ledger {
  /** Whole-service Neurons per hour (key: the hour's start in ms), for the rolling cap. */
  private hourState: Record<string, number> | null = null
  private dayState: Day | null = null
  private monthState: Month | null = null
  private unitChecked: string | null = null
  /** The last request per installation (memory only): its fingerprint, and when it was answered. */
  private readonly lastRequest = new Map<string, { fp: string; reservationId: string; answeredAt?: number }>()
  private reservations: Reservation[] | null = null
  private paused: boolean | null = null
  private readonly recent = new Map<string, number[]>()
  private lock: Promise<unknown> = Promise.resolve()
  private calls = 0

  constructor(
    private readonly storage: LedgerStorage,
    private limits: LedgerLimits,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => crypto.randomUUID()
  ) {}

  /**
   * Applies the limits of the Worker version that is calling. A Durable Object
   * can keep running across a deploy, so the Worker passes its limits along
   * rather than the object relying on the ones it started with.
   */
  useLimits(limits: LedgerLimits | undefined): void {
    if (limits) this.limits = limits
  }

  /** Runs `fn` after every earlier ledger operation has finished: one at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------- state

  /**
   * After a provider switch or rollback the cost unit changes (Neurons ↔ µ$). Old
   * counts in the other unit would be misread (a dollar figure as Neurons would close
   * the day), so the day's and the rolling counts restart. Monthly dollar totals are
   * kept per unit, so a rollback and return within a month keeps the month's spend.
   */
  private async ensureUnit(): Promise<void> {
    const unit = this.limits.unit ?? 'neurons'
    if (this.unitChecked === unit) return
    const stored = (await this.storage.get<string>('unit')) ?? 'neurons'
    if (stored !== unit) {
      for (const prefix of ['i:', 'n:', 'mi:']) for (const key of await this.storage.list(prefix)) await this.storage.delete(key)
      for (const key of ['hours', 'day', 'reservations']) await this.storage.delete(key)
      this.hourState = null
      this.dayState = null
      this.reservations = null
      this.monthState = null
      this.recent.clear()
      this.lastRequest.clear()
      await this.storage.put('unit', unit)
    }
    this.unitChecked = unit
  }

  private monthKey(): string {
    return `month:${this.limits.unit ?? 'neurons'}`
  }

  /** This calendar month's whole-service total; at a new month, last month's per-installation counts and salt are deleted. */
  private async thisMonth(): Promise<Month> {
    const month = utcMonth(this.now())
    if (this.monthState && this.monthState.month !== month) this.monthState = null
    this.monthState ??= (await this.storage.get<Month>(this.monthKey())) ?? null
    if (!this.monthState || this.monthState.month !== month) {
      for (const key of await this.storage.list('mi:')) await this.storage.delete(key)
      this.monthState = { month, salt: randomHex(32), used: 0, requests: 0 }
      await this.storage.put(this.monthKey(), this.monthState)
    }
    return this.monthState
  }

  /** Today's totals; at a new UTC day, yesterday's per-identity counts and salt are deleted. */
  private async today(): Promise<Day> {
    await this.ensureUnit()
    const day = utcDay(this.now())
    this.dayState ??= (await this.storage.get<Day>('day')) ?? null
    if (!this.dayState || this.dayState.day !== day) {
      for (const prefix of ['i:', 'n:']) for (const key of await this.storage.list(prefix)) await this.storage.delete(key)
      // Leftovers from the access-code version of this server.
      for (const key of ['usage', 'testers']) await this.storage.delete(key)
      // Keep the finished day's per-model counts (counts only) so the operator can read a whole day.
      if (this.dayState?.models) await this.storage.put('modelsPrev', { day: this.dayState.day, models: this.dayState.models })
      this.dayState = { day, salt: randomHex(32), global: 0, requests: 0, inputTokens: 0, outputTokens: 0 }
      await this.storage.put('day', this.dayState)
      this.recent.clear()
    }
    return this.dayState
  }

  private async openReservations(): Promise<Reservation[]> {
    if (!this.reservations) {
      const saved = (await this.storage.get<Reservation[]>('reservations')) ?? []
      this.reservations = saved.filter((r) => r && typeof r.install === 'string' && typeof r.network === 'string')
    }
    return this.reservations
  }

  private async saveReservations(): Promise<void> {
    await this.storage.put('reservations', this.reservations ?? [])
  }

  async isPaused(): Promise<boolean> {
    this.paused ??= (await this.storage.get<boolean>('paused')) ?? false
    return this.paused
  }

  setPaused(paused: boolean): Promise<void> {
    return this.exclusive(async () => {
      this.paused = paused
      await this.storage.put('paused', paused)
    })
  }

  /** The daily and monthly allowance of whoever is asking: a Pro account's, or everyone else's. */
  private allowance(id: Identity): Allowance {
    const pro = id.plan === 'pro' ? this.limits.pro : undefined
    return pro ? { daily: pro.daily, monthly: pro.monthly ?? this.limits.installMonthly, plan: id.plan, ownNetwork: true } : { daily: this.limits.installDailyNeurons, monthly: this.limits.installMonthly, plan: id.plan }
  }

  private async keys(id: Identity, day: Day): Promise<Keys> {
    const month = await this.thisMonth()
    const network = this.allowance(id).ownNetwork ? `pro-network|${id.install}` : `network|${networkOf(id.network)}`
    return {
      install: `i:${(await sha256Hex(`${day.salt}|install|${id.install}`)).slice(0, 32)}`,
      network: `n:${(await sha256Hex(`${day.salt}|${network}`)).slice(0, 32)}`,
      // A separate salt that changes every month: the monthly count can't be joined to the daily ones.
      installMonth: `mi:${(await sha256Hex(`${month.salt}|install|${id.install}`)).slice(0, 32)}`
    }
  }

  /** Adds a settled cost to this month's totals: the service's, and the installation's. */
  private async chargeMonth(installMonth: string | undefined, cost: number, at: number, tokens?: TokenCount): Promise<void> {
    if (utcMonth(at) !== utcMonth(this.now())) return
    const m = await this.thisMonth()
    m.used += cost
    m.requests++
    if (tokens) {
      m.inputTokens = (m.inputTokens ?? 0) + tokens.input
      m.outputTokens = (m.outputTokens ?? 0) + tokens.output
    }
    await this.storage.put(this.monthKey(), m)
    if (installMonth) await this.charge(installMonth, cost, tokens)
  }

  private async counter(key: string): Promise<Counter> {
    return (await this.storage.get<Counter>(key)) ?? { neurons: 0, requests: 0 }
  }

  private async charge(key: string, neurons: number, tokens?: TokenCount): Promise<void> {
    const c = await this.counter(key)
    await this.storage.put(key, {
      neurons: c.neurons + neurons,
      requests: c.requests + 1,
      inputTokens: (c.inputTokens ?? 0) + (tokens?.input ?? 0),
      outputTokens: (c.outputTokens ?? 0) + (tokens?.output ?? 0)
    })
  }

  /** The whole service's Neurons per hour still inside the rolling window (older hours dropped). */
  private async hours(): Promise<Record<string, number>> {
    this.hourState ??= (await this.storage.get<Record<string, number>>('hours')) ?? {}
    const now = this.now()
    for (const k of Object.keys(this.hourState)) if (Number(k) + ROLLING_WINDOW_MS <= now) delete this.hourState[k]
    return this.hourState
  }

  private async chargeGlobal(neurons: number, at: number): Promise<void> {
    if (!(neurons > 0)) return
    const h = await this.hours()
    const k = String(Math.floor(at / HOUR_MS) * HOUR_MS)
    h[k] = (h[k] ?? 0) + neurons
    await this.storage.put('hours', h)
  }

  private rollingUsed(h: Record<string, number>): number {
    return Object.values(h).reduce((n, v) => n + v, 0)
  }

  /** Seconds until `need` more Neurons fit under the whole-service cap, as old hours leave the window. */
  private secondsUntilRoom(h: Record<string, number>, used: number, need: number, cap: number = this.limits.globalDailyNeurons): number {
    const now = this.now()
    let left = used
    const hoursHeld = Object.keys(h).map(Number).sort((a, b) => a - b)
    for (const k of hoursHeld) {
      left -= h[String(k)]!
      if (left + need <= cap) return Math.max(60, Math.ceil((k + ROLLING_WINDOW_MS - now) / 1000))
    }
    // Answers in progress are in the way: soon. Otherwise the request is bigger than any room left once
    // the window is empty (only with tiny caps): the latest held hour's exit, the furthest honest estimate.
    const last = hoursHeld.at(-1)
    return last === undefined ? 60 : Math.max(60, Math.ceil((last + ROLLING_WINDOW_MS - now) / 1000))
  }

  /** Releases reservations that were never settled; they stay charged. */
  private async expire(day: Day): Promise<void> {
    const open = await this.openReservations()
    const now = this.now()
    const stale = open.filter((r) => now - r.at >= this.limits.reservationTtlMs || r.day !== day.day)
    if (!stale.length) return
    for (const r of stale) {
      // Whatever day it started on, the model may have worked: it counts against the rolling cap.
      await this.chargeGlobal(r.neurons, r.at)
      await this.chargeMonth(r.installMonth, r.neurons, r.at)
      if (r.day !== day.day) continue
      await this.charge(r.install, r.neurons)
      await this.charge(r.network, r.neurons)
      day.global += r.neurons
      day.requests++
    }
    this.reservations = open.filter((r) => !stale.includes(r))
    await this.saveReservations()
    await this.storage.put('day', day)
  }

  private upstreamBlocked(day: Day): boolean {
    return day.upstreamExhaustedAt !== undefined && this.now() - day.upstreamExhaustedAt < UPSTREAM_RETRY_MS
  }

  /** Whole seconds until answers are tried again after an upstream stop (at least 1). */
  private upstreamRetryIn(day: Day): number {
    return Math.max(1, Math.ceil(((day.upstreamExhaustedAt ?? 0) + UPSTREAM_RETRY_MS - this.now()) / 1000))
  }

  private finite(v: number | undefined): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0
  }

  /** Everything the limits are checked against, in the ledger's unit (unrounded). */
  /**
   * Today's whole-service cap: the configured daily cap, or less when monthly pacing says the rest of
   * the month needs it. `paced` says which, so the app can tell people why answers ran out.
   */
  private async dailyCap(): Promise<{ cap: number; paced: boolean }> {
    const base = this.limits.globalDailyNeurons
    const pace = this.limits.monthlyPacing
    if (!this.finite(this.limits.globalMonthly) || !this.finite(pace) || pace <= 0) return { cap: base, paced: false }
    const now = this.now()
    const day = await this.today()
    const m = await this.thisMonth()
    // Spent this month before today's UTC day began (today's own settled spend is in both totals).
    const before = Math.max(0, m.used - day.global)
    const dayStart = Date.parse(day.day + 'T00:00:00Z')
    const daysLeft = Math.max(1, Math.round((nextUtcMonth(now) - dayStart) / 86_400_000))
    const share = Math.floor((Math.max(0, this.limits.globalMonthly! - before) / daysLeft) * pace)
    return share < base ? { cap: share, paced: true } : { cap: base, paced: false }
  }

  private async usageFor(k: Keys, a: Allowance): Promise<{ install: number; network: number; global: number; month: number; installMonth: number; installLimit: number; networkLimit: number; reduced: boolean; globalCap: number; paced: boolean }> {
    const open = await this.openReservations()
    const reserved = (pred: (r: Reservation) => boolean): number => open.filter(pred).reduce((n, r) => n + r.neurons, 0)
    const install = (await this.counter(k.install)).neurons + reserved((r) => r.install === k.install)
    const network = (await this.counter(k.network)).neurons + reserved((r) => r.network === k.network)
    // The whole service: the last 24 hours (rolling), not only today, plus answers in progress.
    const global = this.rollingUsed(await this.hours()) + reserved(() => true)
    const month = (await this.thisMonth()).used + reserved(() => true)
    const installMonth = (await this.counter(k.installMonth)).neurons + reserved((r) => r.installMonth === k.installMonth)
    // Budget protection: near the daily or monthly cap, everyone's daily share shrinks.
    const soft = this.limits.softFraction
    const factor = this.limits.softFactor ?? 1
    const { cap, paced } = await this.dailyCap()
    const near = this.finite(soft) && soft < 1 && factor < 1 && (global >= soft * cap || (this.finite(this.limits.globalMonthly) && month >= soft * this.limits.globalMonthly))
    const scale = near ? Math.max(0, factor) : 1
    return { install, network, global, month, installMonth, installLimit: a.daily * scale, networkLimit: (a.ownNetwork ? a.daily : this.limits.networkDailyNeurons) * scale, reduced: near, globalCap: cap, paced }
  }

  private async quotaFor(k: Keys, a: Allowance): Promise<Quota> {
    const u = await this.usageFor(k, a)
    // Inkling's own daily figures, also while the provider is briefly unavailable: that pause is reported
    // as its own refusal (upstream_unavailable), never as today's allowance being used up.
    const globalLimit = u.globalCap
    const rooms = [u.installLimit - u.install, u.networkLimit - u.network, globalLimit - u.global]
    if (this.finite(this.limits.globalMonthly)) rooms.push(this.limits.globalMonthly - u.month)
    if (this.finite(a.monthly)) rooms.push(a.monthly - u.installMonth)
    const left = Math.max(0, Math.min(...rooms))
    return {
      installUsed: Math.round(u.install),
      installLimit: Math.round(u.installLimit),
      networkUsed: Math.round(u.network),
      networkLimit: Math.round(u.networkLimit),
      globalUsed: Math.round(u.global),
      globalLimit,
      approxAnswersLeft: Math.floor(left / Math.max(1, this.limits.typicalNeuronsPerAnswer)),
      resetAt: new Date(nextUtcMidnight(this.now())).toISOString(),
      ...(this.finite(a.monthly) ? { installMonthUsed: Math.round(u.installMonth), installMonthLimit: a.monthly } : {}),
      ...(u.reduced ? { reduced: true } : {}),
      ...(u.paced ? { paced: true } : {}),
      ...(a.plan ? { plan: a.plan } : {})
    }
  }

  // ------------------------------------------------------------- public

  quota(id: Identity): Promise<Quota> {
    return this.exclusive(async () => {
      const day = await this.today()
      await this.expire(day)
      return this.quotaFor(await this.keys(id, day), this.allowance(id))
    })
  }

  /**
   * Reserves `worst` Neurons (the request's worst case) against the global
   * cap; the installation and network need room for `expected`.
   */
  reserve(id: Identity, worst: number, expected: number = worst, fingerprint?: string): Promise<ReserveResult> {
    return this.exclusive(async () => {
      if (await this.isPaused()) return { ok: false, code: 'paused' }
      const now = this.now()
      const day = await this.today()
      await this.expire(day)
      const k = await this.keys(id, day)
      const open = await this.openReservations()
      const resetIn = Math.ceil((nextUtcMidnight(now) - now) / 1000)

      // Answers in progress: one per installation, a few per network, a bounded number overall.
      if (open.filter((r) => r.install === k.install).length >= this.limits.installConcurrent) return { ok: false, code: 'busy', retryAfter: 5 }
      if (open.filter((r) => r.network === k.network).length >= this.limits.networkConcurrent) return { ok: false, code: 'busy', retryAfter: 10 }
      if (open.length >= this.limits.globalConcurrent) return { ok: false, code: 'capacity', retryAfter: 15 }

      // The same request again, already answered moments ago (a double click, a re-render, a client retrying a success).
      const last = this.lastRequest.get(k.install)
      const dupWindow = this.limits.duplicateWindowMs ?? 10_000
      if (fingerprint && last && last.fp === fingerprint && last.answeredAt !== undefined && now - last.answeredAt < dupWindow) {
        return { ok: false, code: 'duplicate', retryAfter: Math.max(1, Math.ceil((last.answeredAt + dupWindow - now) / 1000)) }
      }

      // Requests per minute, per installation and per network (kept in memory only).
      if (++this.calls % 500 === 0) for (const [key, ts] of this.recent) if (!ts.some((t) => now - t < 60_000)) this.recent.delete(key)
      const window = (key: string): number[] => {
        const ts = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000)
        this.recent.set(key, ts)
        return ts
      }
      const wi = window(k.install)
      const wn = window(k.network)
      const wait = (ts: number[]): number => Math.max(1, Math.ceil((60_000 - (now - ts[0]!)) / 1000))
      if (wi.length >= this.limits.installPerMinute) return { ok: false, code: 'rate_limited', retryAfter: wait(wi) }
      if (wn.length >= this.limits.networkPerMinute) return { ok: false, code: 'rate_limited', retryAfter: wait(wn) }

      const a = this.allowance(id)
      const q = await this.quotaFor(k, a)
      const u = await this.usageFor(k, a)
      // The provider refused for everyone a moment ago (free allocation or credit used up): stop briefly, then try again.
      if (this.upstreamBlocked(day)) return { ok: false, code: 'upstream_unavailable', retryAfter: this.upstreamRetryIn(day), quota: q }
      // Hard spending caps: the request's worst case must fit, counting every answer in progress.
      if (u.global + worst > u.globalCap) {
        // Paced: today's share is fixed until the next UTC day gives a new one.
        const retryAfter = u.paced ? resetIn : this.secondsUntilRoom(await this.hours(), u.global, worst, u.globalCap)
        return { ok: false, code: 'global_quota', retryAfter, quota: q }
      }
      if (this.finite(this.limits.globalMonthly) && u.month + worst > this.limits.globalMonthly) return { ok: false, code: 'global_monthly_quota', retryAfter: Math.ceil((nextUtcMonth(now) - now) / 1000), quota: q }
      if (expected > a.daily) return { ok: false, code: 'too_large', quota: q }
      if (u.install + expected > u.installLimit) return { ok: false, code: 'install_quota', retryAfter: resetIn, quota: q }
      if (this.finite(a.monthly) && u.installMonth + expected > a.monthly) return { ok: false, code: 'install_monthly_quota', retryAfter: Math.ceil((nextUtcMonth(now) - now) / 1000), quota: q }
      if (u.network + expected > u.networkLimit) return { ok: false, code: 'network_quota', retryAfter: resetIn, quota: q }

      const r: Reservation = { id: this.randomId(), install: k.install, network: k.network, installMonth: k.installMonth, neurons: worst, day: day.day, at: now }
      open.push(r)
      await this.saveReservations()
      wi.push(now)
      wn.push(now)
      if (fingerprint) this.lastRequest.set(k.install, { fp: fingerprint, reservationId: r.id })
      if (this.lastRequest.size > 5000) this.lastRequest.delete(this.lastRequest.keys().next().value!)
      return { ok: true, reservationId: r.id, quota: await this.quotaFor(k, a) }
    })
  }

  /**
   * Replaces a reservation with the real cost. `neurons` undefined keeps the
   * reserved amount charged (the real usage isn't known).
   */
  settle(reservationId: string, neurons: number | undefined, opts: SettleOptions = {}): Promise<void> {
    return this.exclusive(async () => {
      const day = await this.today()
      if (opts.answered) {
        for (const v of this.lastRequest.values()) if (v.reservationId === reservationId) v.answeredAt = this.now()
      }
      const open = await this.openReservations()
      // Missing means it already expired, and was charged in full then.
      const r = open.find((x) => x.id === reservationId)
      if (opts.upstreamExhausted) day.upstreamExhaustedAt = this.now()
      if (opts.overshoot && opts.overshoot > 0) {
        day.overshoots = (day.overshoots ?? 0) + 1
        day.overshootTotal = (day.overshootTotal ?? 0) + opts.overshoot
      }
      if (r) {
        this.reservations = open.filter((x) => x !== r)
        await this.saveReservations()
        // A request the model never started costs nothing.
        const cost = opts.failedBeforeModel ? 0 : Math.max(0, neurons ?? r.neurons)
        await this.chargeGlobal(cost, r.at)
        const tokens = opts.failedBeforeModel ? undefined : opts.tokens
        await this.chargeMonth(r.installMonth, cost, r.at, tokens)
        if (r.day === day.day) {
          await this.charge(r.install, cost, tokens)
          await this.charge(r.network, cost, tokens)
          day.global += cost
          day.requests++
          if (tokens) {
            day.inputTokens = (day.inputTokens ?? 0) + tokens.input
            day.outputTokens = (day.outputTokens ?? 0) + tokens.output
          }
        }
      }
      await this.storage.put('day', day)
    })
  }

  /** Adds one model call to today's per-model counts. */
  record(r: UsageRecord): Promise<void> {
    return this.exclusive(async () => {
      const day = await this.today()
      day.models ??= {}
      const m = (day.models[r.model] ??= emptyStats())
      m.requests++
      if (r.image) m.image++
      else m.text++
      bump(m.routes, r.route)
      bump(m.tasks, r.task)
      m.neurons += Math.max(0, r.neurons)
      if (r.tokens) {
        m.inputTokens = (m.inputTokens ?? 0) + r.tokens.input
        m.outputTokens = (m.outputTokens ?? 0) + r.tokens.output
        m.cachedTokens = (m.cachedTokens ?? 0) + (r.tokens.cached ?? 0)
        if (r.tokens.estimated) m.estimated = (m.estimated ?? 0) + 1
      }
      if (r.providerReported !== undefined) {
        m.providerReported = (m.providerReported ?? 0) + r.providerReported
        m.providerReportedAnswers = (m.providerReportedAnswers ?? 0) + 1
      }
      if (r.error) {
        m.errors++
        bump(m.errorKinds, r.error)
      }
      await this.storage.put('day', day)
    })
  }

  /** Per-model counts for today and the previous day, with cost and tokens per answer and the capacity they imply. */
  private async modelReport(day: Day): Promise<{
    today: Record<string, ModelStats & { neuronsPerAnswer: number | null; inputTokensPerAnswer: number | null; outputTokensPerAnswer: number | null }>
    previous: { day: string; models: Record<string, ModelStats> } | null
    estimatedCapacity: number | null
  }> {
    const models = day.models ?? {}
    const today: Record<string, ModelStats & { neuronsPerAnswer: number | null; inputTokensPerAnswer: number | null; outputTokensPerAnswer: number | null }> = {}
    let n = 0
    let answered = 0
    const per = (v: number | undefined, ok: number): number | null => (ok > 0 && v !== undefined ? Math.round(v / ok) : null)
    for (const [k, v] of Object.entries(models)) {
      const ok = v.requests - v.errors
      today[k] = {
        ...v,
        neurons: Math.round(v.neurons * 10) / 10,
        neuronsPerAnswer: ok > 0 ? Math.round((v.neurons / ok) * 10) / 10 : null,
        inputTokensPerAnswer: per(v.inputTokens, ok),
        outputTokensPerAnswer: per(v.outputTokens, ok)
      }
      n += v.neurons
      answered += ok
    }
    const previous = (await this.storage.get<{ day: string; models: Record<string, ModelStats> }>('modelsPrev')) ?? null
    // Today's mix at today's cost per answer: roughly how many answers the daily cap allows.
    return { today, previous, estimatedCapacity: answered > 0 && n > 0 ? Math.floor(this.limits.globalDailyNeurons / (n / answered)) : null }
  }

  /** Today's totals for the operator; no identities. */
  summary(): Promise<{
    day: string
    unit: string
    globalUsed: number
    globalLimit: number
    todayUsed: number
    answers: number
    month: string
    monthUsed: number
    monthLimit: number | null
    monthAnswers: number
    reduced: boolean
    paced: boolean
    dailyConfigured: number
    installations: number
    networks: number
    answering: number
    upstreamExhausted: boolean
    paused: boolean
    limits: LedgerLimits
    tokens: { today: { input: number; output: number }; month: { input: number; output: number } }
    /** Answers whose real cost went above their reservation today (should stay 0). */
    overshoot: { count: number; total: number }
    models: Awaited<ReturnType<Ledger['modelReport']>>
  }> {
    return this.exclusive(async () => {
      const day = await this.today()
      await this.expire(day)
      const open = await this.openReservations()
      const month = await this.thisMonth()
      const inProgress = open.reduce((n, r) => n + r.neurons, 0)
      const rolling = this.rollingUsed(await this.hours()) + inProgress
      const monthUsed = month.used + inProgress
      const soft = this.limits.softFraction
      const { cap, paced } = await this.dailyCap()
      const reduced =
        this.finite(soft) && soft < 1 && (this.limits.softFactor ?? 1) < 1 && (rolling >= soft * cap || (this.finite(this.limits.globalMonthly) && monthUsed >= soft * this.limits.globalMonthly))
      return {
        day: day.day,
        unit: this.limits.unit ?? 'neurons',
        month: month.month,
        monthUsed: Math.round(monthUsed),
        monthLimit: this.finite(this.limits.globalMonthly) ? this.limits.globalMonthly : null,
        monthAnswers: month.requests,
        reduced,
        // The capped figure: the last 24 hours plus answers in progress.
        globalUsed: Math.round(this.rollingUsed(await this.hours()) + open.reduce((n, r) => n + r.neurons, 0)),
        globalLimit: cap,
        // True when today's cap is below the configured daily cap because the month's budget needs pacing.
        paced,
        dailyConfigured: this.limits.globalDailyNeurons,
        todayUsed: Math.round(day.global),
        answers: day.requests,
        installations: (await this.storage.list('i:')).length,
        networks: (await this.storage.list('n:')).length,
        answering: open.length,
        upstreamExhausted: this.upstreamBlocked(day),
        paused: await this.isPaused(),
        limits: this.limits,
        tokens: { today: { input: day.inputTokens ?? 0, output: day.outputTokens ?? 0 }, month: { input: month.inputTokens ?? 0, output: month.outputTokens ?? 0 } },
        overshoot: { count: day.overshoots ?? 0, total: Math.round(day.overshootTotal ?? 0) },
        models: await this.modelReport(day)
      }
    })
  }
}

/** Compares two hex digests without leaking where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
