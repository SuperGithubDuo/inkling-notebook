/**
 * Synthetic hand traces with known ground truth, for tuning and regression
 * tests. They are a MODEL of MediaPipe's behaviour, not a measurement of it:
 * the noise levels below are assumptions chosen to be in the range of
 * landmark jitter seen on webcams (around 1 px at 640 px for a still hand,
 * plus slow wobble). Real recorded traces remain the real test.
 */
import type { NormPoint } from '../strokes/types'
import type { Landmark } from '../tracking/landmarks'
import { packLandmarks, type LandmarkTrace } from './trace'

/** Deterministic PRNG (mulberry32) so every run sees identical noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(r: () => number): number {
  const u = Math.max(1e-12, r())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

export interface NoiseModel {
  /** White noise per fingertip landmark (camera units, std). */
  tipWhite: number
  /** Slow wobble per fingertip: AR(1) std and correlation. */
  tipWobble: number
  tipWobbleRho: number
  /** Whole-hand wobble shared by all landmarks. */
  handWobble: number
  handWobbleRho: number
  /** Depth noise (z), which feeds the pinch ratio. */
  zWhite: number
}

export const DEFAULT_NOISE: NoiseModel = {
  tipWhite: 0.0015,
  tipWobble: 0.0012,
  tipWobbleRho: 0.7,
  handWobble: 0.0012,
  handWobbleRho: 0.85,
  zWhite: 0.004
}

export const NO_NOISE: NoiseModel = { tipWhite: 0, tipWobble: 0, tipWobbleRho: 0, handWobble: 0, handWobbleRho: 0, zWhite: 0 }

/** A segment of the script: where the intended pen point is, and how open the pinch is. */
export interface ScriptFrame {
  /** Intended pen point (camera space, NOT mirrored). */
  pen: NormPoint
  /** Thumb–index gap as a fraction of palm size (≈ pinch ratio without noise). */
  gap: number
  /** True when the writer intends ink at this frame (ground truth). */
  intendInk: boolean
  /** Which finger moves when the gap changes: 'index' (thumb still), 'thumb', or 'both'. */
  mover?: 'index' | 'thumb' | 'both'
  present?: boolean
}

export const PALM = 0.11 // palm-triangle side, camera units (hand ~40–50 cm from a laptop camera)

/**
 * Builds a 21-landmark hand whose thumb and index tips straddle `pen`.
 * The pinch axis points up-left (index above the thumb), as when holding a pen.
 * `anchor` is where the fingertips would meet when closed; the moving finger
 * travels along the axis, so with mover = 'index' the midpoint shifts as the
 * gap changes — exactly the real-world effect that causes start hooks.
 */
export function handAt(pen: NormPoint, gap: number, mover: 'index' | 'thumb' | 'both' = 'both'): Landmark[] {
  const ax = -0.45
  const ay = -0.89 // unit axis thumb → index (up, slightly left)
  const half = (gap * PALM) / 2
  // `pen` is the contact point when closed. Open fingers move away from it.
  let ti: number, tt: number
  if (mover === 'both') {
    ti = half
    tt = -half
  } else if (mover === 'index') {
    ti = 2 * half
    tt = 0
  } else {
    ti = 0
    tt = -2 * half
  }
  const index = { x: pen.x + ax * ti, y: pen.y + ay * ti, z: -0.02 }
  const thumb = { x: pen.x + ax * tt, y: pen.y + ay * tt, z: -0.015 }
  const wrist = { x: pen.x + 0.06, y: pen.y + 0.17, z: 0 }
  const lm: Landmark[] = Array.from({ length: 21 }, (_, i) => ({ x: wrist.x - 0.01 * (i % 5), y: wrist.y - 0.012 * Math.floor(i / 4), z: 0 }))
  lm[0] = wrist
  lm[5] = { x: wrist.x - 0.05, y: wrist.y - 0.1, z: -0.01 } // index MCP
  lm[17] = { x: wrist.x + 0.055, y: wrist.y - 0.085, z: -0.01 } // pinky MCP
  // Scale the palm triangle to PALM so ratios are meaningful.
  const sideNow = (Math.hypot(lm[5].x - wrist.x, lm[5].y - wrist.y) + Math.hypot(lm[17].x - wrist.x, lm[17].y - wrist.y) + Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y)) / 3
  const k = PALM / sideNow
  for (const i of [5, 17]) {
    lm[i] = { x: wrist.x + (lm[i]!.x - wrist.x) * k, y: wrist.y + (lm[i]!.y - wrist.y) * k, z: lm[i]!.z }
  }
  lm[4] = thumb
  lm[8] = index
  return lm
}

export interface TruthFrame {
  t: number
  /** Intended contact point (camera space). */
  pen: NormPoint
  /** Noise-free midpoint and index tip for this frame's hand pose (camera space). */
  midpoint: NormPoint
  index: NormPoint
  intendInk: boolean
}

export interface SynthResult {
  trace: LandmarkTrace
  /** Ground truth per frame. */
  truth: TruthFrame[]
}

/**
 * Turns a script into a noisy landmark trace at `fps`. videoAspect = 1 so
 * camera x/y units are equal (the processor handles aspect separately).
 */
