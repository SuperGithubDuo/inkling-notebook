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
}

export interface Identity {
  /** The app's random installation ID. */
  install: string
  /** The client's network (IP address, or IPv6 /64). */
  network: string
}

export interface Quota {
  installUsed: number
  installLimit: number
  networkUsed: number
  networkLimit: number
  globalUsed: number
  globalLimit: number
  approxAnswersLeft: number
  resetAt: string
}

export type RefusalCode = 'install_quota' | 'network_quota' | 'global_quota' | 'upstream_unavailable' | 'rate_limited' | 'busy' | 'capacity' | 'paused' | 'too_large'
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

interface Reservation {
  id: string
  install: string
  network: string
  neurons: number
  day: string
  at: number
}

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)
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

export class Ledger {
  /** Whole-service Neurons per hour (key: the hour's start in ms), for the rolling cap. */
  private hourState: Record<string, number> | null = null
  private dayState: Day | null = null
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

  /** Today's totals; at a new UTC day, yesterday's per-identity counts and salt are deleted. */
  private async today(): Promise<Day> {
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

  private async keys(id: Identity, day: Day): Promise<{ install: string; network: string }> {
    return {
      install: `i:${(await sha256Hex(`${day.salt}|install|${id.install}`)).slice(0, 32)}`,
      network: `n:${(await sha256Hex(`${day.salt}|network|${networkOf(id.network)}`)).slice(0, 32)}`
    }
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

  private async quotaFor(k: { install: string; network: string }): Promise<Quota> {
    const open = await this.openReservations()
    const reserved = (pred: (r: Reservation) => boolean): number => open.filter(pred).reduce((n, r) => n + r.neurons, 0)
    const installUsed = (await this.counter(k.install)).neurons + reserved((r) => r.install === k.install)
    const networkUsed = (await this.counter(k.network)).neurons + reserved((r) => r.network === k.network)
    // The whole service: the last 24 hours (rolling), not only today, plus answers in progress.
    const globalUsed = this.rollingUsed(await this.hours()) + reserved(() => true)
    // Inkling's own daily figures, also while Cloudflare is briefly unavailable: that pause is reported
    // as its own refusal (upstream_unavailable), never as today's allowance being used up.
    const globalLimit = this.limits.globalDailyNeurons
    const left = Math.max(0, Math.min(this.limits.installDailyNeurons - installUsed, this.limits.networkDailyNeurons - networkUsed, globalLimit - globalUsed))
    return {
      installUsed: Math.round(installUsed),
      installLimit: this.limits.installDailyNeurons,
      networkUsed: Math.round(networkUsed),
      networkLimit: this.limits.networkDailyNeurons,
      globalUsed: Math.round(globalUsed),
      globalLimit,
      approxAnswersLeft: Math.floor(left / Math.max(1, this.limits.typicalNeuronsPerAnswer)),
      resetAt: new Date(nextUtcMidnight(this.now())).toISOString()
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
  reserve(id: Identity, worst: number, expected: number = worst): Promise<ReserveResult> {
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
      // Cloudflare reported its free allocation used up a moment ago: stop briefly for everyone, then try again.
      if (this.upstreamBlocked(day)) return { ok: false, code: 'upstream_unavailable', retryAfter: this.upstreamRetryIn(day), quota: q }
      if (q.globalUsed + worst > q.globalLimit) return { ok: false, code: 'global_quota', retryAfter: this.secondsUntilRoom(await this.hours(), q.globalUsed, worst), quota: q }
      if (expected > this.limits.installDailyNeurons) return { ok: false, code: 'too_large', quota: q }
      if (q.installUsed + expected > q.installLimit) return { ok: false, code: 'install_quota', retryAfter: resetIn, quota: q }
      if (q.networkUsed + expected > q.networkLimit) return { ok: false, code: 'network_quota', retryAfter: resetIn, quota: q }

      const r: Reservation = { id: this.randomId(), install: k.install, network: k.network, neurons: worst, day: day.day, at: now }
      open.push(r)
      await this.saveReservations()
      wi.push(now)
      wn.push(now)
      return { ok: true, reservationId: r.id, quota: await this.quotaFor(k) }
    })
  }

  /**
   * Replaces a reservation with the real cost. `neurons` undefined keeps the
   * reserved amount charged (the real usage isn't known).
   */
  settle(reservationId: string, neurons: number | undefined, opts: { upstreamExhausted?: boolean; failedBeforeModel?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const day = await this.today()
      const open = await this.openReservations()
      // Missing means it already expired, and was charged in full then.
      const r = open.find((x) => x.id === reservationId)
      if (opts.upstreamExhausted) day.upstreamExhaustedAt = this.now()
      if (r) {
        this.reservations = open.filter((x) => x !== r)
        await this.saveReservations()
        // A request the model never started costs nothing.
        const cost = opts.failedBeforeModel ? 0 : Math.max(0, neurons ?? r.neurons)
        await this.chargeGlobal(cost, r.at)
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
  summary(): Promise<{ day: string; globalUsed: number; globalLimit: number; todayUsed: number; answers: number; installations: number; networks: number; answering: number; upstreamExhausted: boolean; paused: boolean; limits: LedgerLimits }> {
    return this.exclusive(async () => {
      const day = await this.today()
      await this.expire(day)
      const open = await this.openReservations()
      return {
        day: day.day,
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
