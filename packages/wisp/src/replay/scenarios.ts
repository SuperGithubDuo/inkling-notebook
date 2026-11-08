/**
 * Synthetic scenarios matching the real-webcam acceptance tests (A–F).
 * Coordinates are camera space (videoAspect 1); the default writing region
 * maps roughly x 0.18–0.82, y 0.3–0.7 to the page.
 */
import { FACING, type Orientation } from './hand3d'
import { DEFAULT_NOISE, WEBCAM_NOISE, arc, line, polyline, synthesize as synth0, writeStrokes, type GestureTiming, type NoiseModel, type ScriptFrame, type StrokeSpec, type SynthResult } from './synth'

/** Noise multiplier for all scenarios (1 = the profile as defined). Set by `npm run replay -- --noise 2.5`. */
let noiseScale = 1
/** 'webcam' (default since v0.1.2): harsher, MediaPipe-like; 'model': the v0.1.1 Gaussian model. */
export type NoiseProfile = 'webcam' | 'model'
let profile: NoiseProfile = 'webcam'
let fps = 30
let worldScale = 1
/** World-landmark noise relative to the image noise it is derived from (`--world-noise 2`). */
export function setWorldNoise(k: number): void {
  worldScale = Number.isFinite(k) && k >= 0 ? k : 1
}
export function setNoiseScale(k: number): void {
  noiseScale = Number.isFinite(k) && k >= 0 ? k : 1
}
export function setNoiseProfile(p: NoiseProfile): void {
  profile = p
}
/** Camera frame rate for synthetic traces (the webcam profile adds ±25 % timing jitter). */
export function setFps(f: number): void {
  fps = Number.isFinite(f) && f >= 5 ? f : 30
}
function scaled(): NoiseModel {
  const n = profile === 'webcam' ? WEBCAM_NOISE : DEFAULT_NOISE
  return {
    ...n,
    tipWhite: n.tipWhite * noiseScale,
    tipWobble: n.tipWobble * noiseScale,
    handWobble: n.handWobble * noiseScale,
    zWhite: n.zWhite * noiseScale,
    gapWobble: (n.gapWobble ?? 0) * noiseScale,
    glitchSize: (n.glitchSize ?? 0) * Math.min(noiseScale, 2),
    worldScale
  }
}
const synthesize: typeof synth0 = (script, opts = {}) => synth0(script, { noise: scaled(), fps, ...opts })
const W = (strokes: StrokeSpec[], t: Partial<GestureTiming> = {}): ScriptFrame[] => writeStrokes(strokes, t, fps)

export interface Scenario {
  id: string
  title: string
  /** 'writing' | 'gesture' | 'orientation' | 'speed' — for grouping in reports. */
  group?: string
  build(seed: number): SynthResult
}

/** Applies a hand orientation and distance to every frame of a script. */
function posed(script: ScriptFrame[], orientation: Orientation, depth = 0.45): ScriptFrame[] {
  return script.map((f) => ({ ...f, orientation, depth }))
}

/** Same strokes, written `k` times faster (pinch/release timing unchanged). */
function faster(strokes: StrokeSpec[], k: number): StrokeSpec[] {
  return strokes.map((s) => ({ ...s, duration: s.duration / k, approach: (s.approach ?? 0.3) / k }))
}

const at = (x: number, y: number) => ({ x, y })

/** Handwriting-sized letters: x-height ≈ 0.035 camera units ≈ 0.09 page height. */
function helloStrokes(): StrokeSpec[] {
  const h = 0.035
  const y0 = 0.5
  let x = 0.3
  const s: StrokeSpec[] = []
  // H
  s.push({ path: line(at(x, y0 - 2 * h), at(x, y0)), duration: 0.45 })
  s.push({ path: line(at(x + 0.03, y0 - 2 * h), at(x + 0.03, y0)), duration: 0.45 })
  s.push({ path: line(at(x, y0 - h), at(x + 0.03, y0 - h)), duration: 0.3 })
  x += 0.05
  // e
  s.push({ path: (u) => (u < 0.2 ? line(at(x, y0 - h / 2), at(x + 0.025, y0 - h / 2))(u / 0.2) : arc(at(x + 0.0125, y0 - h / 2), 0.0125, h / 2, 0, 1.75 * Math.PI)((u - 0.2) / 0.8)), duration: 0.6 })
  x += 0.04
  // l, l (tall loops approximated by thin ellipses)
  for (let k = 0; k < 2; k++) {
    s.push({ path: arc(at(x, y0 - h), 0.006, h, Math.PI / 2, Math.PI / 2 + 2 * Math.PI), duration: 0.6 })
    x += 0.025
  }
  // o
  s.push({ path: arc(at(x + 0.012, y0 - h / 2), 0.013, h / 2, -Math.PI / 2, 1.5 * Math.PI), duration: 0.55 })
  return s
}

