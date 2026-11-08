/**
 * Layout harness (v0.1.4): handwriting written on a PHYSICAL plane in front
 * of the camera, so size, alignment and reachability can be measured.
 *
 * The writer moves the pen over a flat surface facing the camera (metres,
 * x right, y down), at a distance that can change between lines or words
 * (leaning in or back), with a hand orientation that can change, and with
 * optional slow drift (the arm sinking). Text comes from the stroke font in
 * font.ts, so every inked frame carries its intended position in em units.
 *
 * Measurements are made on WISP's FINISHED strokes: for each intended inked
 * frame we look up the ink at the same timestamp and fit, per word,
 *     page_y ≈ a + b·em_y + c·em_x,   page_x ≈ d + e·em_x
 * b is the letter size (px per em), c / e the tilt, a the baseline offset.
 * This is a modelled hand on modelled noise — not a webcam measurement.
 */
import type { ProcessorConfig } from '../input/handFrameProcessor'
import type { Stroke } from '../strokes/types'
import { FACING, FX, CAMERA, VIDEO_ASPECT, cameraHand, imageLandmarks, project, type Orientation, type V3 } from './hand3d'
import { GLYPHS, type Placed } from './font'
import { REPLAY_PROCESSOR, replay, type ReplayConfig, type ReplayResult } from './replay'
import { HandFrameProcessor } from '../input/handFrameProcessor'
import { StrokeEngine } from '../strokes/strokeEngine'
import { unpackLandmarks } from './trace'
import { synthesize, WEBCAM_NOISE, DEFAULT_NOISE, type NoiseModel, type ScriptFrame } from './synth'
import type { LandmarkTrace } from './trace'
import { measureExtent, safeRegion } from '../strokes/writingPlane'
import { defaultRegion, type WritingRegion } from '../strokes/coordinates'

export interface WordSpec {
  glyphs: Placed[]
  /** Pen distance from the camera while writing this word (m). */
  depth: number
  orientation?: Orientation
}

export interface LayoutScene {
  id: string
  title: string
  /** Metres per em on the writing surface. */
  em: number
  /** Physical position (m, camera frame) of em (0, 0). */
  origin: { X: number; Y: number }
  words: WordSpec[]
  /** Slow drift of the hand (m) as a function of elapsed time (s). */
  drift?: (s: number) => { dX: number; dY: number }
  /** Pen speed while drawing (m/s). */
  speed?: number
}

export interface InkTag {
  t: number
  word: number
  role: string
  ex: number
  ey: number
}

const SCENARIO_Y = (imgY: number) => 0.5 + (imgY - 0.5) / VIDEO_ASPECT

/** Image position (camera space, normalized) of a physical point at distance Z. */
export function physToImage(X: number, Y: number, Z: number): { x: number; y: number } {
  return project([X, Y, Z] as V3)
}

/** Physical point (m) seen at a normalized image position at distance Z. */
export function imageToPhys(x: number, y: number, Z: number): { X: number; Y: number } {
  return { X: ((x * CAMERA.width - CAMERA.width / 2) * Z) / FX, Y: ((y * CAMERA.height - CAMERA.height / 2) * Z) / FX }
}

