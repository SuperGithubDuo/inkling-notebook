/**
 * A/B comparison (v0.1.5): the SAME input trace through two pipelines —
 * v0.1.4 (`smartInk: false`, verified identical to the v0.1.4 commit) and
 * v0.1.5 Smart Ink — with handwriting-usability metrics.
 *
 * Every scenario here is SYNTHETIC (modelled hand, modelled MediaPipe noise,
 * and for the adversarial ones deliberately corrupted landmarks). Recorded
 * webcam traces are compared by `scripts/ab.ts` with truth-free metrics and
 * are reported separately, labelled as real.
 */
import { injectFaults, type FaultKind, type InjectedFault } from '../wisp-motion/synthetic'
import type { Orientation } from './hand3d'
import { buildScene, fittedRegion, layoutMetrics, placeScene, WEBCAM_NOISE, type InkTag, type LayoutScene } from './layout'
import { LAYOUT_SCENES } from './layoutScenes'
import { advanceOf, text, type Placed } from './font'
import { distToPolyline, pathLength, replay, resampleArc, score, truthStrokes, REPLAY_PROCESSOR, type ReplayConfig, type ReplayResult, type StrokeTruth } from './replay'
import { SCENARIOS, setNoiseProfile } from './scenarios'
import { arc, line, polyline, synthesize, writeStrokes, type ScriptFrame, type StrokeSpec, type TruthFrame } from './synth'
import type { LandmarkTrace } from './trace'
import type { NormPoint } from '../strokes/types'

export const PAGE_W = 1600
export const PAGE_H = 1000

export const PIPELINES: Record<'v0.1.4' | 'v0.1.5', ReplayConfig> = {
  'v0.1.4': { processor: { smartInk: false } },
  'v0.1.5': { processor: {} }
}

export interface AbBuilt {
  trace: LandmarkTrace
  /** Ground truth per frame (writing scenarios). */
  truth?: TruthFrame[]
  /** Layout scenes: ink tags for size/baseline metrics. */
  layout?: { tags: InkTag[]; lineOf: (word: number) => number }
  faults?: InjectedFault[]
  /** Report the drawn aspect ratio (a physical circle should come out round: 1.00). */
  shape?: boolean
}

export interface AbCase {
  id: string
  title: string
  /** Number of the required scenario in the v0.1.5 brief (1–12), or null for extra/adversarial ones. */
  required: number | null
  adversarial: boolean
  /** Extra processor settings for both pipelines (e.g. hand-fitted region, Writing Assist). */
  processor?: ReplayConfig['processor']
  build(seed: number): AbBuilt
}

const at = (x: number, y: number): NormPoint => ({ x, y })
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!

/** "Hello World" in simple single-line letters (camera space, x-height ≈ 0.03). */
export function helloWorldStrokes(): StrokeSpec[] {
  const h = 0.03
  const y = 0.5
  let x = 0.2
  const s: StrokeSpec[] = []
  // H
  s.push({ path: line(at(x, y - 2 * h), at(x, y)), duration: 0.4 })
  s.push({ path: line(at(x + 0.025, y - 2 * h), at(x + 0.025, y)), duration: 0.4 })
  s.push({ path: line(at(x, y - h), at(x + 0.025, y - h)), duration: 0.25 })
  x += 0.04
  // e
  s.push({ path: (u) => (u < 0.2 ? line(at(x, y - h / 2), at(x + 0.022, y - h / 2))(u / 0.2) : arc(at(x + 0.011, y - h / 2), 0.011, h / 2, 0, 1.75 * Math.PI)((u - 0.2) / 0.8)), duration: 0.5 })
  x += 0.032
  // l l
  for (let k = 0; k < 2; k++) {
    s.push({ path: line(at(x, y - 2 * h), at(x, y)), duration: 0.35 })
    x += 0.016
  }
  // o
  s.push({ path: arc(at(x + 0.011, y - h / 2), 0.011, h / 2, -Math.PI / 2, 1.5 * Math.PI), duration: 0.45 })
  x += 0.06
  // W (one stroke)
  s.push({ path: polyline([at(x, y - 2 * h), at(x + 0.01, y), at(x + 0.02, y - 1.2 * h), at(x + 0.03, y), at(x + 0.04, y - 2 * h)]), duration: 0.7 })
  x += 0.052
  // o
  s.push({ path: arc(at(x + 0.011, y - h / 2), 0.011, h / 2, -Math.PI / 2, 1.5 * Math.PI), duration: 0.45 })
  x += 0.03
  // r
  s.push({ path: line(at(x, y - h), at(x, y)), duration: 0.25 })
  s.push({ path: arc(at(x + 0.01, y - 0.7 * h), 0.01, 0.3 * h, Math.PI, 1.8 * Math.PI), duration: 0.25 })
  x += 0.026
  // l
  s.push({ path: line(at(x, y - 2 * h), at(x, y)), duration: 0.35 })
  x += 0.014
  // d
  s.push({ path: arc(at(x + 0.011, y - h / 2), 0.011, h / 2, -Math.PI / 2, 1.5 * Math.PI), duration: 0.45 })
  s.push({ path: line(at(x + 0.022, y - 2 * h), at(x + 0.022, y)), duration: 0.35 })
  return s
}

