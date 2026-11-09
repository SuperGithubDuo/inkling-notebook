/**
 * Stroke continuity protection (v0.1.5): decides, frame by frame, whether a
 * new tracked pen position may be CONNECTED to the ink drawn so far.
 *
 * Why. v0.1.4 connected every inked frame to the previous one unless a
 * single-frame jump exceeded ~0.17 of the page per frame (OutlierGate). In
 * replay, every long accidental line came from a connection that should never
 * have been made:
 *   - the hand vanished for up to 160 ms (the gesture's "lost" grace) and was
 *     re-detected somewhere else: the two positions were joined by a line;
 *   - a fingertip was misplaced for 3–6 frames (occlusion), each step small
 *     enough to pass the gate: an out-and-back excursion;
 *   - a re-detection arrived in two sub-threshold steps: a long line;
 *   - the gate's speed test used the time since the last ACCEPTED sample, so
 *     after a gap it became MORE permissive, not less.
 *
 * How. Every frame is compared with the last accepted one ("anchor") in VIEW
 * space, measured in PALM WIDTHS (so the thresholds mean the same at 30 or
 * 70 cm and at any writing size), with time-aware tolerances:
 *
 *   kinematic   residual from constant-velocity prediction ≤ σ + kv·|v|·dt + ½·A·dt²
 *   shape       pen position relative to the palm may change only a little per
 *               frame (a misplaced fingertip moves the pen, not the palm)
 *   identity    palm size, palm orientation and handedness can't change abruptly
 *   speed       nothing moves faster than vMax while writing (physically impossible ⇒ never inked)
 *
 * Outcomes:
 *   normal movement      → ink at once (no added latency);
 *   suspected glitch     → the frame is HELD (ink pauses) until the next frame decides:
 *       returns to the anchor's trajectory   → held frames dropped, writing continues;
 *       continues smoothly from the held one → held frames released as ink (a legit
 *                                              fast movement or sharp reversal, 1-frame delay);
 *       stays at a new, self-consistent place → confirmed jump: the stroke is SPLIT (ended at
 *                                              the anchor; nothing connects across) and ink
 *                                              resumes at the new place after `settleFrames`,
 *                                              but only if the hand could physically have got
 *                                              there; otherwise ink is SUSPENDED until the
 *                                              tracker returns to the pen's trajectory or the
 *                                              pen lifts;
 *   tracking gap         → bridged only if short (≤ maxBridgeMs) and small or on the extrapolated
 *                          path; otherwise split as above. Positions are never invented.
 *
 * Pure: no MediaPipe, DOM or engine. The processor feeds it frames and turns
 * its operations into engine calls.
 */
import type { NormPoint } from './types'

export interface MotionFrame {
  t: number
  /** Pen point in view space, both axes in frame-WIDTH units (isotropic). */
  q: NormPoint
  /** Palm centroid, same units. */
  palm: NormPoint
  /** Apparent palm size, same units (palmSize). */
  size: number
  /** Palm normal (camera axes) from world landmarks, or null. */
  normal?: readonly [number, number, number] | null
  /** Handedness label from the tracker, or null. */
  hand?: string | null
}