export function synthesize(script: ScriptFrame[], opts: { seed?: number; noise?: NoiseModel; fps?: number; t0?: number } = {}): SynthResult {
  const r = rng(opts.seed ?? 1)
  const n = opts.noise ?? DEFAULT_NOISE
  const dt = 1000 / (opts.fps ?? 30)
  let hx = 0, hy = 0
  const tw = [
    [0, 0],
    [0, 0]
  ]
  const frames: LandmarkTrace['frames'] = []
  const truth: SynthResult['truth'] = []
  script.forEach((s, i) => {
    const t = (opts.t0 ?? 1000) + i * dt
    hx = n.handWobbleRho * hx + Math.sqrt(1 - n.handWobbleRho ** 2) * n.handWobble * gauss(r)
    hy = n.handWobbleRho * hy + Math.sqrt(1 - n.handWobbleRho ** 2) * n.handWobble * gauss(r)
    for (const w of tw) {
      w[0] = n.tipWobbleRho * w[0]! + Math.sqrt(1 - n.tipWobbleRho ** 2) * n.tipWobble * gauss(r)
      w[1] = n.tipWobbleRho * w[1]! + Math.sqrt(1 - n.tipWobbleRho ** 2) * n.tipWobble * gauss(r)
    }
    const clean = handAt(s.pen, s.gap, s.mover ?? 'both')
    truth.push({
      t,
      pen: s.pen,
      midpoint: { x: (clean[4]!.x + clean[8]!.x) / 2, y: (clean[4]!.y + clean[8]!.y) / 2 },
      index: { x: clean[8]!.x, y: clean[8]!.y },
      intendInk: s.intendInk
    })
    if (s.present === false) {
      frames.push({ t, c: 0, lm: null })
      return
    }
    const lm = handAt(s.pen, s.gap, s.mover ?? 'both').map((p, j) => {
      const tip = j === 4 ? tw[0]! : j === 8 ? tw[1]! : null
      const white = tip ? n.tipWhite : n.tipWhite * 0.6
      return {
        x: p.x + hx + (tip ? tip[0]! : 0) + white * gauss(r),
        y: p.y + hy + (tip ? tip[1]! : 0) + white * gauss(r),
        z: p.z + n.zWhite * gauss(r)
      }
    })
    frames.push({ t, c: 0.97, lm: packLandmarks(lm) })
  })
  return { trace: { format: 'wisp.landmarks', version: 1, videoAspect: 1, frames }, truth }
}

// ── Script builders ────────────────────────────────────────────────────────

export type Path = (u: number) => NormPoint

export const line = (a: NormPoint, b: NormPoint): Path => (u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })

export const polyline = (pts: NormPoint[]): Path => {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y))
  const total = segs.reduce((a, b) => a + b, 0)
  return (u) => {
    let d = u * total
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i]! || i === segs.length - 1) {
        const k = segs[i]! > 0 ? Math.min(1, d / segs[i]!) : 0
        return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * k, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * k }
      }
      d -= segs[i]!
    }
    return pts[pts.length - 1]!
  }
}

/** Ellipse/arc from angle a0 to a1 (radians), centre c, radii rx, ry. */
export const arc = (c: NormPoint, rx: number, ry: number, a0: number, a1: number): Path => (u) => {
  const a = a0 + (a1 - a0) * u
  return { x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) }
}

export interface StrokeSpec {
  path: Path
  /** Seconds to draw the path (constant speed along u). */
  duration: number
  /** Optional hover path to the stroke start (seconds). */
  approach?: number
}

export interface GestureTiming {
  /** Gap when open / pinched (palm fractions). */
  open: number
  closed: number
  /** Frames to close and to open the pinch. */
  closeFrames: number
  openFrames: number
  /** Which finger moves while closing/opening. */
  mover: 'index' | 'thumb' | 'both'
  /** Frames the hand keeps moving along the path direction while opening (user moving on). */
  carryOn: boolean
  /** Frames of stillness before the first stroke. */
  lead: number
}

export const DEFAULT_TIMING: GestureTiming = { open: 0.75, closed: 0.16, closeFrames: 3, openFrames: 3, mover: 'index', carryOn: true, lead: 8 }

/**
 * Script for writing a list of strokes: approach (open hand) → close pinch
 * (still) → draw path (pinched, ink intended) → open pinch → next stroke.
 */
export function writeStrokes(strokes: StrokeSpec[], timing: Partial<GestureTiming> = {}, fps = 30): ScriptFrame[] {
  const g = { ...DEFAULT_TIMING, ...timing }
  const out: ScriptFrame[] = []
  let pos = strokes[0]!.path(0)
  for (let i = 0; i < g.lead; i++) out.push({ pen: pos, gap: g.open, intendInk: false, mover: g.mover })
  for (const s of strokes) {
    const start = s.path(0)
    const nApp = Math.max(4, Math.round((s.approach ?? 0.3) * fps))
    const from = pos
    for (let i = 1; i <= nApp; i++) {
      const k = i / nApp
      const e = k * k * (3 - 2 * k)
      out.push({ pen: { x: from.x + (start.x - from.x) * e, y: from.y + (start.y - from.y) * e }, gap: g.open, intendInk: false, mover: g.mover })
    }
    for (let i = 1; i <= g.closeFrames; i++) {
      out.push({ pen: start, gap: g.open + (g.closed - g.open) * (i / g.closeFrames), intendInk: false, mover: g.mover })
    }
    const nDraw = Math.max(2, Math.round(s.duration * fps))
    for (let i = 0; i <= nDraw; i++) out.push({ pen: s.path(i / nDraw), gap: g.closed, intendInk: true, mover: g.mover })
    const end = s.path(1)
    const prev = s.path(Math.max(0, 1 - 1 / nDraw))
    const vx = end.x - prev.x
    const vy = end.y - prev.y
    pos = end
    for (let i = 1; i <= g.openFrames; i++) {
      if (g.carryOn) pos = { x: pos.x + vx, y: pos.y + vy }
      out.push({ pen: pos, gap: g.closed + (g.open - g.closed) * (i / g.openFrames), intendInk: false, mover: g.mover })
    }
    for (let i = 0; i < 4; i++) out.push({ pen: pos, gap: g.open, intendInk: false, mover: g.mover })
  }
  return out
}