/** A pinched hand vanishes for 3 frames (100 ms, inside the 160 ms grace) and is seen again 0.05 frame widths away, still pinched. */
function reappearScript(): ScriptFrame[] {
  const first = writeStrokes([{ path: arc(at(0.4, 0.45), 0.05, 0.05, Math.PI, 2 * Math.PI), duration: 0.9 }], { carryOn: false })
  while (first.length && !first[first.length - 1]!.intendInk) first.pop()
  const last = first[first.length - 1]!.pen
  const to = at(last.x + 0.02, last.y + 0.045)
  for (let i = 1; i <= 3; i++) first.push({ pen: { x: last.x + ((to.x - last.x) * i) / 3, y: last.y + ((to.y - last.y) * i) / 3 }, gap: 0.16, intendInk: false, present: false })
  // Writing continues at the new place: a second stroke the writer meant to draw there.
  const n = 24
  for (let i = 0; i <= n; i++) first.push({ pen: { x: to.x + 0.06 * (i / n), y: to.y }, gap: 0.16, intendInk: true, mover: 'index' })
  for (let i = 1; i <= 3; i++) first.push({ pen: { x: to.x + 0.06, y: to.y }, gap: 0.16 + (0.75 - 0.16) * (i / 3), intendInk: false })
  for (let i = 0; i < 6; i++) first.push({ pen: { x: to.x + 0.06, y: to.y }, gap: 0.75, intendInk: false })
  return first
}

/** "Hello" while the hand turns: yaw 0 → 40°, roll 0 → 20° across the word. */
function rotatingScript(): ScriptFrame[] {
  const s = writeStrokes(scenarioHello())
  return s.map((f, i) => {
    const u = i / Math.max(1, s.length - 1)
    const o: Orientation = { pitch: 0, yaw: 40 * u, roll: 20 * u }
    return { ...f, orientation: o }
  })
}

function scenarioHello(): StrokeSpec[] {
  return helloWorldStrokes().slice(0, 7)
}

const EM = 0.028
const words = (ws: string[], y: number, first: number): Placed[][] => {
  let x = 0
  return ws.map((w, i) => {
    const g = text(w, x, y, first + i)
    x += advanceOf(w) + 0.6
    return g
  })
}
const SEVERAL_WORDS: LayoutScene = { id: 'AB-words', title: 'Several words on one line', em: EM, origin: { X: 0, Y: 0 }, words: words(['hello', 'hello', 'hello'], 0, 0).map((g) => ({ glyphs: g, depth: 0.45 })) }
const MULTI_LINES: LayoutScene = {
  id: 'AB-lines',
  title: 'Three lines of two words',
  em: EM,
  origin: { X: 0, Y: 0 },
  words: [...words(['hello', 'hello'], 0, 0), ...words(['hello', 'hello'], -1.9, 2), ...words(['hello', 'hello'], -3.8, 4)].map((g) => ({ glyphs: g, depth: 0.45 }))
}