/** x² + 3x − 5 = 0, with a small superscript. */
function mathStrokes(): StrokeSpec[] {
  const h = 0.03
  const y = 0.52
  let x = 0.25
  const s: StrokeSpec[] = []
  const xGlyph = (cx: number, size: number) => {
    s.push({ path: line(at(cx, y - size), at(cx + size * 0.8, y)), duration: 0.3 })
    s.push({ path: line(at(cx + size * 0.8, y - size), at(cx, y)), duration: 0.3 })
  }
  xGlyph(x, h)
  // superscript 2: ~40% size, raised
  const sx = x + h + 0.004
  const sy = y - h - 0.004
  const r = 0.006
  s.push({ path: (u) => (u < 0.6 ? arc(at(sx + r, sy - r * 0.6), r, r * 0.8, Math.PI, 2.2 * Math.PI)(u / 0.6) : polyline([at(sx + 1.9 * r, sy - 0.2 * r), at(sx, sy + r), at(sx + 2 * r, sy + r)])((u - 0.6) / 0.4)), duration: 0.45 })
  x += 0.06
  // +
  s.push({ path: line(at(x, y - h / 2), at(x + h * 0.7, y - h / 2)), duration: 0.22 })
  s.push({ path: line(at(x + h * 0.35, y - h * 0.85), at(x + h * 0.35, y - h * 0.15)), duration: 0.22 })
  x += 0.045
  // 3
  s.push({ path: (u) => (u < 0.5 ? arc(at(x + 0.008, y - 0.75 * h), 0.009, h / 4, -Math.PI * 0.9, Math.PI / 2)(u / 0.5) : arc(at(x + 0.008, y - 0.25 * h), 0.01, h / 4, -Math.PI / 2, Math.PI * 0.9)((u - 0.5) / 0.5)), duration: 0.55 })
  x += 0.03
  xGlyph(x, h)
  x += 0.045
  // −
  s.push({ path: line(at(x, y - h / 2), at(x + h * 0.6, y - h / 2)), duration: 0.2 })
  x += 0.035
  // 5
  s.push({ path: polyline([at(x + 0.016, y - h), at(x, y - h), at(x, y - h * 0.55)]), duration: 0.3 })
  s.push({ path: arc(at(x + 0.007, y - h * 0.3), 0.011, h * 0.28, -Math.PI * 0.8, Math.PI * 0.85), duration: 0.35 })
  x += 0.035
  // =
  s.push({ path: line(at(x, y - h * 0.65), at(x + h * 0.6, y - h * 0.65)), duration: 0.2 })
  s.push({ path: line(at(x, y - h * 0.35), at(x + h * 0.6, y - h * 0.35)), duration: 0.2 })
  x += 0.035
  // 0
  s.push({ path: arc(at(x + 0.01, y - h / 2), 0.011, h / 2, -Math.PI / 2, 1.5 * Math.PI), duration: 0.5 })
  return s
}

const T = (t: Partial<GestureTiming> = {}): Partial<GestureTiming> => t

/** Hand moves around for `seconds`, fingers open or merely close together, never pinched. */
function repositionScript(seconds: number): ScriptFrame[] {
  const out: ScriptFrame[] = []
  const n = Math.round(seconds * fps)
  for (let i = 0; i < n; i++) {
    const u = i / n
    const pen = { x: 0.35 + 0.25 * Math.sin(u * 6.3), y: 0.5 + 0.12 * Math.sin(u * 9.1 + 1) }
    // Fingers drift between wide open and "close but not pinched" (0.38–0.42).
    const gap = 0.42 + 0.3 * Math.max(0, Math.sin(u * 17))
    out.push({ pen, gap, intendInk: false, mover: 'index' })
  }
  return out
}

/** A line, the hand drops out of view mid-stroke, comes back still pinched, then opens and writes a second line. */
function lossScript(): ScriptFrame[] {
  const out = W([{ path: line(at(0.3, 0.45), at(0.45, 0.45)), duration: 0.8 }], { carryOn: false })
  // Remove the release at the end of the first stroke: the hand vanishes while still pinched.
  while (out.length && !out[out.length - 1]!.intendInk) out.pop()
  const last = out[out.length - 1]!.pen
  for (let i = 0; i < Math.round(0.35 * fps); i++) out.push({ pen: last, gap: 0.16, intendInk: false, present: false })
  // Back in view, still pinched, moving: must NOT write (no connecting line).
  for (let i = 0; i < 8; i++) out.push({ pen: { x: last.x + 0.01 * i, y: last.y + 0.03 }, gap: 0.16, intendInk: false })
  const second = W([{ path: line(at(0.3, 0.55), at(0.45, 0.55)), duration: 0.8, approach: 0.3 }], { carryOn: false, lead: 0 })
  // Start the second segment from where the hand is.
  for (let i = 0; i < 4; i++) out.push({ pen: { x: last.x + 0.08, y: last.y + 0.03 }, gap: 0.75, intendInk: false })
  return [...out, ...second]
}