export interface ContinuityConfig {
  /** Position noise floor (palm widths). */
  sigma: number
  /**
   * Noise-aware floor: the allowance is at least `noiseK` × the measured mean
   * absolute prediction residual of accepted frames (tracking noise differs
   * a lot between cameras, lighting and hand orientations).
   */
  noiseK: number
  /** At pen-up, held frames within this distance of the anchor (palm widths) are kept as ink. */
  endKeep: number
  /** Largest plausible acceleration while writing (palm widths / s²). */
  accel: number
  /** Share of the current speed that may change direction or size within one frame. */
  kv: number
  /** Fastest plausible pen speed while writing (palm widths / s, ≈ 1.2 m/s for an 8.5 cm palm). */
  vMax: number
  /** Pen-relative-to-palm change allowed per frame (palm widths), plus `relRate` per second. */
  relMax: number
  relRate: number
  /** Palm-size change allowed per frame (log), plus `scaleRate` per second. */
  scaleMax: number
  scaleRate: number
  /** Palm-orientation change allowed per frame (degrees), plus `turnRate` per second. */
  turnMaxDeg: number
  turnRateDeg: number
  /** A frame interval longer than max(gapMs, gapFrames × typical interval) is a tracking gap. */
  gapMs: number
  gapFrames: number
  /** Never connect across a gap longer than this (ms). */
  maxBridgeMs: number
  /** A gap may be bridged when the pen moved at most this far (palm widths)… */
  bridgeAbs: number
  /** …or when it lies on the extrapolated path within this fraction of the bridge length. */
  bridgeOnPath: number
  /** Consistent frames needed at a new place before ink resumes there. */
  settleFrames: number
  /** Longest a frame may be held undecided (ms). */
  maxHoldMs: number
  /** Continuation: next-step speed within this factor of the entry step, and direction cosine ≥ contCos. */
  contRatio: number
  contCos: number
  /** After a split, ink may resume on the pen's own trajectory within this window (ms)… */
  resumeWindowMs: number
  /** …if within resumeRadius + resumeSpeed·elapsed of where it was (palm widths, palm widths/s). */
  resumeRadius: number
  resumeSpeed: number
  /**
   * While suspended, ink resumes anyway once tracking has been steady for this
   * many frames with the same hand (palm size within `resumeScaleTol`, same
   * handedness): a long stroke must not stay blank until pen-up.
   */
  stableResumeFrames: number
  resumeScaleTol: number
  /** Floor for the palm-width unit (frame widths), so a palm seen edge-on can't make thresholds tiny. */
  minUnit: number
}

export const DEFAULT_CONTINUITY: ContinuityConfig = {
  sigma: 0.06,
  noiseK: 3.5,
  endKeep: 0.5,
  accel: 300,
  kv: 0.6,
  vMax: 14,
  relMax: 0.3,
  relRate: 1.5,
  scaleMax: 0.2,
  scaleRate: 1,
  turnMaxDeg: 30,
  turnRateDeg: 300,
  gapMs: 100,
  gapFrames: 2.5,
  maxBridgeMs: 200,
  bridgeAbs: 0.2,
  bridgeOnPath: 0.35,
  settleFrames: 2,
  maxHoldMs: 250,
  contRatio: 2.5,
  contCos: 0.3,
  resumeWindowMs: 700,
  resumeRadius: 0.35,
  resumeSpeed: 3,
  stableResumeFrames: 6,
  resumeScaleTol: 0.15,
  minUnit: 0.04
}

export type BreakReason = 'jump' | 'gap' | 'identity' | 'stalled'

export type GuardOp<T> = { op: 'ink'; item: T } | { op: 'break'; reason: BreakReason }

/** What happened to a frame (for diagnostics, traces and weak labels). */
export type GuardVerdict = 'accept' | 'bridge' | 'hold' | 'release' | 'drop' | 'split' | 'suspend' | 'resume' | 'suppressed'

export interface ContinuityStats {
  /** Frames held back for a decision. */
  held: number
  /** Held frames discarded as tracking glitches. */
  dropped: number
  /** Held frames released as ink (legitimate fast movement). */
  released: number
  /** Gaps bridged (short, small or on the extrapolated path). */
  bridged: number
  /** Strokes split at a confirmed jump or unbridgeable gap. */
  splits: number
  /** Times ink was suspended (physically impossible jump or identity change). */
  suspends: number
  /** Inked frames suppressed while suspended. */
  suppressed: number
}

interface Anchor {
  f: MotionFrame
  /** Velocity, frame widths / s. */
  v: NormPoint
}

interface Held<T> {
  f: MotionFrame
  item: T
  /** True if the frame was suspicious for a landmark-shape or identity reason (never a continuation). */
  anomaly: boolean
}

interface Check {
  /** Plausible as the next position on the anchor's trajectory. */
  ok: boolean
  /** Farther than the hand could physically move in the elapsed time. */
  impossible: boolean
  /** Landmark shape or identity changed abruptly. */
  anomaly: boolean
  identity: boolean
  /** Distance moved, palm widths. */
  d: number
  /** Residual from the constant-velocity prediction, palm widths. */
  e: number
  dtMs: number
}

