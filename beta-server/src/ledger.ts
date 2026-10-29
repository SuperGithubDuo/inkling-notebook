/**
 * The beta's allowance ledger: who may use the tutor, and how much of the
 * day's free Workers AI allowance each tester and the whole beta have used.
 *
 * It runs inside one Durable Object, so every reservation is handled one at a
 * time: two testers can never both take the last of the allowance. Plain
 * TypeScript with a tiny storage interface, so it is unit-tested in Node.
 *
 * Accounting is conservative by design. Before a request reaches the model,
 * its worst case (estimated input + the full output cap) is reserved against
 * both the tester's and the beta's daily limit; afterwards the real usage
 * replaces the reservation. If the real usage is unknown (the student closed
 * the app mid-answer, the model failed oddly) the reservation stays charged.
 * The beta's limit is set below Cloudflare's free 10,000 Neurons a day, so the
 * ledger stops first; Cloudflare's own hard stop on the Workers Free plan is
 * the backstop. Nothing here can make anything paid.
 */

export interface LedgerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface Tester {
  id: string
  name: string
  /** SHA-256 (hex) of the access code. The code itself is never stored. */
  tokenHash: string
  /** Neurons per UTC day. */
  dailyNeurons: number
  createdAt: string
  revoked: boolean
}

export interface LedgerLimits {
  /** Daily cap for the whole beta, below Cloudflare's free 10,000. */
  globalDailyNeurons: number
  /** Default daily allowance for a new tester. */
  testerDailyNeurons: number
  /** Requests per tester per minute. */
  perMinute: number
  /** A reservation not settled within this time is kept as charged and released. */
  reservationTtlMs: number
  /** Used to tell testers roughly how many answers they have left. */
  typicalNeuronsPerAnswer: number
}

export interface Quota {
  testerUsed: number
  testerLimit: number
  globalUsed: number
  globalLimit: number
  approxAnswersLeft: number
  resetAt: string
}

export type ReserveResult =
  | { ok: true; reservationId: string; quota: Quota }
  | { ok: false; code: 'tester_quota' | 'global_quota' | 'rate_limited' | 'busy' | 'paused' | 'revoked' | 'too_large'; message: string; retryAfter?: number; quota?: Quota }

interface DayUsage {
  day: string
  global: number
  testers: Record<string, { neurons: number; requests: number }>
  /** Set when Cloudflare itself reported the free allocation used up. */
  upstreamExhausted?: boolean
}

interface Reservation {
  id: string
  testerId: string
  neurons: number
  day: string
  at: number
}

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)
export const nextUtcMidnight = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

export class Ledger {
  private testers: Record<string, Tester> | null = null
  private usage: DayUsage | null = null
  private paused: boolean | null = null
  /** Open reservations, persisted so an evicted Durable Object can't forget a charge. */
  private reservations = new Map<string, Reservation>()
  private reservationsLoaded = false
  private readonly recent = new Map<string, number[]>()

  constructor(
    private readonly storage: LedgerStorage,
    private readonly limits: LedgerLimits,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => crypto.randomUUID()
  ) {}

  // ------------------------------------------------------------- testers

  private async allTesters(): Promise<Record<string, Tester>> {
    this.testers ??= (await this.storage.get<Record<string, Tester>>('testers')) ?? {}
    return this.testers
  }

  async findByTokenHash(hash: string): Promise<Tester | null> {
    const testers = await this.allTesters()
    for (const t of Object.values(testers)) if (constantTimeEqual(t.tokenHash, hash)) return t
    return null
  }

  async addTester(input: { name: string; tokenHash: string; dailyNeurons?: number }): Promise<Tester> {
    const testers = await this.allTesters()
    const id = `t_${this.randomId().replace(/-/g, '').slice(0, 10)}`
    const tester: Tester = {
      id,
      name: input.name,
      tokenHash: input.tokenHash,
      dailyNeurons: Math.max(0, Math.round(input.dailyNeurons ?? this.limits.testerDailyNeurons)),
      createdAt: new Date(this.now()).toISOString(),
      revoked: false
    }
    testers[id] = tester
    await this.storage.put('testers', testers)
    return tester
  }