function layoutCase(sc: LayoutScene, lineOf: (w: number) => number, keepScale: boolean): (seed: number) => AbBuilt {
  return (seed) => {
    const cfg: ReplayConfig = { processor: { regionFit: 'hand', keepScale } }
    const { trace, tags } = buildScene(placeScene(sc, fittedRegion(cfg, seed, WEBCAM_NOISE)), seed, WEBCAM_NOISE)
    return { trace, layout: { tags, lineOf } }
  }
}

const fromScenario = (id: string) => (seed: number): AbBuilt => {
  setNoiseProfile('webcam')
  const { trace, truth } = scenario(id).build(seed)
  return { trace, truth }
}

const synth = (script: () => ScriptFrame[]) => (seed: number): AbBuilt => {
  const { trace, truth } = synthesize(script(), { seed, noise: WEBCAM_NOISE })
  return { trace, truth }
}

/** Corrupts a writing case with injected tracking faults (adversarial). */
function adversarial(base: (seed: number) => AbBuilt, count: number, kinds?: FaultKind[]): (seed: number) => AbBuilt {
  return (seed) => {
    const b = base(seed)
    const withHand: LandmarkTrace = { ...b.trace, frames: b.trace.frames.map((f) => (f.lm ? { ...f, h: 'Right' } : f)) }
    // Faults only where ink is intended (synthesize() makes one frame per truth frame), so each one hits writing.
    const inkIdx = b.truth ? b.truth.map((t, i) => (t.intendInk ? i : -1)).filter((i) => i >= 0) : undefined
    const { trace, faults } = injectFaults(withHand, seed * 31 + 5, count, kinds, inkIdx)
    return { ...b, trace, faults }
  }
}

/** Replaces all 21 landmarks with random positions for 1–3 frames at a time (deliberately wrong landmarks). */
function garbage(base: (seed: number) => AbBuilt, count: number): (seed: number) => AbBuilt {
  return (seed) => {
    const b = base(seed)
    let a = (seed * 2654435761) >>> 0
    const r = () => ((a = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x9e3779b9) >>> 0), a / 4294967296)
    const frames = b.trace.frames.map((f) => ({ ...f }))
    const inkIdx = (b.truth ?? []).map((t, i) => (t.intendInk ? i : -1)).filter((i) => i >= 0)
    const faults: InjectedFault[] = []
    for (let k = 0; k < count && inkIdx.length; k++) {
      const i0 = inkIdx[Math.floor(r() * inkIdx.length)]!
      const n = 1 + Math.floor(r() * 3)
      const idx: number[] = []
      for (let i = i0; i < Math.min(frames.length, i0 + n); i++) {
        if (!frames[i]!.lm) continue
        const cx = 0.1 + 0.8 * r(), cy = 0.1 + 0.8 * r()
        frames[i] = { ...frames[i]!, lm: frames[i]!.lm!.map((v, j) => (j % 3 === 0 ? cx + (r() - 0.5) * 0.2 : j % 3 === 1 ? cy + (r() - 0.5) * 0.2 : v)) }
        idx.push(i)
      }
      if (idx.length) faults.push({ kind: 'tip-glitch', frames: idx, t0: frames[idx[0]!]!.t, t1: frames[idx.at(-1)!]!.t })
    }
    return { ...b, trace: { ...b.trace, frames }, faults }
  }
}

const LA = LAYOUT_SCENES.find((d) => d.scene.id === 'LA-distance')!