/** Turns a scene into a gesture script (approach, pinch, draw, release per stroke) plus ink tags. */
export function sceneScript(sc: LayoutScene, fps = 30): { script: ScriptFrame[]; tags: InkTag[]; tagFrames: number[] } {
  const dt = 1 / fps
  const speed = sc.speed ?? 0.09
  const script: ScriptFrame[] = []
  const tags: InkTag[] = []
  const tagFrames: number[] = []
  let elapsed = 0
  const open = 0.75
  const closed = 0.16
  type St = { pts: Array<[number, number]>; word: number; role: string; depth: number; orientation: Orientation }
  const strokes: St[] = []
  sc.words.forEach((w, wi) => {
    for (const g of w.glyphs) {
      const glyph = GLYPHS[g.ch]!
      for (const st of glyph.strokes) strokes.push({ pts: st.map(([x, y]) => [g.dx + x * g.scale, g.dy + y * g.scale]), word: wi, role: g.role, depth: w.depth, orientation: w.orientation ?? FACING })
    }
  })
  const toFrame = (ex: number, ey: number, depth: number, orientation: Orientation, gap: number, ink: boolean): ScriptFrame => {
    const d = sc.drift?.(elapsed) ?? { dX: 0, dY: 0 }
    const X = sc.origin.X + ex * sc.em + d.dX
    const Y = sc.origin.Y - ey * sc.em + d.dY
    const img = physToImage(X, Y, depth)
    return { pen: { x: img.x, y: SCENARIO_Y(img.y) }, gap, intendInk: ink, mover: 'index', orientation, depth }
  }
  const push = (f: ScriptFrame) => {
    script.push(f)
    elapsed += dt
  }
  let pos: [number, number] = strokes[0]!.pts[0]!
  let depth = strokes[0]!.depth
  let orient = strokes[0]!.orientation
  for (let i = 0; i < 25; i++) push(toFrame(pos[0], pos[1], depth, orient, open, false))
  let prevWord = strokes[0]!.word
  for (const s of strokes) {
    // Approach while open; longer between words, longer still when distance or orientation changes.
    const changing = s.depth !== depth || s.orientation !== orient
    const nApp = changing ? Math.round(1.2 * fps) : s.word !== prevWord ? Math.round(0.45 * fps) : Math.round(0.22 * fps)
    const from = pos, d0 = depth, o0 = orient
    const start = s.pts[0]!
    for (let i = 1; i <= nApp; i++) {
      const k = i / nApp
      const e = k * k * (3 - 2 * k)
      const oi: Orientation = { pitch: o0.pitch + (s.orientation.pitch - o0.pitch) * e, yaw: o0.yaw + (s.orientation.yaw - o0.yaw) * e, roll: o0.roll + (s.orientation.roll - o0.roll) * e }
      push(toFrame(from[0] + (start[0] - from[0]) * e, from[1] + (start[1] - from[1]) * e, d0 + (s.depth - d0) * e, oi, open, false))
    }
    depth = s.depth
    orient = s.orientation
    prevWord = s.word
    for (let i = 1; i <= 3; i++) push(toFrame(start[0], start[1], depth, orient, open + (closed - open) * (i / 3), false))
    // Draw at constant physical speed along the polyline.
    const seg: number[] = [0]
    for (let i = 1; i < s.pts.length; i++) seg.push(seg[i - 1]! + Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]))
    const L = seg.at(-1)!
    const n = Math.max(3, Math.round(((L * sc.em) / speed) * fps))
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * L
      let j = 1
      while (j < seg.length - 1 && seg[j]! < u) j++
      const a = s.pts[j - 1]!, b = s.pts[j]!
      const k = seg[j]! > seg[j - 1]! ? (u - seg[j - 1]!) / (seg[j]! - seg[j - 1]!) : 0
      const ex = a[0] + (b[0] - a[0]) * k
      const ey = a[1] + (b[1] - a[1]) * k
      tagFrames.push(script.length)
      tags.push({ t: 0, word: s.word, role: s.role, ex, ey })
      push(toFrame(ex, ey, depth, orient, closed, true))
    }
    pos = s.pts.at(-1)!
    for (let i = 1; i <= 3; i++) push(toFrame(pos[0], pos[1], depth, orient, closed + (open - closed) * (i / 3), false))
  }
  for (let i = 0; i < 10; i++) push(toFrame(pos[0], pos[1], depth, orient, open, false))
  return { script, tags, tagFrames }
}

export interface BuiltScene {
  trace: LandmarkTrace
  tags: InkTag[]
}

export function buildScene(sc: LayoutScene, seed: number, noise: NoiseModel = WEBCAM_NOISE, edgeLoss = true): BuiltScene {
  const { script, tags, tagFrames } = sceneScript(sc)
  const { trace, truth } = synthesize(script, { seed, noise, edgeLoss })
  tagFrames.forEach((fi, k) => (tags[k]!.t = truth[fi]!.t))
  return { trace, tags }
}

// ── Measurement ────────────────────────────────────────────────────────────