  async updateTester(id: string, patch: { revoked?: boolean; dailyNeurons?: number; name?: string }): Promise<Tester | null> {
    const testers = await this.allTesters()
    const t = testers[id]
    if (!t) return null
    testers[id] = {
      ...t,
      ...(patch.revoked !== undefined ? { revoked: patch.revoked } : {}),
      ...(patch.dailyNeurons !== undefined ? { dailyNeurons: Math.max(0, Math.round(patch.dailyNeurons)) } : {}),
      ...(patch.name ? { name: patch.name } : {})
    }
    await this.storage.put('testers', testers)
    return testers[id]!
  }

  async listTesters(): Promise<Array<Omit<Tester, 'tokenHash'> & { usedToday: number; requestsToday: number }>> {
    const testers = await this.allTesters()
    const usage = await this.today()
    return Object.values(testers).map(({ tokenHash: _, ...t }) => ({ ...t, usedToday: usage.testers[t.id]?.neurons ?? 0, requestsToday: usage.testers[t.id]?.requests ?? 0 }))
  }

  // --------------------------------------------------------------- pause

  async isPaused(): Promise<boolean> {
    this.paused ??= (await this.storage.get<boolean>('paused')) ?? false
    return this.paused
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused
    await this.storage.put('paused', paused)
  }

  // --------------------------------------------------------------- usage

  private async today(): Promise<DayUsage> {
    const day = utcDay(this.now())
    if (!this.usage) this.usage = (await this.storage.get<DayUsage>('usage')) ?? null
    if (!this.usage || this.usage.day !== day) {
      this.usage = { day, global: 0, testers: {} }
      await this.storage.put('usage', this.usage)
    }
    return this.usage
  }

  private reservedFor(testerId: string | null, day: string): number {
    let n = 0
    for (const r of this.reservations.values()) if (r.day === day && (testerId === null || r.testerId === testerId)) n += r.neurons
    return n
  }

  private async loadReservations(): Promise<void> {
    if (this.reservationsLoaded) return
    const saved = (await this.storage.get<Reservation[]>('reservations')) ?? []
    this.reservations = new Map(saved.map((r) => [r.id, r]))
    this.reservationsLoaded = true
  }

  private async saveReservations(): Promise<void> {
    await this.storage.put('reservations', [...this.reservations.values()])
  }

  /** Releases reservations that were never settled; they stay charged. */
  private async expire(): Promise<void> {
    await this.loadReservations()
    const now = this.now()
    const usage = await this.today()
    let changed = false
    for (const r of [...this.reservations.values()]) {
      if (now - r.at < this.limits.reservationTtlMs) continue
      this.reservations.delete(r.id)
      if (r.day === usage.day) {
        charge(usage, r.testerId, r.neurons)
      }
      changed = true
    }
    if (changed) {
      await this.storage.put('usage', usage)
      await this.saveReservations()
    }
  }

  async quota(tester: Tester): Promise<Quota> {
    await this.expire()
    const usage = await this.today()
    const day = usage.day
    const testerUsed = (usage.testers[tester.id]?.neurons ?? 0) + this.reservedFor(tester.id, day)
    const globalUsed = usage.global + this.reservedFor(null, day)
    const globalLimit = usage.upstreamExhausted ? Math.min(this.limits.globalDailyNeurons, globalUsed) : this.limits.globalDailyNeurons
    const left = Math.max(0, Math.min(tester.dailyNeurons - testerUsed, globalLimit - globalUsed))
    return {
      testerUsed: Math.round(testerUsed),
      testerLimit: tester.dailyNeurons,
      globalUsed: Math.round(globalUsed),
      globalLimit,
      approxAnswersLeft: Math.floor(left / Math.max(1, this.limits.typicalNeuronsPerAnswer)),
      resetAt: new Date(nextUtcMidnight(this.now())).toISOString()
    }
  }

