/**
 * The writing plane (v0.1.4): where in the camera view the page lives, and
 * how that mapping stays stable while the hand moves, turns and changes
 * distance.
 *
 * Two problems are solved here, both deterministically (no learned model):
 *
 * 1. REACHABILITY (the canvas-edge bug). The pen is the thumb–index midpoint,
 *    but MediaPipe needs the PALM in the frame to track the hand. For a
 *    typical hand at 45 cm the wrist sits ~25 % of the frame height below
 *    the pen. v0.1–v0.1.3 centred the writing region in the frame (70 % of
 *    its height), so putting the pen on the bottom page edge pushed the
 *    wrist out of the frame and tracking failed before the edge was reached.
 *    The region is now fitted inside the area where the pen can go while the
 *    palm stays in view (`safeRegion`), measured from the user's own hand
 *    (`ExtentTracker`) and then locked.
 *
 * 2. SCALE (inconsistent letter sizes). A fixed region in the IMAGE means
 *    letters get bigger when the hand comes closer (perspective: image motion
 *    ∝ 1 / distance). With "Keep writing size steady" on, WISP measures the
 *    hand's image scale in an orientation-independent way — image palm
 *    landmarks against MediaPipe's 3D world landmarks, which are expressed in
 *    camera-aligned axes and therefore foreshortened exactly like the image —
 *    and zooms the region about the camera centre to cancel the change. For a
 *    writing surface facing the camera this is the exact perspective
 *    correction. The scale is smoothed, updated only while the pen is up, and
 *    rate-limited, so the mapping never jumps mid-stroke.
 *
 * All regions are in VIEW space (mirrored camera coordinates, [0,1]²; y in
 * frame-height units, x in frame-width units).
 */
import { LM, type Landmark } from '../tracking/landmarks'
import { clamp, type WritingRegion } from './coordinates'

/** How far the hand extends around the pen point, in view-space units. */
export interface HandExtent {
  up: number
  down: number
  left: number
  right: number
}

/**
 * Typical extent of the palm (wrist, MCP joints) around the pen
 * for a hand facing the camera at ~45 cm (3D hand model, `replay/hand3d.ts`),
 * left/right averaged over both hands. Used until the user's hand has been
 * measured.
 */
export const PRIOR_EXTENT: HandExtent = { up: 0, down: 0.25, left: 0.07, right: 0.07 }

/**
 * Landmarks that must stay inside the frame for reliable tracking: the palm
 * (MediaPipe's detector and tracker are anchored on it). Fingertips may leave
 * the frame briefly while the hand is open; the pen point itself is kept in
 * by the margin.
 */
const TRACKED = [LM.WRIST, LM.THUMB_CMC, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const

/** Extent of the tracked landmarks around a pen point (all in camera space; mirroring applied). */
export function measureExtent(lm: readonly Landmark[], pen: { x: number; y: number }, mirror: boolean): HandExtent | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const i of TRACKED) {
    const p = lm[i]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    const x = mirror ? 1 - p.x : p.x
    x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, p.y), y1 = Math.max(y1, p.y)
  }
  const px = mirror ? 1 - pen.x : pen.x
  return { up: Math.max(0, pen.y - y0), down: Math.max(0, y1 - pen.y), left: Math.max(0, px - x0), right: Math.max(0, x1 - px) }
}

/**
 * The largest rectangle with the page's pixel aspect ratio inside the area
 * where the pen can go with the tracked landmarks still `margin` inside the
 * frame, centred in that area. This region maps to the WHOLE page, so every
 * page edge and corner is reachable with the palm in view.
 */
export function safeRegion(ext: HandExtent, videoAspect: number, pageAspect: number, margin = 0.03): WritingRegion {
  const bx0 = margin + ext.left
  const bx1 = 1 - margin - ext.right
  const by0 = margin + ext.up
  const by1 = 1 - margin - ext.down
  // Degenerate (hand far too close to the camera): fall back to a small central region.
  const bw = Math.max(0.15, bx1 - bx0)
  const bh = Math.max(0.15, by1 - by0)
  const cx = bx1 - bx0 >= 0.15 ? (bx0 + bx1) / 2 : 0.5
  const cy = by1 - by0 >= 0.15 ? (by0 + by1) / 2 : 0.5
  // Pixel aspect of a region = (w · videoAspect) / h.
  let h = bh
  let w = (pageAspect * h) / videoAspect
  if (w > bw) {
    w = bw
    h = (w * videoAspect) / pageAspect
  }
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
}

/**
 * Learns the user's hand extent from hover frames and then LOCKS, so the
 * mapping stays the same for the rest of the session. Re-fit explicitly
 * (calibration, camera restart, "Fit writing area").
 */
export class ExtentTracker {
  private sum: HandExtent = { up: 0, down: 0, left: 0, right: 0 }
  private n = 0
  locked: HandExtent | null = null