/** Final-ink position at time t (page px), interpolated along the stroke drawn at that time. */
export function inkAt(strokes: readonly Stroke[], t: number, W = 1600, H = 1000): [number, number] | null {
  for (const s of strokes) {
    const p = s.points
    if (p.length === 0 || t < p[0]!.t - 1 || t > p.at(-1)!.t + 1) continue
    for (let i = 1; i < p.length; i++) {
      if (p[i]!.t >= t) {
        const a = p[i - 1]!, b = p[i]!
        const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
        return [(a.x + (b.x - a.x) * k) * W, (a.y + (b.y - a.y) * k) * H]
      }
    }
    return [p.at(-1)!.x * W, p.at(-1)!.y * H]
  }
  return null
}

function lstsq(rows: number[][], y: number[]): number[] | null {
  // Normal equations; small systems (≤ 3 unknowns).
  const n = rows[0]?.length ?? 0
  if (rows.length < n) return null
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const v = new Array<number>(n).fill(0)
  rows.forEach((r, i) => {
    for (let a = 0; a < n; a++) {
      v[a]! += r[a]! * y[i]!
      for (let b = 0; b < n; b++) A[a]![b]! += r[a]! * r[b]!
    }
  })
  // Gaussian elimination
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r
    if (Math.abs(A[p]![c]!) < 1e-12) return null
    ;[A[c], A[p]] = [A[p]!, A[c]!]
    ;[v[c], v[p]] = [v[p]!, v[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = A[r]![c]! / A[c]![c]!
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!
      v[r]! -= f * v[c]!
    }
  }
  return v.map((x, i) => x / A[i]![i]!)
}

export interface GroupFit {
  word: number
  role: string
  n: number
  /** px per em, vertical and horizontal. */
  sizeY: number
  sizeX: number
  /** Baseline (em y = 0) page y at the group's horizontal centre. */
  baseY: number
  /** Group centre (page x). */
  cx: number
  /** Tilt of the baseline (degrees, + = clockwise on screen). */
  tiltDeg: number
  /** RMS residual after the fit (px): shape distortion that size/tilt/offset don't explain. */
  residual: number
}