  /**
   * Reserves `neurons` (the request's worst case) for one request by `tester`.
   * The beta's global cap is checked against the worst case, so the beta can
   * never pass it. A tester only needs room for `expected` (what such a
   * request usually costs): the real cost then replaces the reservation, so a
   * tester can end a day at most one answer over their allowance, which is
   * harmless, rather than being refused a practice set they could afford.
   */
  async reserve(tester: Tester, neurons: number, expected: number = neurons): Promise<ReserveResult> {
    if (await this.isPaused()) return { ok: false, code: 'paused', message: 'The Inkling AI beta is paused right now. Try again later, or use the local Ollama tutor.' }
    if (tester.revoked) return { ok: false, code: 'revoked', message: 'This beta access code has been switched off. Ask the Inkling team for a new one.' }
    await this.expire()
    const now = this.now()
    const usage = await this.today()
    const resetIn = Math.ceil((nextUtcMidnight(now) - now) / 1000)

    if ([...this.reservations.values()].some((r) => r.testerId === tester.id)) {
      return { ok: false, code: 'busy', message: 'Another answer for this access code is still being written. Wait for it to finish.', retryAfter: 5 }
    }
    const times = (this.recent.get(tester.id) ?? []).filter((t) => now - t < 60_000)
    this.recent.set(tester.id, times)
    if (times.length >= this.limits.perMinute) {
      return { ok: false, code: 'rate_limited', message: `The beta allows ${this.limits.perMinute} requests a minute per tester. Try again shortly.`, retryAfter: Math.ceil((60_000 - (now - times[0]!)) / 1000) }
    }
    const quota = await this.quota(tester)
    if (usage.upstreamExhausted || quota.globalUsed + neurons > quota.globalLimit) {
      return {
        ok: false,
        code: 'global_quota',
        message: 'The beta’s free AI allowance for today is used up for everyone. It resets at midnight UTC. The local Ollama tutor still works in the meantime.',
        retryAfter: resetIn,
        quota
      }
    }
    if (quota.testerUsed + expected > quota.testerLimit) {
      const tooBig = expected > quota.testerLimit
      return {
        ok: false,
        code: tooBig ? 'too_large' : 'tester_quota',
        message: tooBig
          ? 'This request is larger than your daily beta allowance. Select a smaller part of the page or ask for fewer problems.'
          : 'You’ve used today’s free beta allowance. It resets at midnight UTC. The local Ollama tutor still works in the meantime.',
        ...(tooBig ? {} : { retryAfter: resetIn }),
        quota
      }
    }
    const id = this.randomId()
    this.reservations.set(id, { id, testerId: tester.id, neurons, day: usage.day, at: now })
    await this.saveReservations()
    times.push(now)
    return { ok: true, reservationId: id, quota: await this.quota(tester) }
  }

  /**
   * Replaces a reservation with the real cost. `neurons` undefined keeps the
   * reserved amount charged (the real usage isn't known).
   */
  async settle(reservationId: string, neurons: number | undefined, opts: { upstreamExhausted?: boolean; failedBeforeModel?: boolean } = {}): Promise<void> {
    await this.loadReservations()
    // Missing means it already expired, and was charged in full then.
    const r = this.reservations.get(reservationId)
    const usage = await this.today()
    if (opts.upstreamExhausted) usage.upstreamExhausted = true
    if (r) {
      this.reservations.delete(reservationId)
      // A request the model never started costs nothing.
      const cost = opts.failedBeforeModel ? 0 : (neurons ?? r.neurons)
      if (r.day === usage.day) charge(usage, r.testerId, cost)
      await this.saveReservations()
    }
    await this.storage.put('usage', usage)
  }

  async summary(): Promise<{ day: string; globalUsed: number; globalLimit: number; testers: number; activeReservations: number; upstreamExhausted: boolean; paused: boolean }> {
    await this.expire()
    const usage = await this.today()
    return {
      day: usage.day,
      globalUsed: Math.round(usage.global + this.reservedFor(null, usage.day)),
      globalLimit: this.limits.globalDailyNeurons,
      testers: Object.keys(await this.allTesters()).length,
      activeReservations: this.reservations.size,
      upstreamExhausted: !!usage.upstreamExhausted,
      paused: await this.isPaused()
    }
  }
}

function charge(usage: DayUsage, testerId: string, neurons: number): void {
  const t = (usage.testers[testerId] ??= { neurons: 0, requests: 0 })
  t.neurons += neurons
  t.requests += 1
  usage.global += neurons
}

/** Compares two hex digests without leaking where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