const sub = (a: NormPoint, b: NormPoint): NormPoint => ({ x: a.x - b.x, y: a.y - b.y })
const len = (a: NormPoint): number => Math.hypot(a.x, a.y)
const rel = (f: MotionFrame): NormPoint => ({ x: (f.q.x - f.palm.x) / Math.max(1e-4, f.size), y: (f.q.y - f.palm.y) / Math.max(1e-4, f.size) })

export class ContinuityGuard<T> {
  readonly cfg: ContinuityConfig
  readonly stats: ContinuityStats = { held: 0, dropped: 0, released: 0, bridged: 0, splits: 0, suspends: 0, suppressed: 0 }
  /** Verdict for the most recent frame (diagnostics). */
  lastVerdict: GuardVerdict | null = null

  private anchor: Anchor | null = null
  /** Typical frame interval (ms). */
  private frameMs = 33
  /** Smoothed palm width (frame widths): the distance unit. */
  private unitEma: number | null = null
  /** Ink is being drawn in the current stroke segment (a break must end it). */
  private open = false
  /** Any ink has been drawn since pen-down (only the very first segment may start anywhere). */
  private drawn = false
  private held: Held<T>[] = []
  /** Suspended: no ink until the tracker returns to `suspendAt`'s trajectory (or the pen lifts). */
  private suspendAt: Anchor | null = null
  /** Candidate frames for resuming while suspended. */
  private resumeCand: Held<T>[] = []
  /** Where the tracker went when ink was suspended (the rejected place); updated while it stays there. */
  private rogue: NormPoint | null = null
  /** Steady run of same-hand frames while suspended (escape to a new stroke). */
  private steady: Held<T>[] = []
  /** Hover: candidate re-anchor when tracking moves abruptly while the pen is up. */
  private hoverCand: MotionFrame | null = null
  /** Mean absolute prediction residual of accepted frames (palm widths). */
  private resid = 0.05

  constructor(cfg: Partial<ContinuityConfig> = {}) {
    this.cfg = { ...DEFAULT_CONTINUITY, ...cfg }
  }

  /** Measured tracking noise as a mean prediction residual (palm widths, diagnostics). */
  get noise(): number {
    return this.resid
  }

  private floor(): number {
    return Math.max(this.cfg.sigma, this.cfg.noiseK * this.resid)
  }

  /** True while frames are being held or ink is suspended (live ink paused). */
  get pausing(): boolean {
    return this.held.length > 0 || this.suspendAt !== null
  }

  private unit(f?: MotionFrame): number {
    const u = this.unitEma ?? f?.size ?? this.cfg.minUnit
    return Math.max(this.cfg.minUnit, u)
  }

  private learn(f: MotionFrame, prevT: number | null): void {
    if (prevT !== null) {
      const dt = f.t - prevT
      if (dt > 0 && dt < 200) this.frameMs += 0.1 * (dt - this.frameMs)
    }
    if (f.size > 0 && Number.isFinite(f.size)) this.unitEma = this.unitEma === null ? f.size : this.unitEma + 0.1 * (f.size - this.unitEma)
  }

  private gapLimit(): number {
    return Math.max(this.cfg.gapMs, this.cfg.gapFrames * this.frameMs)
  }

  /** Compares `to` with an anchor. */
  private check(a: Anchor, to: MotionFrame, extrapolate = true): Check {
    const c = this.cfg
    const P = this.unit(to)
    const dtMs = Math.max(1, to.t - a.f.t)
    const dt = dtMs / 1000
    const dtc = Math.min(dt, 0.1)
    const d = len(sub(to.q, a.f.q)) / P
    const pred = extrapolate ? { x: a.f.q.x + a.v.x * dtc, y: a.f.q.y + a.v.y * dtc } : a.f.q
    const e = len(sub(to.q, pred)) / P
    const speed = len(a.v) / P
    const sig = this.floor()
    // Acceleration allowance: ½·A·dt² for one frame; beyond one frame it grows only
    // linearly (sustained maximal acceleration over several frames is not writing).
    const f1 = Math.min(dtc, this.frameMs / 1000)
    const allow = sig + c.kv * speed * dtc + 0.5 * c.accel * dtc * f1
    const impossible = d > 2 * sig + c.vMax * dt
    // Landmark shape: the pen relative to the palm.
    const dRel = len(sub(rel(to), rel(a.f)))
    const shape = dRel > c.relMax + c.relRate * dt
    // Identity: palm size, orientation, handedness.
    const dScale = a.f.size > 0 && to.size > 0 ? Math.abs(Math.log(to.size / a.f.size)) : 0
    let turn = 0
    if (a.f.normal && to.normal) {
      const cos = a.f.normal[0] * to.normal[0] + a.f.normal[1] * to.normal[1] + a.f.normal[2] * to.normal[2]
      turn = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
    }
    const handFlip = !!a.f.hand && !!to.hand && a.f.hand !== to.hand
    const identity = handFlip || dScale > c.scaleMax + c.scaleRate * dt || turn > c.turnMaxDeg + c.turnRateDeg * dt
    const anomaly = shape || identity
    return { ok: e <= allow && !impossible && !anomaly, impossible, anomaly, identity, d, e, dtMs }
  }

