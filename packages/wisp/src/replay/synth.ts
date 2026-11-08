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
import { CAMERA, FACING, FX, VIDEO_ASPECT, cameraHand, imageLandmarks, occlusionFactor, worldLandmarks, type Orientation } from './hand3d'

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
  /**
   * Fingertip noise multiplier while pinched (gap < 0.35): when the thumb
   * covers the index tip, MediaPipe has to guess the hidden tip, and both
   * tips get noisier exactly while you write. 1 = no extra noise.
   */
  occlusionBoost?: number
  /** Probability per frame of a one-frame landmark glitch on a fingertip, and its size (camera units). */
  glitchProb?: number
  glitchSize?: number
  /**
   * Slow change of the APPARENT thumb–index separation as the hand rotates
   * while writing (AR(1) std in camera units along the pinch axis, and
   * correlation). Moves the tips apart/together; the midpoint stays put.
   */
  gapWobble?: number
  gapWobbleRho?: number
  /** Frame-time jitter as a fraction of the frame interval (0.25 = ±25 %). */
  fpsJitter?: number
  /** Probability per frame that the tracker misses the hand entirely. */
  dropoutProb?: number
  /** Scale of world-landmark noise relative to the image-landmark noise it is derived from (default 1). */
  worldScale?: number
}

/** The v0.1.1 model: steady 30 fps, Gaussian jitter only. */
export const DEFAULT_NOISE: NoiseModel = {
  tipWhite: 0.0015,
  tipWobble: 0.0012,
  tipWobbleRho: 0.7,
  handWobble: 0.0012,
  handWobbleRho: 0.85,
  zWhite: 0.004
}

/**
 * Harsher "webcam" profile (v0.1.2): adds the MediaPipe behaviours the
 * first model left out — noisier tips while pinched (occlusion), single-frame
 * glitches, apparent pinch-distance drift from hand rotation, depth noise,
 * uneven frame timing and occasional missed frames. Still a model, chosen to
 * be pessimistic; recorded traces from a real camera remain the real test.
 */
export const WEBCAM_NOISE: NoiseModel = {
  tipWhite: 0.0022,
  tipWobble: 0.0018,
  tipWobbleRho: 0.75,
  handWobble: 0.0016,
  handWobbleRho: 0.88,
  zWhite: 0.01,
  occlusionBoost: 1.8,
  glitchProb: 0.02,
  glitchSize: 0.02,
  gapWobble: 0.004,
  gapWobbleRho: 0.95,
  fpsJitter: 0.25,
  dropoutProb: 0.008
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
  /** Hand orientation (default: palm facing the camera). */
  orientation?: Orientation
  /** Distance of the pen point from the camera, metres (default 0.45). */
  depth?: number
}

/** Typical palm size in the image at the default distance (width-normalized units). */
export const PALM = 0.13

/** Converts scenario coordinates (both axes in frame-WIDTH units, centred at 0.5) to normalized image coordinates. */
export function scenarioToImage(p: NormPoint): NormPoint {
  return { x: p.x, y: 0.5 + (p.y - 0.5) * VIDEO_ASPECT }
}

/**
 * Noise-free MediaPipe-style image landmarks for a hand pinching at `pen`
 * (scenario coordinates) with the given gap, palm facing the camera.
 */