export const AB_CASES: AbCase[] = [
  { id: 'S01-slow-line', title: 'Slow straight line', required: 1, adversarial: false, build: fromScenario('A-slow-line') },
  { id: 'S02-fast-line', title: 'Fast straight line', required: 2, adversarial: false, build: fromScenario('A3-fast-line') },
  { id: 'S03-small-circle', title: 'Small circle', required: 3, adversarial: false, build: fromScenario('G-circle') },
  { id: 'S04-dashes', title: 'Repeated short dashes', required: 4, adversarial: false, build: fromScenario('F3-dashes') },
  { id: 'S05-hand-disappears', title: 'Hand disappears mid-stroke (350 ms) and returns pinched', required: 5, adversarial: false, build: fromScenario('L-tracking-loss') },
  { id: 'S06-reappears-elsewhere', title: 'Hand lost 133 ms, re-detected 0.05 frame widths away, still pinched', required: 6, adversarial: false, build: synth(reappearScript) },
  { id: 'S07-rotation', title: '"Hello" while turning the hand (yaw 0→40°, roll 0→20°)', required: 7, adversarial: false, build: synth(rotatingScript) },
  { id: 'S08-distances', title: 'Writing at 45, 37 and 56 cm (Writing Assist)', required: 8, adversarial: false, processor: { regionFit: 'hand', keepScale: true }, build: layoutCase(LA.scene, LA.lineOf, true) },
  { id: 'S09-hello-world', title: '"Hello World" at normal speed', required: 9, adversarial: false, build: synth(() => writeStrokes(helloWorldStrokes())) },
  { id: 'S10-math', title: 'x² + 3x − 5 = 0', required: 10, adversarial: false, build: fromScenario('C-math') },
  { id: 'S11-words-line', title: 'Several words on one line', required: 11, adversarial: false, processor: { regionFit: 'hand' }, build: layoutCase(SEVERAL_WORDS, () => 0, false) },
  { id: 'S12-lines', title: 'Multiple lines', required: 12, adversarial: false, processor: { regionFit: 'hand' }, build: layoutCase(MULTI_LINES, (w) => Math.floor(w / 2), false) },
  {
    // A calibrated writing area wider than the page (x 0.2–0.8, y 0.35–0.65 of a 16:9 frame: 3.6:1 vs the page's 1.6:1).
    id: 'C1-calibrated-circle',
    title: 'Circle in a calibrated area that is wider than the page',
    required: null,
    adversarial: false,
    processor: { region: { x0: 0.2, y0: 0.35, x1: 0.8, y1: 0.65 } },
    build: (seed) => {
      const { trace, truth } = synthesize(writeStrokes([{ path: arc(at(0.5, 0.5), 0.05, 0.05, -Math.PI / 2, 1.5 * Math.PI), duration: 1.2 }]), { seed, noise: WEBCAM_NOISE })
      return { trace, truth, shape: true }
    }
  },
  { id: 'X1-line-faults', title: 'Slow line + 5 injected tracking faults', required: null, adversarial: true, build: adversarial(fromScenario('A-slow-line'), 5) },
  { id: 'X2-hello-faults', title: '"Hello World" + 6 injected tracking faults', required: null, adversarial: true, build: adversarial(synth(() => writeStrokes(helloWorldStrokes())), 6) },
  { id: 'X3-math-faults', title: 'x² + 3x − 5 = 0 + 5 injected tracking faults', required: null, adversarial: true, build: adversarial(fromScenario('C-math'), 5) },
  { id: 'X4-hello-swaps', title: '"Hello World" + 4 hand swaps / re-detections', required: null, adversarial: true, build: adversarial(synth(() => writeStrokes(helloWorldStrokes())), 4, ['hand-swap', 'hand-jump', 'dropout-relocate']) },
  { id: 'X5-math-garbage', title: 'x² + 3x − 5 = 0 + random landmark positions (1–3 frames, ×4)', required: null, adversarial: true, build: garbage(fromScenario('C-math'), 4) },
  { id: 'X6-dashes-faults', title: 'Short dashes + 4 fingertip glitches', required: null, adversarial: true, build: adversarial(fromScenario('F3-dashes'), 4, ['tip-glitch']) }
]

// ── Metrics ────────────────────────────────────────────────────────────────