  constructor(private readonly frames = 20) {}

  /** Feed one frame while the pen is up. Returns true when the extent has just locked. */
  add(e: HandExtent | null): boolean {
    if (this.locked || !e) return false
    for (const k of ['up', 'down', 'left', 'right'] as const) this.sum[k] += e[k]
    if (++this.n < this.frames) return false
    // A little extra for hand movement while writing (fingers flex, wrist rotates).
    const m = (k: keyof HandExtent) => (this.sum[k] / this.n) * 1.1
    this.locked = { up: m('up'), down: m('down'), left: m('left'), right: m('right') }
    return true
  }

  get extent(): HandExtent {
    return this.locked ?? PRIOR_EXTENT
  }

  /**
   * v0.1.5: the running estimate while still measuring (after 5 frames), so
   * the mapping converges smoothly during hover and `lockNow()` at the first
   * pinch locks exactly what the cursor was already showing (v0.1.4 jumped
   * from the prior to the measured extent at the first pen-down).
   */
  get provisional(): HandExtent {
    if (this.locked) return this.locked
    if (this.n < 5) return PRIOR_EXTENT
    const m = (k: keyof HandExtent) => (this.sum[k] / this.n) * 1.1
    return { up: m('up'), down: m('down'), left: m('left'), right: m('right') }
  }

  /** Lock now: with the measured average if there are at least 5 frames, else the prior. */
  lockNow(): void {
    if (this.locked) return
    if (this.n < 5) {
      this.locked = { ...PRIOR_EXTENT }
      return
    }
    const m = (k: keyof HandExtent) => (this.sum[k] / this.n) * 1.1
    this.locked = { up: m('up'), down: m('down'), left: m('left'), right: m('right') }
  }

  reset(): void {
    this.sum = { up: 0, down: 0, left: 0, right: 0 }
    this.n = 0
    this.locked = null
  }
}

// ── Scale (distance and orientation) ───────────────────────────────────────

const PALM = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const

/**
 * Image scale of the hand, in frame-width units per metre, from the palm:
 * the spread of the image palm landmarks divided by the spread of the same
 * landmarks' world x, y. World landmarks use camera-aligned axes, so turning
 * the hand foreshortens both by the same factor and the ratio stays the
 * same; only distance changes it (∝ 1 / distance). Null without usable
 * world landmarks or when the palm is seen almost edge-on (spread too small
 * to divide reliably).
 */
export function handImageScale(lm: readonly Landmark[], world: readonly Landmark[] | null | undefined, videoAspect: number): number | null {
  if (!world || world.length < 21 || lm.length < 21) return null
  let icx = 0, icy = 0, wcx = 0, wcy = 0
  for (const i of PALM) {
    icx += lm[i]!.x / PALM.length
    icy += lm[i]!.y / videoAspect / PALM.length
    wcx += world[i]!.x / PALM.length
    wcy += world[i]!.y / PALM.length
  }
  let si = 0, sw = 0
  for (const i of PALM) {
    si += Math.hypot(lm[i]!.x - icx, lm[i]!.y / videoAspect - icy)
    sw += Math.hypot(world[i]!.x - wcx, world[i]!.y - wcy)
  }
  if (!(sw > 0.015) || !Number.isFinite(si)) return null // spread under 1.5 cm: edge-on or invalid
  const sPalm = si / sw
  // That is the scale at the PALM's distance. The pen (thumb–index contact)
  // is nearer or farther than the palm depending on how the hand is turned;
  // world z gives that depth offset in metres, and with the palm distance
  // Zp = f / sPalm the pen's scale is f / (Zp + dz). f (focal length in frame
  // widths) is assumed from a typical webcam (65° horizontal field of view);
  // an error in it only scales this small correction.
  let wcz = 0
  for (const i of PALM) wcz += world[i]!.z / PALM.length
  const dz = (world[LM.THUMB_TIP]!.z + world[LM.INDEX_TIP]!.z) / 2 - wcz
  const zp = ASSUMED_FOCAL / sPalm
  const zPen = zp + dz
  if (!(zPen > 0.05)) return null
  const s = ASSUMED_FOCAL / zPen
  return Number.isFinite(s) && s > 0 ? s : null
}

/** Focal length in frame widths for a 65° horizontal field of view (typical laptop webcam). */
export const ASSUMED_FOCAL = 0.5 / Math.tan((32.5 * Math.PI) / 180)

export interface ScaleTrackerOptions {
  /** Smoothing time constant (ms) of the log-scale EMA. */
  tauMs: number
  /** Largest change of the smoothed scale per second (fraction). */
  maxRatePerS: number
  /** Hold the scale while the palm is turned more than this from its reference orientation (degrees). */
  maxTurnDeg: number
}

