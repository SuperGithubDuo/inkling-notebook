/**
 * Synthetic scenarios matching the real-webcam acceptance tests (A–F).
 * Coordinates are camera space (videoAspect 1); the default writing region
 * maps roughly x 0.18–0.82, y 0.3–0.7 to the page.
 */
import { DEFAULT_NOISE, WEBCAM_NOISE, arc, line, polyline, synthesize as synth0, writeStrokes, type GestureTiming, type NoiseModel, type ScriptFrame, type StrokeSpec, type SynthResult } from './synth'

/** Noise multiplier for all scenarios (1 = the profile as defined). Set by `npm run replay -- --noise 2.5`. */
let noiseScale = 1
/** 'webcam' (default since v0.1.2): harsher, MediaPipe-like; 'model': the v0.1.1 Gaussian model. */
export type NoiseProfile = 'webcam' | 'model'
let profile: NoiseProfile = 'webcam'
let fps = 30
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
    glitchSize: (n.glitchSize ?? 0) * Math.min(noiseScale, 2)
  }
}
const synthesize: typeof synth0 = (script, opts = {}) => synth0(script, { noise: scaled(), fps, ...opts })
const W = (strokes: StrokeSpec[], t: Partial<GestureTiming> = {}): ScriptFrame[] => writeStrokes(strokes, t, fps)

export interface Scenario {
  id: string
  title: string
  build(seed: number): SynthResult
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

export const SCENARIOS: Scenario[] = [
  {
    id: 'A-slow-line',
    title: 'Slow horizontal line',
    build: (seed) => synthesize(W([{ path: line(at(0.3, 0.5), at(0.65, 0.5)), duration: 3 }], T({ carryOn: false })), { seed })
  },
  {
    id: 'A2-slow-vertical',
    title: 'Slow vertical line',
    build: (seed) => synthesize(W([{ path: line(at(0.45, 0.36), at(0.45, 0.64)), duration: 2.5 }], T({ carryOn: false })), { seed })
  },
  {
    id: 'G-circle',
    title: 'Circle',
    build: (seed) => synthesize(W([{ path: arc(at(0.45, 0.5), 0.05, 0.05, -Math.PI / 2, 1.5 * Math.PI), duration: 1.6 }]), { seed })
  },
  {
    id: 'H-small-loops',
    title: 'Small loops (cursive e/l)',
    build: (seed) =>
      synthesize(
        W([
          {
            path: (u) => {
              // Four small loops along a baseline, drawn as one stroke.
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
    build: (seed) => synthesize(W(helloStrokes()), { seed })
  },
  {
    id: 'C-math',
    title: 'x² + 3x − 5 = 0',
    build: (seed) => synthesize(W(mathStrokes()), { seed })
  },
  {
    id: 'F-repeated',
    title: 'Repeated short strokes',
    build: (seed) => synthesize(W(shortStrokes(6, 0.05, 0.06, 0.25, 0.2, true).map((s, i) => ({ ...s, path: line(at(0.3 + i * 0.05, 0.47), at(0.33 + i * 0.05, 0.53)) })), T({ openFrames: 3 })), { seed })
  },
  {
    id: 'F2-fast-ticks',
    title: 'Fast vertical ticks (tight)',
    build: (seed) => synthesize(W(shortStrokes(8, 0.025, 0.03, 0.15, 0.12, true), T({ openFrames: 2, closeFrames: 2 })), { seed })
  },
  {
    id: 'F3-dashes',
    title: 'Horizontal dashes',
    build: (seed) => synthesize(W(shortStrokes(6, 0.045, 0.025, 0.18, 0.15, false), T({ openFrames: 2 })), { seed })
  },
  {
    id: 'D-rapid-release',
    title: 'Rapid pinch and release',
    build: (seed) => synthesize(W([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.35 }], T({ openFrames: 1, closeFrames: 1, carryOn: true })), { seed })
  },
  {
    id: 'D2-slow-release',
    title: 'Slow pinch and slow release',
    build: (seed) => synthesize(W([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.6 }], T({ closeFrames: 6, openFrames: 10, carryOn: true })), { seed })
  },
  {
    id: 'E-reposition',
    title: 'Repositioning, no pinch',
    build: (seed) => synthesize(repositionScript(6), { seed })
  },
  {
    id: 'L-tracking-loss',
    title: 'Tracking loss mid-stroke',
    build: (seed) => synthesize(lossScript(), { seed })
  }
]