export function fitGroups(strokes: readonly Stroke[], tags: readonly InkTag[], key: (t: InkTag) => string): { fits: Map<string, GroupFit>; matched: number } {
  const groups = new Map<string, Array<{ tag: InkTag; p: [number, number] }>>()
  let matched = 0
  for (const tag of tags) {
    const p = inkAt(strokes, tag.t)
    if (!p) continue
    matched++
    const k = key(tag)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push({ tag, p })
  }
  const fits = new Map<string, GroupFit>()
  for (const [k, g] of groups) {
    const fy = lstsq(g.map(({ tag }) => [1, tag.ey, tag.ex]), g.map(({ p }) => p[1]))
    const fx = lstsq(g.map(({ tag }) => [1, tag.ex, tag.ey]), g.map(({ p }) => p[0]))
    if (!fy || !fx) continue
    const [a, b, c] = fy as [number, number, number]
    const [d, e, f] = fx as [number, number, number]
    const exm = g.reduce((s, { tag }) => s + tag.ex, 0) / g.length
    let r2 = 0
    for (const { tag, p } of g) r2 += (p[1] - (a + b * tag.ey + c * tag.ex)) ** 2 + (p[0] - (d + e * tag.ex + f * tag.ey)) ** 2
    fits.set(k, {
      word: g[0]!.tag.word,
      role: g[0]!.tag.role,
      n: g.length,
      sizeY: -b,
      sizeX: e,
      baseY: a + c * exm,
      cx: d + e * exm,
      tiltDeg: (Math.atan2(c, e) * 180) / Math.PI,
      residual: Math.sqrt(r2 / g.length)
    })
  }
  return { fits, matched }
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const sd = (v: number[]) => {
  const m = mean(v)
  return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : 0
}

export interface LayoutMetrics {
  /** Coefficient of variation of letter size across words that were meant to be the same size (%). */
  sizeCV: number
  /** Largest / smallest word size (ratio). */
  sizeRange: number
  /** Mean letter size (x-height, page px). */
  xHeight: number
  /** For each line: RMS distance of word baselines from the line's straight baseline (px), averaged. */
  baselineRMS: number
  /** Mean absolute baseline tilt of lines (degrees). */
  lineTiltDeg: number
  /** Mean absolute tilt within words (degrees). */
  wordTiltDeg: number
  /** Shape residual (px, mean over words): distortion not explained by size, tilt and offset. */
  shapeResidual: number
  /** Share of intended inked frames that have ink (%). */
  inked: number
  /** Live cursor vs final ink at the same instant (px, mean while writing). */
  cursorInk: number
}

/** `lineOf(word)` says which words share a line (and should share a baseline). */
export function layoutMetrics(r: ReplayResult, strokes: readonly Stroke[], tags: readonly InkTag[], lineOf: (word: number) => number): LayoutMetrics {
  const { fits, matched } = fitGroups(strokes, tags.filter((t) => t.role === 'main'), (t) => String(t.word))
  const F = [...fits.values()]
  const sizes = F.map((f) => f.sizeY)
  const byLine = new Map<number, GroupFit[]>()
  for (const f of F) {
    const l = lineOf(f.word)
    if (!byLine.has(l)) byLine.set(l, [])
    byLine.get(l)!.push(f)
  }
  const rms: number[] = []
  const tilt: number[] = []
  for (const g of byLine.values()) {
    if (g.length < 2) continue
    const fit = lstsq(g.map((f) => [1, f.cx]), g.map((f) => f.baseY))
    if (!fit) continue
    const [a, b] = fit as [number, number]
    // Words on one line should share one straight, level baseline: report the
    // spread of word baselines about the best straight line (steps between
    // words) and that line's tilt. (With two words the spread is 0 by construction.)
    rms.push(Math.sqrt(mean(g.map((f) => (f.baseY - (a + b * f.cx)) ** 2))))
    tilt.push(Math.abs((Math.atan(b) * 180) / Math.PI))
  }
  // Live cursor vs final ink.
  let ci = 0
  let nci = 0
  for (const c of r.cursor) {
    if (!c.down) continue
    const p = inkAt(strokes, c.t)
    if (!p) continue
    ci += Math.hypot(p[0] - c.x * 1600, p[1] - c.y * 1000)
    nci++
  }
  const mainTags = tags.filter((t) => t.role === 'main').length
  return {
    sizeCV: (sd(sizes) / mean(sizes)) * 100,
    sizeRange: Math.max(...sizes) / Math.min(...sizes),
    xHeight: mean(sizes) * 0.5,
    baselineRMS: mean(rms),
    lineTiltDeg: mean(tilt),
    wordTiltDeg: mean(F.map((f) => Math.abs(f.tiltDeg))),
    shapeResidual: mean(F.map((f) => f.residual)),
    inked: (matched / Math.max(1, mainTags)) * 100,
    cursorInk: nci ? ci / nci : NaN
  }
}

/**
 * Notation geometry: is each non-main part (superscript, subscript,
 * denominator, root sign) where and how big it was written RELATIVE to the
 * main text next to it? The main text's own fit (size, tilt, offset) predicts
 * where every point of the part should be if the word was mapped as one rigid
 * piece; we compare the part's actual centroid (offset error, in main ems)
 * and spread (size error, as a fraction) with that prediction. 0 / 0 = the
 * relative geometry of the notation is exactly preserved.
 */
export function notationError(strokes: readonly Stroke[], tags: readonly InkTag[]): { sizeErr: number; offsetErr: number; groups: number } {
  const { fits } = fitGroups(strokes, tags.filter((t) => t.role === 'main'), (t) => String(t.word))
  const groups = new Map<string, Array<{ tag: InkTag; p: [number, number] }>>()
  for (const tag of tags) {
    if (tag.role === 'main' || tag.role === 'bar') continue
    const p = inkAt(strokes, tag.t)
    if (!p) continue
    const k = `${tag.word}:${tag.role}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push({ tag, p })
  }
  const se: number[] = []
  const oe: number[] = []
  for (const [k, g] of groups) {
    const main = fits.get(k.split(':')[0]!)
    if (!main || g.length < 4) continue
    // Prediction from the main fit: rigid mapping em → page (size, tilt about the baseline, offset).
    const th = (main.tiltDeg * Math.PI) / 180
    const exm = mean(tags.filter((t) => t.word === main.word && t.role === 'main').map((t) => t.ex))
    const pred = g.map(({ tag }) => {
      const dx = (tag.ex - exm) * main.sizeX
      const dy = -tag.ey * main.sizeY
      return [main.cx + dx * Math.cos(th) - dy * Math.sin(th), main.baseY + dx * Math.sin(th) + dy * Math.cos(th)] as const
    })
    const c = (v: ReadonlyArray<readonly [number, number]>) => [mean(v.map((q) => q[0])), mean(v.map((q) => q[1]))] as const
    const spread = (v: ReadonlyArray<readonly [number, number]>, m: readonly [number, number]) => Math.sqrt(mean(v.map((q) => (q[0] - m[0]) ** 2 + (q[1] - m[1]) ** 2)))
    const act = g.map(({ p }) => p)
    const ca = c(act), cp = c(pred)
    oe.push(Math.hypot(ca[0] - cp[0], ca[1] - cp[1]) / main.sizeY)
    se.push(Math.abs(spread(act, ca) / spread(pred, cp) - 1))
  }
  return { sizeErr: mean(se), offsetErr: mean(oe), groups: se.length }
}

// ── Configs and the expected writing region ─────────────────────────────────

export const LAYOUT_CONFIGS: Record<string, ReplayConfig> = {
  'v0.1.3 (centred region)': { processor: { regionFit: 'centred' } },
  'Natural (v0.1.4)': { processor: { regionFit: 'hand' } },
  'Writing Assist': { processor: { regionFit: 'hand', keepScale: true } }
}

export function replayLayout(trace: LandmarkTrace, cfg: ReplayConfig): ReplayResult {
  return replay(trace, cfg)
}

/**
 * The region WISP actually fits once it has seen the user's hand (what the
 * user then sees on the camera preview): a short probe replay of a hand
 * resting mid-frame at `depth`, through the real processor.
 */
export function fittedRegion(cfg: ReplayConfig, seed = 1, noise: NoiseModel = WEBCAM_NOISE, depth = 0.45): WritingRegion {
  const script: ScriptFrame[] = Array.from({ length: 30 }, () => ({ pen: { x: 0.55, y: SCENARIO_Y(0.35) }, gap: 0.75, intendInk: false, mover: 'index', depth }))
  const { trace } = synthesize(script, { seed, noise, edgeLoss: true })
  const proc = new HandFrameProcessor(new StrokeEngine(), { ...REPLAY_PROCESSOR, ...cfg.processor })
  for (const f of trace.frames) proc.process({ t: f.t, landmarks: unpackLandmarks(f.lm), world: unpackLandmarks(f.w ?? null), confidence: f.c, videoAspect: trace.videoAspect })
  return proc.region(trace.videoAspect)
}

/**
 * Places a scene where the user would write it: em (0, 0) near the top-left
 * of the page as this mapping shows it (10 % in from the left, 28 % down).
 */
export function placeScene(sc: LayoutScene, region: WritingRegion, depth = 0.45): LayoutScene {
  const p = imageToPhys(region.x0 + (region.x1 - region.x0) * 0.1, region.y0 + (region.y1 - region.y0) * 0.28, depth)
  return { ...sc, origin: { X: p.X, Y: p.Y } }
}

/** The region WISP fits for a facing hand hovering at `depth`, mid-frame. */
export function expectedHandRegion(depth: number, pageAspect = 1.6, mirror = false): WritingRegion {
  const lm = imageLandmarks(cameraHand({ pen: { x: 0.55, y: 0.35 }, depth, gap: 0.75, mover: 'index', orientation: FACING }))
  const pen = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 }
  const e = measureExtent(lm, pen, mirror)!
  return safeRegion({ up: e.up * 1.1, down: e.down * 1.1, left: e.left * 1.1, right: e.right * 1.1 }, VIDEO_ASPECT, pageAspect)
}

export const CENTRED_REGION = (): WritingRegion => defaultRegion(VIDEO_ASPECT, 1.6, 0.7)

export { DEFAULT_NOISE, WEBCAM_NOISE }
export type { ProcessorConfig }
