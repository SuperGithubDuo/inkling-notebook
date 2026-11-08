/**
 * Synthetic scenarios matching the real-webcam acceptance tests (A–F).
 * Coordinates are camera space (videoAspect 1); the default writing region
 * maps roughly x 0.18–0.82, y 0.3–0.7 to the page.
 */
import { DEFAULT_NOISE, arc, line, polyline, synthesize as synth0, writeStrokes, type GestureTiming, type NoiseModel, type StrokeSpec, type SynthResult } from './synth'

/** Noise multiplier for all scenarios (1 = the default model). Set by `npm run replay -- --noise 2.5`. */
let noiseScale = 1
export function setNoiseScale(k: number): void {
  noiseScale = Number.isFinite(k) && k >= 0 ? k : 1
}
function scaled(): NoiseModel {
  const n = DEFAULT_NOISE
  return { ...n, tipWhite: n.tipWhite * noiseScale, tipWobble: n.tipWobble * noiseScale, handWobble: n.handWobble * noiseScale, zWhite: n.zWhite * noiseScale }
}
const synthesize: typeof synth0 = (script, opts = {}) => synth0(script, { noise: scaled(), ...opts })

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

export const SCENARIOS: Scenario[] = [
  {
    id: 'A-slow-line',
    title: 'A · slow horizontal line',
    build: (seed) => synthesize(writeStrokes([{ path: line(at(0.3, 0.5), at(0.65, 0.5)), duration: 3 }], T({ carryOn: false })), { seed })
  },
  {
    id: 'B-hello',
    title: 'B · "Hello" letters',
    build: (seed) => synthesize(writeStrokes(helloStrokes()), { seed })
  },
  {
    id: 'C-math',
    title: 'C · x² + 3x − 5 = 0',
    build: (seed) => synthesize(writeStrokes(mathStrokes()), { seed })
  },
  {
    id: 'D-rapid-release',
    title: 'D · short line, rapid release',
    build: (seed) =>
      synthesize(writeStrokes([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.35 }], T({ openFrames: 2, carryOn: true })), { seed })
  },
  {
    id: 'D2-slow-release',
    title: 'D · short line, slow release while moving on',
    build: (seed) =>
      synthesize(writeStrokes([{ path: line(at(0.4, 0.5), at(0.48, 0.5)), duration: 0.35 }], T({ openFrames: 8, carryOn: true })), { seed })
  },
  {
    id: 'F-repeated',
    title: 'F · repeated short strokes',
    build: (seed) =>
      synthesize(
        writeStrokes(
          Array.from({ length: 6 }, (_, i) => ({ path: line(at(0.3 + i * 0.05, 0.47), at(0.33 + i * 0.05, 0.53)), duration: 0.25, approach: 0.2 })),
          T({ openFrames: 3 })
        ),
        { seed }
      )
  }
]