  /** `resid`: this frame's prediction residual when it was accepted as ordinary movement (learns the noise level). */
  private accept(f: MotionFrame, prev: Anchor | null, bridged = false, resid: number | null = null): void {
    // Clipped, so a fast move can't inflate the noise estimate.
    if (resid !== null && Number.isFinite(resid)) this.resid += 0.03 * (Math.min(resid, 3 * this.resid) - this.resid)
    let v: NormPoint = { x: 0, y: 0 }
    if (prev) {
      const dt = Math.max(1, f.t - prev.f.t) / 1000
      const vn = { x: (f.q.x - prev.f.q.x) / dt, y: (f.q.y - prev.f.q.y) / dt }
      v = bridged ? vn : { x: prev.v.x + 0.5 * (vn.x - prev.v.x), y: prev.v.y + 0.5 * (vn.y - prev.v.y) }
    }
    this.learn(f, prev?.f.t ?? null)
    this.anchor = { f, v }
  }

  /** A pen-up (hover) frame: tracks the trajectory; never produces ink. */
  observe(f: MotionFrame): void {
    const a = this.anchor
    if (!a || f.t - a.f.t > this.cfg.maxBridgeMs) {
      this.hoverCand = null
      this.accept(f, null)
      this.lastVerdict = 'accept'
      return
    }
    const c = this.check(a, f)
    if (c.ok) {
      this.hoverCand = null
      this.accept(f, a, false, c.dtMs <= 100 ? c.e : null)
      this.lastVerdict = 'accept'
      return
    }
    // Abrupt move while hovering: re-anchor once a second frame agrees (no ink is at stake).
    const cand = this.hoverCand
    if (cand && this.check({ f: cand, v: { x: 0, y: 0 } }, f, false).ok) {
      this.hoverCand = null
      this.accept(cand, null)
      this.accept(f, this.anchor)
    } else this.hoverCand = f
    this.lastVerdict = 'hold'
  }

  /** An inked frame. Returns the operations to apply, in order. */
  ink(f: MotionFrame, item: T): GuardOp<T>[] {
    const out: GuardOp<T>[] = []
    if (this.suspendAt) return this.whileSuspended(f, item, out)
    if (this.held.length) return this.resolve(f, item, out)
    const a = this.anchor
    if (!a || f.t - a.f.t > this.cfg.maxBridgeMs) {
      // No fresh reference (e.g. the hand just reappeared): a stroke may only start
      // after `settleFrames` consistent frames, so a glitch can't be its first point.
      if (!this.open && a === null) {
        // Very first frame ever: nothing to protect yet.
        this.accept(f, null)
        return this.emit(f, item, out, 'accept')
      }
      if (this.open) this.breakStroke(out, 'gap')
      this.hold(f, item, false)
      this.lastVerdict = 'hold'
      return this.maybeSettle(out, null)
    }
    const c = this.check(a, f)
    if (c.dtMs > this.gapLimit()) {
      // A tracking gap: bridge only short, small or on-path gaps.
      if (this.bridgeable(a, f, c)) {
        this.stats.bridged++
        this.accept(f, a, true)
        return this.emit(f, item, out, 'bridge')
      }
      // Never connect across it.
      return this.jumpTo(f, item, out, c)
    }
    if (c.ok) {
      this.accept(f, a, false, c.e)
      return this.emit(f, item, out, 'accept')
    }
    this.hold(f, item, c.anomaly)
    this.lastVerdict = 'hold'
    return out
  }