export interface AbMetrics {
  strokes: number
  expected: number
  /** Ink farther than 20 px from every intended path (page px). */
  strayPx: number
  /** Runs of stray ink ≥ 40 px: unwanted connecting lines / marks. */
  strayLines: number
  longestStrayPx: number
  /** Intended strokes with no ink at all (legitimate strokes rejected). */
  lostStrokes: number
  /** Intended path with no ink within 8 px (page px). */
  missingPx: number
  /** Intended strokes shorter than 100 px that ended up less than half inked. */
  shortLost: number
  shortStrokes: number
  startErrPx: number
  endErrPx: number
  /** Intended strokes that came out in 2+ pieces. */
  broken: number
  /** Live cursor vs intended pen point while writing (page px). */
  liveLagPx: number
  /** Mean delay added before a live ink point is shown (ms; > 0 when frames are held). */
  addedDelayMs: number
  /** Share of inked cursor samples that were delayed (held) at all. */
  delayedPct: number
  msPerFrame: number
  /** Layout scenes. */
  sizeCV?: number
  sizeRange?: number
  baselineRMS?: number
  lineTiltDeg?: number
  inkedPct?: number
  /** Height ÷ width of all ink in page px (shape scenes; a circle should be 1.00). */
  aspect?: number
  /** Adversarial scenes: injected faults that left a stray line ≥ 40 px within 300 ms of the fault. */
  faults?: number
  faultsWithStrayLine?: number
}

const px = (p: NormPoint): NormPoint => ({ x: p.x * PAGE_W, y: p.y * PAGE_H })

function strayRuns(strokes: ReplayResult['strokes'], truth: StrokeTruth[], tolPx = 20): { total: number; runs: Array<{ len: number; t0: number; t1: number }> } {
  const paths = truth.map((t) => t.path.map(px))
  const runs: Array<{ len: number; t0: number; t1: number }> = []
  let total = 0
  for (const s of strokes) {
    let cur: { len: number; t0: number; t1: number } | null = null
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!, b = s.points[i]!
      const A = px(a), B = px(b)
      const L = Math.hypot(B.x - A.x, B.y - A.y)
      const n = Math.max(1, Math.ceil(L / 2))
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n
        const q = { x: A.x + (B.x - A.x) * u, y: A.y + (B.y - A.y) * u }
        const far = paths.length === 0 || paths.every((p) => distToPolyline(q, p) > tolPx)
        if (far) {
          total += L / n
          if (!cur) cur = { len: 0, t0: a.t, t1: b.t }
          cur.len += L / n
          cur.t1 = b.t
        } else if (cur) {
          runs.push(cur)
          cur = null
        }
      }
    }
    if (cur) runs.push(cur)
  }
  return { total, runs }
}

function coverage(path: NormPoint[], ink: NormPoint[][], tolPx = 8): number {
  const P = path.map(px)
  const r = resampleArc(P, 1)
  if (r.length === 0) return 1
  const inks = ink.map((s) => s.map(px))
  let ok = 0
  for (const q of r) if (inks.some((s) => distToPolyline(q, s) <= tolPx)) ok++
  return ok / r.length
}

