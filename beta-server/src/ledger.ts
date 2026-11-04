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
   * Requests the whole service may send the provider per UTC day and per minute, every
   * attempt counted: a free endpoint's account-wide quota (OpenRouter: 1,000 a day with
   * $10 of credits bought, 20 a minute). Unset: no request quota.
   */
  globalRequestsPerDay?: number
  globalRequestsPerMinute?: number
  /**
   * Tokens (input + output) the whole service may send the provider over any 24 hours and any
   * 60 seconds: a free endpoint's account-wide token quota (Groq's free plan: 200,000 a day and
   * 8,000 a minute). Each request's WORST case (estimated input with margin, plus the full output
   * cap) is held while it runs and replaced by the provider's reported count when it ends. When
   * set, the daily request quota is ALSO checked over any 24 hours (not only the UTC day), so the
   * limit holds whichever window the provider uses. Unset: no token quota.
   */
  globalTokensPerDay?: number
  globalTokensPerMinute?: number
}

export interface Identity {
  /** The app's random installation ID. */
  install: string
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
}

export type RefusalCode =
  | 'install_quota'
  | 'install_monthly_quota'
  | 'network_quota'
  | 'global_quota'
  | 'global_monthly_quota'
  | 'free_daily_quota'
  | 'free_token_quota'
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
  /** The provider said its quota is used up until this time (a free endpoint's daily quota). */
  upstreamBlockedUntil?: number
  /** Requests sent to the provider today (UTC), every attempt counted. */
  upstreamRequests?: number
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
}

/** The whole service's calendar month (UTC), and the salt for per-installation monthly counts. */
interface Month {
  month: string
  salt: string
  used: number
  requests: number
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
  /** Provider tokens held for this answer (its worst case), when a token quota is set. */
  tokens?: number
}

/** Provider requests and tokens per hour (key: the hour's start in ms), for the rolling 24-hour quotas. */
type ProviderHours = Record<string, { req: number; tok: number }>
/** One request sent to the provider in the last minute, with its tokens (held, then reported). */
interface MinuteEntry {
  t: number
  tok: number
  id?: string
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
  /** The provider's quota is used up until this time (epoch ms): stop everyone until then. */
  upstreamBlockedUntil?: number
  /** Attempts beyond the first that reached the provider (retries), for the request quota. */
  extraAttempts?: number
  /** Tokens the provider reported for the answer (input + output); undefined keeps the held worst case. */
  tokens?: number
  failedBeforeModel?: boolean
  /** A complete answer was delivered: an identical request soon after is a duplicate. */
  answered?: boolean
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
  /** Requests sent to the provider in the last minute, whole service (memory only). */
  private globalMinute: number[] = []
  private providerHourState: ProviderHours | null = null
  private minuteState: MinuteEntry[] | null = null
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
      this.dayState = { day, salt: randomHex(32), global: 0, requests: 0 }
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

  private async keys(id: Identity, day: Day): Promise<Keys> {
    const month = await this.thisMonth()
    return {
      install: `i:${(await sha256Hex(`${day.salt}|install|${id.install}`)).slice(0, 32)}`,
      network: `n:${(await sha256Hex(`${day.salt}|network|${networkOf(id.network)}`)).slice(0, 32)}`,
      // A separate salt that changes every month: the monthly count can't be joined to the daily ones.
      installMonth: `mi:${(await sha256Hex(`${month.salt}|install|${id.install}`)).slice(0, 32)}`
    }
  }

  /** Adds a settled cost to this month's totals: the service's, and the installation's. */
  private async chargeMonth(installMonth: string | undefined, cost: number, at: number): Promise<void> {
    if (utcMonth(at) !== utcMonth(this.now())) return
    const m = await this.thisMonth()
    m.used += cost
    m.requests++
    await this.storage.put(this.monthKey(), m)
    if (installMonth) await this.charge(installMonth, cost)
  }

  private async counter(key: string): Promise<Counter> {
    return (await this.storage.get<Counter>(key)) ?? { neurons: 0, requests: 0 }
  }