  /**
   * The pen lifted. Held frames are kept as ink only if they are ordinary
   * (no landmark anomaly) and close to the anchor — the end of a quick stroke
   * must not lose its last frame — otherwise they are discarded, never
   * connected. Returns the frames to draw before the stroke ends.
   */
  penUp(): GuardOp<T>[] {
    const out: GuardOp<T>[] = []
    const a = this.anchor
    if (this.held.length && a && !this.suspendAt) {
      const P = this.unit()
      let keep = 0
      for (const h of this.held) {
        if (h.anomaly || len(sub(h.f.q, a.f.q)) / P > this.cfg.endKeep || h.f.t - a.f.t > this.cfg.maxBridgeMs) break
        keep++
      }
      for (const h of this.held.slice(0, keep)) out.push({ op: 'ink', item: h.item })
      this.stats.released += keep
      this.stats.dropped += this.held.length - keep
    } else if (this.held.length) this.stats.dropped += this.held.length
    this.held = []
    this.resumeCand = []
    this.suspendAt = null
    this.rogue = null
    this.steady = []
    this.open = false
    this.drawn = false
    return out
  }

  /** Tracking lost (hand gone): forget the trajectory. */
  reset(): void {
    this.penUp()
    this.anchor = null
    this.hoverCand = null
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(_f: MotionFrame, item: T, out: GuardOp<T>[], verdict: GuardVerdict): GuardOp<T>[] {
    this.open = true
    this.drawn = true
    out.push({ op: 'ink', item })
    this.lastVerdict = verdict
    return out
  }

  private hold(f: MotionFrame, item: T, anomaly: boolean): void {
    this.held.push({ f, item, anomaly })
    this.stats.held++
  }

  private breakStroke(out: GuardOp<T>[], reason: BreakReason): void {
    if (this.open) {
      out.push({ op: 'break', reason })
      this.stats.splits++
    }
    this.open = false
  }

  /** Resolves held frames with the next frame. */
  private resolve(f: MotionFrame, item: T, out: GuardOp<T>[]): GuardOp<T>[] {
    const a = this.anchor
    const H = this.held
    const first = H[0]!
    const lastH = H[H.length - 1]!
    // 1. Returned to the anchor's trajectory: the held frames were a glitch.
    if (a && f.t - a.f.t <= this.cfg.maxBridgeMs) {
      const c = this.check(a, f)
      if (c.ok && (c.dtMs <= this.gapLimit() || this.bridgeable(a, f, c))) {
        this.stats.dropped += H.length
        this.held = []
        this.accept(f, a)
        return this.emit(f, item, out, 'drop')
      }
    }
    // 2. Smooth continuation from the anchor through the held frames: legitimate fast movement.
    if (a && this.isContinuation(a, [...H.map((h) => h.f), f]) && !H.some((h) => h.anomaly)) {
      const lc = this.check({ f: lastH.f, v: this.velocity(H.length > 1 ? H[H.length - 2]!.f : a.f, lastH.f) }, f)
      if (!lc.anomaly && !lc.impossible) {
        this.stats.released += H.length
        let prev: Anchor | null = a
        for (const h of H) {
          this.accept(h.f, prev)
          prev = this.anchor
          out.push({ op: 'ink', item: h.item })
        }
        this.held = []
        this.accept(f, prev)
        return this.emit(f, item, out, 'release')
      }
    }
    // 3. Consistent with the held frames: a new place (confirmed jump) once settled.
    const self = this.check({ f: lastH.f, v: this.velocity(H.length > 1 ? H[H.length - 2]!.f : lastH.f, lastH.f) }, f)
    if (self.ok || (!self.anomaly && !self.impossible && self.d <= 2 * this.cfg.bridgeAbs)) {
      this.hold(f, item, false)
      this.lastVerdict = 'hold'
      return this.maybeSettle(out, a)
    }
    // 4. Inconsistent with everything: drop the oldest candidates, keep this one as a new candidate.
    this.stats.dropped += H.length
    this.held = []
    if (f.t - first.f.t > this.cfg.maxHoldMs && this.open) this.breakStroke(out, 'stalled')
    this.hold(f, item, true)
    this.lastVerdict = 'hold'
    return out
  }

  /** Held frames that agree with each other: start a new stroke there if the hand could have got there. */
  private maybeSettle(out: GuardOp<T>[], a: Anchor | null): GuardOp<T>[] {
    const H = this.held
    const tooLong = H.length > 0 && H[H.length - 1]!.f.t - H[0]!.f.t > this.cfg.maxHoldMs
    if (H.length < this.cfg.settleFrames && !tooLong) return out
    if (H.length < this.cfg.settleFrames) {
      // Undecidable for too long: end the stroke; wait for a consistent place.
      this.breakStroke(out, 'stalled')
      return out
    }
    const first = H[0]!
    // Suspension protects ink already drawn in this stroke. At the start of a stroke
    // there is nothing to connect to: ink simply starts where the hand has settled
    // (the reference may be a hover frame from a moment of bad tracking).
    if (a && this.drawn) {
      const c = this.check(a, first.f)
      // Impossible speed, a different hand, or a pen that moved relative to a still palm
      // (a misplaced fingertip, not a hand movement): never start ink there.
      if (c.impossible || c.anomaly || first.anomaly) {
        // Not where this hand could be: the tracker latched onto something else.
        this.breakStroke(out, c.identity ? 'identity' : 'jump')
        this.stats.suspends++
        this.suspendAt = a
        this.rogue = H[H.length - 1]!.f.q
        this.stats.dropped += H.length
        this.held = []
        this.lastVerdict = 'suspend'
        return out
      }
    }
    // Possible but not connectable: split, and ink the new place from its first frame.
    this.breakStroke(out, a && first.f.t - a.f.t > this.gapLimit() ? 'gap' : 'jump')
    let prev: Anchor | null = null
    for (const h of H) {
      this.accept(h.f, prev)
      prev = this.anchor
      out.push({ op: 'ink', item: h.item })
    }
    this.open = true
    this.drawn = true
    this.held = []
    this.lastVerdict = 'split'
    return out
  }

  /** Jump detected directly (unbridgeable gap): hold the frame as the start of a possible new place. */
  private jumpTo(f: MotionFrame, item: T, out: GuardOp<T>[], c: Check): GuardOp<T>[] {
    const a = this.anchor
    if (this.drawn && (c.impossible || c.identity)) {
      this.breakStroke(out, c.identity ? 'identity' : 'jump')
      this.stats.suspends++
      this.suspendAt = a
      this.rogue = f.q
      this.lastVerdict = 'suspend'
      return this.whileSuspended(f, item, out)
    }
    this.breakStroke(out, 'gap')
    this.hold(f, item, false)
    this.lastVerdict = 'hold'
    // The anchor stays as the reference for "returned"; settling needs further frames.
    return out
  }

  private whileSuspended(f: MotionFrame, item: T, out: GuardOp<T>[]): GuardOp<T>[] {
    const s = this.suspendAt!
    const elapsed = f.t - s.f.t
    const P = this.unit(f)
    // Where the pen would be had it kept moving as before (straight, at most 300 ms ahead).
    const h = Math.min(elapsed, 300) / 1000
    const pred = { x: s.f.q.x + s.v.x * h, y: s.f.q.y + s.v.y * h }
    const d = len(sub(f.q, s.f.q)) / P
    const dPred = len(sub(f.q, pred)) / P
    // Back on the pen's own trajectory: near where the pen was going, clearly nearer to
    // that than to the place the tracker jumped to, and with an ordinary hand shape.
    const dRogue = this.rogue ? len(sub(f.q, this.rogue)) / P : Infinity
    const sameHand = !this.check(s, f, false).identity && (!s.f.size || !f.size || Math.abs(Math.log(f.size / s.f.size)) <= this.cfg.resumeScaleTol)
    const back = elapsed <= this.cfg.resumeWindowMs && d <= this.cfg.resumeRadius + (this.cfg.resumeSpeed * elapsed) / 1000 && dPred < 0.5 * dRogue && sameHand && !this.check(s, f, false).anomaly
    if (!back && dRogue < 2 * this.cfg.bridgeAbs) this.rogue = f.q
    const cand = this.resumeCand
    const agrees = cand.length === 0 || this.check({ f: cand[cand.length - 1]!.f, v: { x: 0, y: 0 } }, f, false).ok
    // Steady run with the same hand (palm size and handedness as before the jump).
    const lastSteady = this.steady[this.steady.length - 1]
    const steadyOk = sameHand && (!lastSteady || this.check({ f: lastSteady.f, v: this.steady.length > 1 ? this.velocity(this.steady[this.steady.length - 2]!.f, lastSteady.f) : { x: 0, y: 0 } }, f).ok)
    this.steady = steadyOk ? [...this.steady, { f, item, anomaly: false }].slice(-this.cfg.stableResumeFrames) : sameHand ? [{ f, item, anomaly: false }] : []
    const resumeWith = (frames: Held<T>[], verdict: GuardVerdict): GuardOp<T>[] => {
      this.suspendAt = null
      this.rogue = null
      let prev: Anchor | null = null
      for (const x of frames) {
        this.accept(x.f, prev)
        prev = this.anchor
        out.push({ op: 'ink', item: x.item })
      }
      this.resumeCand = []
      this.steady = []
      this.open = true
      this.drawn = true
      this.lastVerdict = verdict
      return out
    }
    if (back && agrees) {
      cand.push({ f, item, anomaly: false })
      if (cand.length >= this.cfg.settleFrames) return resumeWith(cand, 'resume')
    } else {
      this.stats.suppressed += cand.length
      this.resumeCand = back ? [{ f, item, anomaly: false }] : []
      if (!back) this.stats.suppressed++
      // Escape: tracking has been steady with the same hand for a while — resume as a new stroke
      // (from the latest steady frame only: earlier ones may still be the jumped track).
      if (this.steady.length >= this.cfg.stableResumeFrames) return resumeWith([this.steady[this.steady.length - 1]!], 'resume')
    }
    this.lastVerdict = 'suppressed'
    return out
  }

  /** A gap may be bridged only if it is short and the pen moved little, or exactly along its path. */
  private bridgeable(a: Anchor, f: MotionFrame, c: Check): boolean {
    if (c.anomaly || c.impossible || c.dtMs > this.cfg.maxBridgeMs) return false
    const P = this.unit(f)
    const dt = c.dtMs / 1000
    const onPath = len(sub(f.q, { x: a.f.q.x + a.v.x * dt, y: a.f.q.y + a.v.y * dt })) / P
    return c.d <= this.cfg.bridgeAbs || onPath <= this.cfg.sigma + this.cfg.bridgeOnPath * c.d
  }

  private velocity(a: MotionFrame, b: MotionFrame): NormPoint {
    const dt = Math.max(1, b.t - a.t) / 1000
    return { x: (b.q.x - a.q.x) / dt, y: (b.q.y - a.q.y) / dt }
  }

  /**
   * A legitimate fast movement: from the anchor, every step continues the
   * previous one (speed within contRatio, direction cosine ≥ contCos) and no
   * step is faster than vMax. A tracking jump is one big step followed by
   * ordinary ones (a velocity impulse), which fails the ratio test.
   */
  private isContinuation(a: Anchor, path: MotionFrame[]): boolean {
    const P = this.unit()
    let prev = a.f
    let prevStep: { v: NormPoint; s: number } | null = null
    for (const f of path) {
      const v = this.velocity(prev, f)
      const s = len(v) / P
      if (s > this.cfg.vMax) return false
      if (prevStep) {
        const lo = Math.min(s, prevStep.s)
        const hi = Math.max(s, prevStep.s)
        const minSpeed = (3 * this.floor()) / (this.frameMs / 1000)
        if (hi > minSpeed) {
          if (hi > this.cfg.contRatio * Math.max(lo, 1e-9)) return false
          const cos = (v.x * prevStep.v.x + v.y * prevStep.v.y) / Math.max(1e-12, len(v) * len(prevStep.v))
          if (cos < this.cfg.contCos) return false
        }
      }
      prevStep = { v, s }
      prev = f
    }
    return true
  }
}