function shortStrokes(n: number, spacing: number, len: number, duration: number, approach: number, vertical: boolean): StrokeSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const x = 0.3 + i * spacing
    return vertical
      ? { path: line(at(x, 0.5 - len / 2), at(x, 0.5 + len / 2)), duration, approach }
      : { path: line(at(x, 0.5), at(x + len, 0.5)), duration, approach }
  })
}

const ORIENT = {
  r45: { pitch: 0, yaw: 45, roll: 0 },
  toward: { pitch: 70, yaw: 0, roll: 0 },
  sideways: { pitch: 0, yaw: 80, roll: 0 },
  tiltUp: { pitch: -35, yaw: 0, roll: 0 },
  tiltDown: { pitch: 35, yaw: 0, roll: 0 },
  rolled: { pitch: 15, yaw: 25, roll: 30 }
} satisfies Record<string, Orientation>

/** A relaxed, partial lift: the fingers open to 0.42 palm widths over 6 frames, slowly at first. */
const GENTLE: Partial<GestureTiming> = { open: 0.42, openFrames: 6, openEase: 'ease-in' }

export const SCENARIOS: Scenario[] = [
  // ── Writing ────────────────────────────────────────────────────────────
  {
    id: 'A-slow-line',
    title: 'Slow horizontal line',
    group: 'writing',
    build: (seed) => synthesize(W([{ path: line(at(0.3, 0.5), at(0.65, 0.5)), duration: 3 }], T({ carryOn: false })), { seed })
  },
  {
    id: 'A3-fast-line',
    title: 'Fast horizontal line',
    group: 'writing',
    build: (seed) => synthesize(W([{ path: line(at(0.3, 0.5), at(0.65, 0.5)), duration: 0.45 }]), { seed })
  },
  {
    id: 'A2-slow-vertical',
    title: 'Slow vertical line',
    group: 'writing',
    build: (seed) => synthesize(W([{ path: line(at(0.45, 0.38), at(0.45, 0.62)), duration: 2.5 }], T({ carryOn: false })), { seed })
  },
  {
    id: 'G-circle',
    title: 'Circle',
    group: 'writing',
    build: (seed) => synthesize(W([{ path: arc(at(0.45, 0.5), 0.05, 0.05, -Math.PI / 2, 1.5 * Math.PI), duration: 1.6 }]), { seed })
  },
  {
    id: 'H-small-loops',
    title: 'Small loops (cursive e/l)',
    group: 'writing',
    build: (seed) =>
      synthesize(
        W([
          {
            path: (u) => {
              const k = u * 4
              const i = Math.min(3, Math.floor(k))
              const f = k - i
              const c = at(0.33 + i * 0.03, 0.5)
              const a = Math.PI / 2 + f * 2 * Math.PI
              return { x: c.x + 0.012 * Math.cos(a) + 0.03 * f, y: c.y - 0.012 + 0.012 * Math.sin(a) }
            },
            duration: 2.4
          }
        ]),
        { seed }
      )
  },
  {
    id: 'B-hello',
    title: '"Hello" letters',
    group: 'writing',
    build: (seed) => synthesize(W(helloStrokes()), { seed })
  },
  {
    id: 'C-math',
    title: 'x² + 3x − 5 = 0',
    group: 'writing',
    build: (seed) => synthesize(W(mathStrokes()), { seed })
  },
  {
    id: 'F-repeated',
    title: 'Repeated short strokes',
    group: 'writing',
    build: (seed) => synthesize(W(shortStrokes(6, 0.05, 0.06, 0.25, 0.2, true).map((s, i) => ({ ...s, path: line(at(0.3 + i * 0.05, 0.47), at(0.33 + i * 0.05, 0.53)) })), T({ openFrames: 3 })), { seed })
  },
  {
    id: 'F2-fast-ticks',
    title: 'Fast vertical ticks (tight)',
    group: 'writing',
    build: (seed) => synthesize(W(shortStrokes(8, 0.025, 0.03, 0.15, 0.12, true), T({ openFrames: 2, closeFrames: 2 })), { seed })
  },
  {
    id: 'F3-dashes',
    title: 'Horizontal dashes',
    group: 'writing',
    build: (seed) => synthesize(W(shortStrokes(6, 0.045, 0.025, 0.18, 0.15, false), T({ openFrames: 2 })), { seed })
  },
  // ── Gentle lifts (v0.1.3): the fingers only begin to separate ──────────
  // The v0.1–v0.1.2 scripts open the pinch fully in 3 frames, which any
  // threshold catches at once. Real lifts reported in v0.1.2 webcam testing
  // were small and relaxed: open to ~0.4 palm widths, slowly at first.
  {
    id: 'P1-gentle-lift-line',
    title: 'Gentle lift: slow line',
    group: 'gesture',
    build: (seed) => synthesize(W([{ path: line(at(0.3, 0.5), at(0.65, 0.5)), duration: 2 }], GENTLE), { seed })
  },
  {
    id: 'P2-gentle-lift-hello',
    title: 'Gentle lift: "Hello"',
    group: 'gesture',
    build: (seed) => synthesize(W(helloStrokes(), GENTLE), { seed })
  },
  {
    id: 'P3-gentle-lift-short',
    title: 'Gentle lift: short strokes',
    group: 'gesture',
    build: (seed) => synthesize(W(shortStrokes(6, 0.05, 0.06, 0.3, 0.25, true).map((s, i) => ({ ...s, path: line(at(0.3 + i * 0.05, 0.47), at(0.33 + i * 0.05, 0.53)) })), GENTLE), { seed })
  },
  {
    id: 'P4-gentle-lift-toward',
    title: 'Gentle lift, fingers toward camera',
    group: 'orientation',
    build: (seed) => synthesize(posed(W(helloStrokes(), GENTLE), ORIENT.toward), { seed })
  },
  // ── Writing speed ─────────────────────────────────────────────────────
  {
    id: 'S2-hello-2x',
    title: '"Hello" at 2× speed',
    group: 'speed',
    build: (seed) => synthesize(W(faster(helloStrokes(), 2), T({ closeFrames: 2, openFrames: 2 })), { seed })
  },
  {
    id: 'S3-hello-3x',
    title: '"Hello" at 3× speed (brisk)',
    group: 'speed',
    build: (seed) => synthesize(W(faster(helloStrokes(), 3), T({ closeFrames: 2, openFrames: 2 })), { seed })
  },
  {
    id: 'S4-math-2x',
    title: 'Equation at 2× speed, quick lifts',
    group: 'speed',
    build: (seed) => synthesize(W(faster(mathStrokes(), 2), T({ closeFrames: 2, openFrames: 1 })), { seed })
  },
  // ── Gestures ──────────────────────────────────────────────────────────
  {
    id: 'D-rapid-release',
    title: 'Rapid pinch and release',
    group: 'gesture',
    build: (seed) => synthesize(W([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.35 }], T({ openFrames: 1, closeFrames: 1, carryOn: true })), { seed })
  },
  {
    id: 'D2-slow-release',
    title: 'Slow pinch and slow release',
    group: 'gesture',
    build: (seed) => synthesize(W([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.6 }], T({ closeFrames: 6, openFrames: 10, carryOn: true })), { seed })
  },
  {
    id: 'D3-repeated-pinch',
    title: 'Repeated pinch and release (dots)',
    group: 'gesture',
    build: (seed) => synthesize(W(shortStrokes(6, 0.04, 0.012, 0.12, 0.25, false), T({ closeFrames: 2, openFrames: 2 })), { seed })
  },
  {
    id: 'E-reposition',
    title: 'Repositioning, no pinch',
    group: 'gesture',
    build: (seed) => synthesize(repositionScript(6), { seed })
  },
  {
    id: 'L-tracking-loss',
    title: 'Tracking loss mid-stroke',
    group: 'gesture',
    build: (seed) => synthesize(lossScript(), { seed })
  },
  // ── Orientation and distance ──────────────────────────────────────────
  ...(
    [
      ['O1-facing', 'Palm facing camera', FACING, 0.45],
      ['O2-rot45', 'Hand rotated 45°', ORIENT.r45, 0.45],
      ['O3-toward', 'Fingers toward camera', ORIENT.toward, 0.45],
      ['O4-sideways', 'Hand sideways', ORIENT.sideways, 0.45],
      ['O5-tilt-up', 'Hand tilted up', ORIENT.tiltUp, 0.45],
      ['O6-tilt-down', 'Hand tilted down', ORIENT.tiltDown, 0.45],
      ['O7-rolled', 'Mixed rotation', ORIENT.rolled, 0.45],
      ['O8-near', 'Close to camera (30 cm)', FACING, 0.3],
      ['O9-far', 'Far from camera (70 cm)', FACING, 0.7]
    ] as Array<[string, string, Orientation, number]>
  ).map(([id, title, o, depth]) => ({
    id,
    title: `${title}: "Hello"`,
    group: 'orientation',
    build: (seed: number) => synthesize(posed(W(helloStrokes()), o, depth), { seed })
  })),
  {
    id: 'O10-reposition-toward',
    title: 'Fingers toward camera, repositioning',
    group: 'orientation',
    build: (seed) => synthesize(posed(repositionScript(5), ORIENT.toward), { seed })
  }
]