/**
 * Slowly following, rate-limited estimate of the hand's image scale. It only
 * moves while the pen is up, so a stroke is always drawn with one scale.
 * `reference` is the scale at which the writing region was fitted; the
 * correction factor is current / reference.
 */
export class ScaleTracker {
  private logS: number | null = null
  private lastT = 0
  reference: number | null = null
  /** Smoothed palm normal, and the one at the reference. */
  private normal: [number, number, number] | null = null
  private refNormal: [number, number, number] | null = null
  /** Frames skipped because the hand was turned away from the reference pose (diagnostics). */
  skipped = 0
  private readonly opt: ScaleTrackerOptions

  constructor(opt: Partial<ScaleTrackerOptions> = {}) {
    this.opt = { tauMs: 500, maxRatePerS: 0.6, maxTurnDeg: 20, ...opt }
  }

  /**
   * `normal` is the palm normal (handPose). The scale estimate has a small
   * orientation bias (≈ 2–5 % when the hand turns 30–40°, up to ~10 % with the
   * fingers toward the camera, in the 3D model), and because the region is
   * zoomed about the camera centre a bias would MOVE the writing, not only
   * resize it. So the scale only follows while the palm is within
   * `maxTurnDeg` of its orientation at the reference; turning the hand holds
   * the current scale.
   */
  add(t: number, s: number | null, penDown: boolean, normal?: readonly [number, number, number] | null): void {
    const dt = this.lastT ? Math.min(200, Math.max(0, t - this.lastT)) : 0
    this.lastT = t
    if (normal && !penDown) {
      if (!this.normal) this.normal = [normal[0], normal[1], normal[2]]
      else {
        const k = 1 - Math.exp(-dt / 250)
        const v = this.normal.map((c, i) => c + k * (normal[i]! - c)) as [number, number, number]
        const n = Math.hypot(...v) || 1
        this.normal = [v[0] / n, v[1] / n, v[2] / n]
      }
    }
    if (s === null || penDown) return
    // Gate on this frame's normal (not the smoothed one), so a turn stops the updates at once.
    const now = normal ?? this.normal
    if (this.refNormal && now) {
      const cos = this.refNormal[0] * now[0] + this.refNormal[1] * now[1] + this.refNormal[2] * now[2]
      if (cos < Math.cos((this.opt.maxTurnDeg * Math.PI) / 180)) {
        this.skipped++
        return
      }
    }
    const ls = Math.log(s)
    if (this.logS === null) {
      this.logS = ls
      return
    }
    const a = 1 - Math.exp(-dt / this.opt.tauMs)
    const step = clamp(a * (ls - this.logS), -this.opt.maxRatePerS * (dt / 1000), this.opt.maxRatePerS * (dt / 1000))
    this.logS += step
  }

  get scale(): number | null {
    return this.logS === null ? null : Math.exp(this.logS)
  }

  /** Correction factor for the region: > 1 when the hand is closer than at fitting time. */
  get factor(): number {
    const s = this.scale
    if (s === null || this.reference === null) return 1
    return clamp(s / this.reference, 0.5, 2)
  }

  /** Make the current scale the reference (called when the region is fitted or calibrated). */
  setReference(): void {
    this.reference = this.scale
    this.refNormal = this.normal ? [...this.normal] : null
  }

  reset(): void {
    this.logS = null
    this.lastT = 0
    this.reference = null
    this.normal = null
    this.refNormal = null
    this.skipped = 0
  }
}

/** Largest rectangle with the page's pixel aspect ratio centred inside `r` (view space). */
export function fitAspect(r: WritingRegion, videoAspect: number, pageAspect: number): WritingRegion {
  const w0 = r.x1 - r.x0
  const h0 = r.y1 - r.y0
  if (!(w0 > 0) || !(h0 > 0) || !(videoAspect > 0) || !(pageAspect > 0)) return r
  let h = h0
  let w = (pageAspect * h) / videoAspect
  if (w > w0) {
    w = w0
    h = (w * videoAspect) / pageAspect
  }
  const cx = (r.x0 + r.x1) / 2
  const cy = (r.y0 + r.y1) / 2
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
}

/**
 * Zooms a view-space region about the camera's optical centre (0.5, 0.5).
 * For a writing surface facing the camera, moving the hand from distance Z0
 * to Z scales image offsets from the optical centre by Z0 / Z, so scaling the
 * region by that same factor keeps every physical position on the same page
 * position — not only the letter size.
 */
export function zoomAboutCentre(r: WritingRegion, factor: number): WritingRegion {
  const f = clamp(Number.isFinite(factor) ? factor : 1, 0.5, 2)
  const z = (v: number) => 0.5 + (v - 0.5) * f
  return { x0: z(r.x0), y0: z(r.y0), x1: z(r.x1), y1: z(r.y1) }
}