export function handAt(pen: NormPoint, gap: number, mover: 'index' | 'thumb' | 'both' = 'both', orientation: Orientation = FACING, depth = 0.45): Landmark[] {
  return imageLandmarks(cameraHand({ pen: scenarioToImage(pen), depth, gap, mover, orientation }))
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
/**
 * Turns a script into a noisy trace: image AND world landmarks from the 3D
 * hand model (hand3d.ts) at `fps` (with timing jitter if the noise model has
 * it). Image noise is given in frame-width units and applied equally in
 * pixels on both axes; fingertip noise grows with occlusion (pinching, and
 * orientations where the fingers point at the camera or the palm is edge-on).
 */
export function synthesize(
  script: ScriptFrame[],
  opts: {
    seed?: number
    noise?: NoiseModel
    fps?: number
    t0?: number
    /**
     * v0.1.4: lose tracking when the palm (wrist, MCP joints) leaves the camera frame
     * (MediaPipe needs the palm). The v0.1–v0.1.3 scenarios leave it off: they
     * place the pen anywhere in the frame without modelling the hand around it.
     */
    edgeLoss?: boolean
  } = {}
): SynthResult {
  const r = rng(opts.seed ?? 1)
  const n = opts.noise ?? DEFAULT_NOISE
  const dt = 1000 / (opts.fps ?? 30)
  const ar = (prev: number, rho: number, sd: number) => rho * prev + Math.sqrt(1 - rho ** 2) * sd * gauss(r)
  const yScale = VIDEO_ASPECT // width units → height units
  let hx = 0, hy = 0, gw = 0
  const tw = [
    [0, 0],
    [0, 0]
  ]
  const frames: LandmarkTrace['frames'] = []
  const truth: SynthResult['truth'] = []
  let t = opts.t0 ?? 1000
  script.forEach((s, i) => {
    if (i > 0) t += dt * (1 + (n.fpsJitter ?? 0) * (2 * r() - 1))
    hx = ar(hx, n.handWobbleRho, n.handWobble)
    hy = ar(hy, n.handWobbleRho, n.handWobble)
    gw = ar(gw, n.gapWobbleRho ?? 0, n.gapWobble ?? 0)
    for (const w of tw) {
      w[0] = ar(w[0]!, n.tipWobbleRho, n.tipWobble)
      w[1] = ar(w[1]!, n.tipWobbleRho, n.tipWobble)
    }
    const orientation = s.orientation ?? FACING
    const depth = s.depth ?? 0.45
    const cam = cameraHand({ pen: scenarioToImage(s.pen), depth, gap: s.gap, mover: s.mover ?? 'both', orientation })
    const clean = imageLandmarks(cam)
    truth.push({
      t,
      pen: s.pen,
      midpoint: { x: (clean[4]!.x + clean[8]!.x) / 2, y: (clean[4]!.y + clean[8]!.y) / 2 },
      index: { x: clean[8]!.x, y: clean[8]!.y },
      intendInk: s.intendInk
    })
    const off = (p: { x: number; y: number }) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1
    // Only the palm matters: MediaPipe keeps reporting fingertips (even slightly outside [0, 1]) while the palm is tracked.
    const outOfFrame = opts.edgeLoss === true && [0, 1, 5, 9, 13, 17].some((j) => off(clean[j]!))
    if (s.present === false || outOfFrame || r() < (n.dropoutProb ?? 0)) {
      frames.push({ t: Math.round(t * 10) / 10, c: 0, lm: null, w: null })
      return
    }
    // Fingertip noise grows while pinched (thumb covers the index tip) and with
    // orientations that hide the tips; it also scales with apparent hand size.
    const scale = 0.45 / depth
    const occl = (s.gap < 0.35 ? (n.occlusionBoost ?? 1) : 1) * occlusionFactor(orientation)
    const axL = Math.hypot(clean[8]!.x - clean[4]!.x, (clean[8]!.y - clean[4]!.y) / yScale)
    const ax = axL > 1e-9 ? (clean[8]!.x - clean[4]!.x) / axL : -0.45
    const ay = axL > 1e-9 ? (clean[8]!.y - clean[4]!.y) / yScale / axL : -0.89
    const glitchTip = r() < (n.glitchProb ?? 0) ? (r() < 0.5 ? 4 : 8) : -1
    const ga = 2 * Math.PI * r()
    const noise2 = clean.map((_, j) => {
      const tip = j === 4 ? tw[0]! : j === 8 ? tw[1]! : null
      const white = tip ? n.tipWhite * occl : n.tipWhite * 0.6
      const sign = j === 8 ? 0.5 : j === 4 ? -0.5 : 0
      const g = j === glitchTip ? (n.glitchSize ?? 0) : 0
      const dx = hx + (tip ? tip[0]! * occl : 0) + white * gauss(r) + sign * gw * scale * ax + g * Math.cos(ga)
      const dy = hy + (tip ? tip[1]! * occl : 0) + white * gauss(r) + sign * gw * scale * ay + g * Math.sin(ga)
      return { dx, dy, dz: n.zWhite * (tip ? occl : 1) * gauss(r), tip: tip !== null, white }
    })
    const lm = clean.map((p, j) => {
      const e = noise2[j]!
      return { x: p.x + e.dx, y: p.y + e.dy * yScale, z: p.z + e.dz }
    })
    // World landmarks come from the same network pass as the image landmarks,
    // so we assume their errors are the SAME errors expressed in metres (minus
    // the whole-hand shift, which world landmarks don't have), plus independent
    // depth noise. When the fingers point at the camera the 3D estimate is
    // assumed to degrade only as √ of the image occlusion factor, because the
    // network infers depth from the whole hand shape. Both are assumptions
    // (see README); n.worldScale scales the result to test sensitivity.
    const mPerUnit = (depth * CAMERA.width) / FX
    const ws = n.worldScale ?? 1
    const orientFix = Math.sqrt(occlusionFactor(orientation)) / occlusionFactor(orientation)
    const world = worldLandmarks(cam).map((p, j) => {
      const e = noise2[j]!
      const k = mPerUnit * ws * (e.tip ? orientFix : 1)
      return { x: p.x + (e.dx - hx) * k, y: p.y + (e.dy - hy) * k, z: p.z + e.white * 1.5 * k * gauss(r) }
    })
    frames.push({ t: Math.round(t * 10) / 10, c: 0.97, lm: packLandmarks(lm), w: packLandmarks(world) })
  })
  return { trace: { format: 'wisp.landmarks', version: 3, videoAspect: VIDEO_ASPECT, frames }, truth }
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
  /**
   * Opening profile (v0.1.3): 'linear' (v0.1–v0.1.2 scenarios), or 'ease-in' —
   * the fingers start separating slowly and then speed up, as in a relaxed,
   * real lift. With a small `open`, this is the "fingers just begin to
   * separate" lift that v0.1.2 reacted to late on real webcams.
   */
  openEase?: 'linear' | 'ease-in'
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
      const k = i / g.openFrames
      const e = g.openEase === 'ease-in' ? k * k : k
      out.push({ pen: pos, gap: g.closed + (g.open - g.closed) * e, intendInk: false, mover: g.mover })
    }
    for (let i = 0; i < 4; i++) out.push({ pen: pos, gap: g.open, intendInk: false, mover: g.mover })
  }
  return out
}