  private async charge(key: string, neurons: number): Promise<void> {
    const c = await this.counter(key)
    await this.storage.put(key, { neurons: c.neurons + neurons, requests: c.requests + 1 })
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
  private secondsUntilRoom(h: Record<string, number>, used: number, need: number): number {
    const now = this.now()
    let left = used
    const hoursHeld = Object.keys(h).map(Number).sort((a, b) => a - b)
    for (const k of hoursHeld) {
      left -= h[String(k)]!
      if (left + need <= this.limits.globalDailyNeurons) return Math.max(60, Math.ceil((k + ROLLING_WINDOW_MS - now) / 1000))
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
      if (r.tokens !== undefined) await this.addProviderUsage(r.at, 1, r.tokens)
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

  // ------------------------------------------------ provider token quota

  private tokenQuota(): boolean {
    return this.finite(this.limits.globalTokensPerDay) || this.finite(this.limits.globalTokensPerMinute)
  }

  /** Provider requests and tokens per hour still inside the rolling window (persisted: survives eviction). */
  private async providerHours(): Promise<ProviderHours> {
    this.providerHourState ??= (await this.storage.get<ProviderHours>('ptok')) ?? {}
    const now = this.now()
    for (const k of Object.keys(this.providerHourState)) if (Number(k) + ROLLING_WINDOW_MS <= now) delete this.providerHourState[k]
    return this.providerHourState
  }

  /** Requests sent in the last 60 seconds with their tokens (persisted, so a restarted object still knows). */
  private async minute(): Promise<MinuteEntry[]> {
    this.minuteState ??= (await this.storage.get<MinuteEntry[]>('pmin')) ?? []
    const now = this.now()
    this.minuteState = this.minuteState.filter((e) => now - e.t < 60_000)
    return this.minuteState
  }

  private async addProviderUsage(at: number, req: number, tok: number): Promise<void> {
    if (!(req > 0) && !(tok > 0)) return
    const h = await this.providerHours()
    const k = String(Math.floor(at / HOUR_MS) * HOUR_MS)
    const b = h[k] ?? { req: 0, tok: 0 }
    h[k] = { req: b.req + Math.max(0, req), tok: b.tok + Math.max(0, tok) }
    await this.storage.put('ptok', h)
  }

  /** Provider tokens and requests over the rolling day, counting answers in progress at their worst case. */
  private async providerDay(): Promise<{ req: number; tok: number }> {
    const h = await this.providerHours()
    const open = await this.openReservations()
    let req = 0
    let tok = 0
    for (const b of Object.values(h)) {
      req += b.req
      tok += b.tok
    }
    // A reservation's request is counted at settle (into its hour); until then, here.
    for (const r of open) {
      if (r.tokens === undefined) continue
      req += 1
      tok += r.tokens
    }
    return { req, tok }
  }

  /** Seconds until `need` more tokens fit under the rolling daily token quota, as old hours leave the window. */
  private async secondsUntilTokens(used: number, need: number): Promise<number> {
    const h = await this.providerHours()
    const now = this.now()
    let left = used
    const held = Object.keys(h).map(Number).sort((a, b) => a - b)
    for (const k of held) {
      left -= h[String(k)]!.tok
      if (left + need <= this.limits.globalTokensPerDay!) return Math.max(60, Math.ceil((k + ROLLING_WINDOW_MS - now) / 1000))
    }
    return 60
  }

  private upstreamBlocked(day: Day): boolean {
    if (day.upstreamBlockedUntil !== undefined && this.now() < day.upstreamBlockedUntil) return true
    return day.upstreamExhaustedAt !== undefined && this.now() - day.upstreamExhaustedAt < UPSTREAM_RETRY_MS
  }

  /** Whole seconds until answers are tried again after an upstream stop (at least 1). */
  private upstreamRetryIn(day: Day): number {
    const a = day.upstreamExhaustedAt !== undefined ? day.upstreamExhaustedAt + UPSTREAM_RETRY_MS : 0
    const b = day.upstreamBlockedUntil ?? 0
    return Math.max(1, Math.ceil((Math.max(a, b) - this.now()) / 1000))
  }

  private finite(v: number | undefined): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0
  }

  /** Everything the limits are checked against, in the ledger's unit (unrounded). */
  private async usageFor(k: Keys): Promise<{ install: number; network: number; global: number; month: number; installMonth: number; installLimit: number; networkLimit: number; reduced: boolean }> {
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
    const near = this.finite(soft) && soft < 1 && factor < 1 && (global >= soft * this.limits.globalDailyNeurons || (this.finite(this.limits.globalMonthly) && month >= soft * this.limits.globalMonthly))
    const scale = near ? Math.max(0, factor) : 1
    return { install, network, global, month, installMonth, installLimit: this.limits.installDailyNeurons * scale, networkLimit: this.limits.networkDailyNeurons * scale, reduced: near }
  }

  private async quotaFor(k: Keys): Promise<Quota> {
    const u = await this.usageFor(k)
    // Inkling's own daily figures, also while the provider is briefly unavailable: that pause is reported
    // as its own refusal (upstream_unavailable), never as today's allowance being used up.
    const globalLimit = this.limits.globalDailyNeurons
    const rooms = [u.installLimit - u.install, u.networkLimit - u.network, globalLimit - u.global]
    if (this.finite(this.limits.globalMonthly)) rooms.push(this.limits.globalMonthly - u.month)
    if (this.finite(this.limits.installMonthly)) rooms.push(this.limits.installMonthly - u.installMonth)
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
      ...(this.finite(this.limits.installMonthly) ? { installMonthUsed: Math.round(u.installMonth), installMonthLimit: this.limits.installMonthly } : {}),
      ...(u.reduced ? { reduced: true } : {})
    }
  }

  // ------------------------------------------------------------- public

  quota(id: Identity): Promise<Quota> {
    return this.exclusive(async () => {
      const day = await this.today()
      await this.expire(day)
      return this.quotaFor(await this.keys(id, day))
    })
  }

  /**
   * Reserves `worst` Neurons (the request's worst case) against the global
   * cap; the installation and network need room for `expected`.
   */
  reserve(id: Identity, worst: number, expected: number = worst, fingerprint?: string, tokens?: number): Promise<ReserveResult> {
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

      const q = await this.quotaFor(k)
      const u = await this.usageFor(k)
      // The provider refused for everyone a moment ago (free allocation or credit used up): stop briefly, then try again.
      if (this.upstreamBlocked(day)) return { ok: false, code: 'upstream_unavailable', retryAfter: this.upstreamRetryIn(day), quota: q }
      // Hard spending caps: the request's worst case must fit, counting every answer in progress.
      if (u.global + worst > this.limits.globalDailyNeurons) return { ok: false, code: 'global_quota', retryAfter: this.secondsUntilRoom(await this.hours(), u.global, worst), quota: q }
      if (this.finite(this.limits.globalMonthly) && u.month + worst > this.limits.globalMonthly) return { ok: false, code: 'global_monthly_quota', retryAfter: Math.ceil((nextUtcMonth(now) - now) / 1000), quota: q }
      if (expected > this.limits.installDailyNeurons) return { ok: false, code: 'too_large', quota: q }
      if (u.install + expected > u.installLimit) return { ok: false, code: 'install_quota', retryAfter: resetIn, quota: q }
      if (this.finite(this.limits.installMonthly) && u.installMonth + expected > this.limits.installMonthly) return { ok: false, code: 'install_monthly_quota', retryAfter: Math.ceil((nextUtcMonth(now) - now) / 1000), quota: q }
      if (u.network + expected > u.networkLimit) return { ok: false, code: 'network_quota', retryAfter: resetIn, quota: q }
      // The provider's account-wide request quota (a free endpoint), counted before sending, never after.
      if (this.finite(this.limits.globalRequestsPerDay) && (day.upstreamRequests ?? 0) + 1 > this.limits.globalRequestsPerDay) return { ok: false, code: 'free_daily_quota', retryAfter: resetIn, quota: q }
      if (this.finite(this.limits.globalRequestsPerMinute)) {
        this.globalMinute = this.globalMinute.filter((t) => now - t < 60_000)
        if (this.globalMinute.length + 1 > this.limits.globalRequestsPerMinute) return { ok: false, code: 'capacity', retryAfter: Math.max(1, Math.ceil((60_000 - (now - this.globalMinute[0]!)) / 1000)) }
      }

      // The provider's account-wide token quota (and its requests over any 24 hours), worst case held.
      const tq = this.tokenQuota()
      if (tq) {
        const need = Math.max(1, Math.ceil(tokens ?? 0))
        if (tokens === undefined) return { ok: false, code: 'too_large', quota: q }
        if (this.finite(this.limits.globalTokensPerMinute) && need > this.limits.globalTokensPerMinute) return { ok: false, code: 'too_large', quota: q }
        if (this.finite(this.limits.globalTokensPerDay) && need > this.limits.globalTokensPerDay) return { ok: false, code: 'too_large', quota: q }
        const pd = await this.providerDay()
        if (this.finite(this.limits.globalRequestsPerDay) && pd.req + 1 > this.limits.globalRequestsPerDay) return { ok: false, code: 'free_daily_quota', retryAfter: 3600, quota: q }
        if (this.finite(this.limits.globalTokensPerDay) && pd.tok + need > this.limits.globalTokensPerDay) return { ok: false, code: 'free_token_quota', retryAfter: await this.secondsUntilTokens(pd.tok, need), quota: q }
        const m = await this.minute()
        const minuteTok = m.reduce((n, e) => n + e.tok, 0)
        const minuteWait = (needTok: number, needReq: number): number => {
          // When enough of the last minute's entries leave the window.
          let tok = minuteTok
          let req = m.length
          for (const e of m) {
            tok -= e.tok
            req -= 1
            const tokOk = !this.finite(this.limits.globalTokensPerMinute) || tok + needTok <= this.limits.globalTokensPerMinute
            const reqOk = !this.finite(this.limits.globalRequestsPerMinute) || req + needReq <= this.limits.globalRequestsPerMinute
            if (tokOk && reqOk) return Math.max(1, Math.ceil((e.t + 60_000 - now) / 1000))
          }
          return 60
        }
        if (this.finite(this.limits.globalRequestsPerMinute) && m.length + 1 > this.limits.globalRequestsPerMinute) return { ok: false, code: 'capacity', retryAfter: minuteWait(need, 1) }
        if (this.finite(this.limits.globalTokensPerMinute) && minuteTok + need > this.limits.globalTokensPerMinute) return { ok: false, code: 'capacity', retryAfter: minuteWait(need, 1) }
      }

      const r: Reservation = { id: this.randomId(), install: k.install, network: k.network, installMonth: k.installMonth, neurons: worst, day: day.day, at: now, ...(tq ? { tokens: Math.max(1, Math.ceil(tokens!)) } : {}) }
      open.push(r)
      await this.saveReservations()
      if (tq) {
        const m = await this.minute()
        m.push({ t: now, tok: r.tokens!, id: r.id })
        await this.storage.put('pmin', m)
      }
      if (this.finite(this.limits.globalRequestsPerDay) || this.finite(this.limits.globalRequestsPerMinute)) {
        day.upstreamRequests = (day.upstreamRequests ?? 0) + 1
        this.globalMinute.push(now)
        await this.storage.put('day', day)
      }
      wi.push(now)
      wn.push(now)
      if (fingerprint) this.lastRequest.set(k.install, { fp: fingerprint, reservationId: r.id })
      if (this.lastRequest.size > 5000) this.lastRequest.delete(this.lastRequest.keys().next().value!)
      return { ok: true, reservationId: r.id, quota: await this.quotaFor(k) }
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
      if (opts.upstreamBlockedUntil && opts.upstreamBlockedUntil > this.now()) day.upstreamBlockedUntil = Math.max(day.upstreamBlockedUntil ?? 0, opts.upstreamBlockedUntil)
      if (opts.extraAttempts && opts.extraAttempts > 0) {
        day.upstreamRequests = (day.upstreamRequests ?? 0) + opts.extraAttempts
        for (let i = 0; i < opts.extraAttempts; i++) this.globalMinute.push(this.now())
      }
      const held = open.find((x) => x.id === reservationId)
      if (held?.tokens !== undefined) {
        // Retries were requests too; each may have been counted at its worst case by the provider.
        const extra = Math.max(0, opts.extraAttempts ?? 0)
        const reported = opts.failedBeforeModel && opts.tokens === undefined ? 0 : opts.tokens !== undefined && Number.isFinite(opts.tokens) && opts.tokens >= 0 ? Math.ceil(opts.tokens) : held.tokens
        const tok = reported + extra * held.tokens
        await this.addProviderUsage(held.at, 1 + extra, tok)
        const m = await this.minute()
        const e = m.find((x) => x.id === reservationId)
        if (e) e.tok = reported
        for (let i = 0; i < extra; i++) m.push({ t: this.now(), tok: held.tokens })
        await this.storage.put('pmin', m)
      }
      if (r) {
        this.reservations = open.filter((x) => x !== r)
        await this.saveReservations()
        // A request the model never started costs nothing.
        const cost = opts.failedBeforeModel ? 0 : Math.max(0, neurons ?? r.neurons)
        await this.chargeGlobal(cost, r.at)
        await this.chargeMonth(r.installMonth, cost, r.at)
        if (r.day === day.day) {
          await this.charge(r.install, cost)
          await this.charge(r.network, cost)
          day.global += cost
          day.requests++
        }
      }
      await this.storage.put('day', day)
    })
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
    upstreamRequests: number
    upstreamRequestLimit: number | null
    providerRolling24h: { requests: number; tokens: number; requestLimit: number | null; tokenLimit: number | null } | null
    providerLastMinute: { requests: number; tokens: number; requestLimit: number | null; tokenLimit: number | null } | null
    installations: number
    networks: number
    answering: number
    upstreamExhausted: boolean
    paused: boolean
    limits: LedgerLimits
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
      const reduced =
        this.finite(soft) && soft < 1 && (this.limits.softFactor ?? 1) < 1 && (rolling >= soft * this.limits.globalDailyNeurons || (this.finite(this.limits.globalMonthly) && monthUsed >= soft * this.limits.globalMonthly))
      return {
        day: day.day,
        unit: this.limits.unit ?? 'neurons',
        month: month.month,
        monthUsed: Math.round(monthUsed),
        monthLimit: this.finite(this.limits.globalMonthly) ? this.limits.globalMonthly : null,
        monthAnswers: month.requests,
        reduced,
        upstreamRequests: day.upstreamRequests ?? 0,
        upstreamRequestLimit: this.finite(this.limits.globalRequestsPerDay) ? this.limits.globalRequestsPerDay : null,
        ...(await (async () => {
          if (!this.tokenQuota()) return { providerRolling24h: null, providerLastMinute: null }
          const pd = await this.providerDay()
          const m = await this.minute()
          const rl = this.finite(this.limits.globalRequestsPerDay) ? this.limits.globalRequestsPerDay : null
          return {
            providerRolling24h: { requests: pd.req, tokens: pd.tok, requestLimit: rl, tokenLimit: this.finite(this.limits.globalTokensPerDay) ? this.limits.globalTokensPerDay : null },
            providerLastMinute: {
              requests: m.length,
              tokens: m.reduce((n, e) => n + e.tok, 0),
              requestLimit: this.finite(this.limits.globalRequestsPerMinute) ? this.limits.globalRequestsPerMinute : null,
              tokenLimit: this.finite(this.limits.globalTokensPerMinute) ? this.limits.globalTokensPerMinute : null
            }
          }
        })()),
        // The capped figure: the last 24 hours plus answers in progress.
        globalUsed: Math.round(this.rollingUsed(await this.hours()) + open.reduce((n, r) => n + r.neurons, 0)),
        globalLimit: this.limits.globalDailyNeurons,
        todayUsed: Math.round(day.global),
        answers: day.requests,
        installations: (await this.storage.list('i:')).length,
        networks: (await this.storage.list('n:')).length,
        answering: open.length,
        upstreamExhausted: this.upstreamBlocked(day),
        paused: await this.isPaused(),
        limits: this.limits
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