export function abMetrics(c: AbCase, built: AbBuilt, r: ReplayResult): AbMetrics {
  const m: AbMetrics = {
    strokes: r.strokes.length,
    expected: 0,
    strayPx: 0,
    strayLines: 0,
    longestStrayPx: 0,
    lostStrokes: 0,
    missingPx: 0,
    shortLost: 0,
    shortStrokes: 0,
    startErrPx: 0,
    endErrPx: 0,
    broken: 0,
    liveLagPx: 0,
    addedDelayMs: 0,
    delayedPct: 0,
    msPerFrame: r.msPerFrame
  }
  const downs = r.cursor.filter((q) => q.down)
  if (downs.length) {
    m.addedDelayMs = downs.reduce((a, q) => a + ((q.at ?? q.t) - q.t), 0) / downs.length
    m.delayedPct = (100 * downs.filter((q) => (q.at ?? q.t) - q.t > 0.5).length) / downs.length
  }
  if (built.shape) {
    const pts = r.strokes.flatMap((s) => s.points.map(px))
    if (pts.length) m.aspect = (Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y))) / Math.max(1e-9, Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)))
    // Intended paths depend on the mapping being judged, so the shape metric replaces them here.
    return m
  }
  if (built.truth) {
    const cfg = { ...REPLAY_PROCESSOR, ...c.processor }
    const truth = truthStrokes(built.truth, cfg, built.trace.videoAspect)
    const sc = score(r, truth)
    m.expected = truth.length
    const stray = strayRuns(r.strokes, truth)
    m.strayPx = stray.total
    const lines = stray.runs.filter((x) => x.len >= 40)
    m.strayLines = lines.length
    m.longestStrayPx = Math.max(0, ...stray.runs.map((x) => x.len))
    const inks = r.strokes.map((s) => s.points)
    for (const t of truth) {
      const cov = coverage(t.path, inks)
      const L = pathLength(t.path.map(px))
      m.missingPx += (1 - cov) * L
      if (cov === 0 || inks.length === 0) m.lostStrokes++
      if (L < 100) {
        m.shortStrokes++
        if (cov < 0.5) m.shortLost++
      }
    }
    // score() works in page-normalized units on both axes; report its endpoint errors in px along x (1 unit = 1600 px) only where the error is mostly horizontal is wrong, so recompute in px:
    let se = 0, ee = 0, n = 0
    const matched = truth.map(() => [] as typeof r.strokes)
    for (const s of r.strokes) {
      let best = -1, bestO = -Infinity
      truth.forEach((t, i) => {
        const o = Math.min(t.times!.at(-1)!, s.endedAt) - Math.max(t.times![0]!, s.startedAt)
        if (o > bestO) (bestO = o), (best = i)
      })
      if (best >= 0 && bestO > -300) matched[best]!.push(s)
    }
    truth.forEach((t, i) => {
      const ms = matched[i]!
      if (!ms.length) return
      const a = px(ms[0]!.points[0]!), b = px(ms.at(-1)!.points.at(-1)!)
      const ta = px(t.path[0]!), tb = px(t.path.at(-1)!)
      se += Math.hypot(a.x - ta.x, a.y - ta.y)
      ee += Math.hypot(b.x - tb.x, b.y - tb.y)
      n++
      if (ms.length > 1) m.broken++
    })
    m.startErrPx = n ? se / n : 0
    m.endErrPx = n ? ee / n : 0
    m.liveLagPx = sc.liveLag * PAGE_W
    if (built.faults) {
      m.faults = built.faults.length
      m.faultsWithStrayLine = built.faults.filter((f) => lines.some((l) => l.t1 >= f.t0 - 50 && l.t0 <= f.t1 + 300)).length
    }
  }
  if (built.layout) {
    const lm = layoutMetrics(r, r.strokes, built.layout.tags, built.layout.lineOf)
    m.sizeCV = lm.sizeCV
    m.sizeRange = lm.sizeRange
    m.baselineRMS = lm.baselineRMS
    m.lineTiltDeg = lm.lineTiltDeg
    m.inkedPct = lm.inked
    m.liveLagPx = lm.cursorInk
  }
  return m
}

export function runAb(c: AbCase, seed: number, pipeline: keyof typeof PIPELINES): { built: AbBuilt; result: ReplayResult; metrics: AbMetrics } {
  const built = c.build(seed)
  const p = PIPELINES[pipeline]
  const result = replay(built.trace, { ...p, processor: { ...c.processor, ...p.processor } })
  return { built, result, metrics: abMetrics(c, built, result) }
}

/** Truth-free comparison of two runs on a REAL trace: where they disagree. */
export function inkDifference(a: ReplayResult, b: ReplayResult, tolPx = 20): { onlyA: number; onlyB: number } {
  const lenOutside = (x: ReplayResult, y: ReplayResult) => {
    const ys = y.strokes.map((s) => s.points.map(px))
    let L = 0
    for (const s of x.strokes) {
      const r = resampleArc(s.points.map(px), 2)
      for (const q of r) if (ys.every((p) => distToPolyline(q, p) > tolPx)) L += 2
    }
    return L
  }
  return { onlyA: lenOutside(a, b), onlyB: lenOutside(b, a) }
}
