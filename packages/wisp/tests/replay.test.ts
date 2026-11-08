/**
 * Replay-harness regression tests: synthetic landmark traces with known
 * intended strokes, run through the real webcam pipeline. These guard the
 * v0.1.1/v0.1.2 handwriting-quality fixes against regressions. They use
 * MODELLED noise ("model" = gentle Gaussian, "webcam" = harsher MediaPipe-like
 * profile), so they prove the logic, not real-webcam quality.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { replay, score, truthStrokes, type ReplayConfig, wobble } from '../src/replay/replay'
import { SCENARIOS, setNoiseProfile, setNoiseScale } from '../src/replay/scenarios'
import { NO_NOISE, line, synthesize, writeStrokes } from '../src/replay/synth'
import { packLandmarks, parseTrace, TraceRecorder, unpackLandmarks } from '../src/replay/trace'
import { fakeHand } from './helpers'

const PX = 1 / 1600 // one pixel on the default 1600-px page
const run = (id: string, seed = 1, cfg?: ReplayConfig) => {
  const sc = SCENARIOS.find((s) => s.id === id)!
  const { trace, truth } = sc.build(seed)
  const r = replay(trace, cfg)
  return { r, s: score(r, truthStrokes(truth, r.config, trace.videoAspect)) }
}

describe('acceptance-test scenarios — gentle "model" noise (strict bounds)', () => {
  beforeAll(() => {
    setNoiseScale(1)
    setNoiseProfile('model')
  })
  // Orientation scenarios (fingers toward the camera etc.) are a known v0.1.2
  // limitation of the default 2D pinch, which v0.1.4 deliberately keeps (it
  // works on the user's real webcam). They must pass with the opt-in 'auto'
  // 3D measurement instead.
  const turned = (id: string) => SCENARIOS.find((s) => s.id === id)!.group === 'orientation'
  for (const id of SCENARIOS.map((s) => s.id)) {
    it(`${id}: one stroke per intended stroke (no breaks, no accidental connections)${turned(id) ? " — with pinchMetric 'auto'" : ''}`, () => {
      for (let seed = 1; seed <= 3; seed++) {
        const { s } = run(id, seed, turned(id) ? { processor: { pinchMetric: 'auto' } } : undefined)
        expect(s.strokes).toBe(s.expected)
      }
    })
  }

  it('A: a slow straight line has sub-pixel wobble', () => {
    const { s } = run('A-slow-line')
    expect(s.wobble).toBeLessThan(0.5 * PX)
  })

  it('release tails stay small: under 8 px per stroke (v0.1 had up to ~25 px per stroke)', () => {
    for (const id of ['B-hello', 'C-math', 'F-repeated', 'F2-fast-ticks', 'F3-dashes']) {
      const { s } = run(id)
      expect(s.tail / s.expected).toBeLessThan(8 * PX)
    }
  })

  it('repeated short strokes keep their ink (no over-trimming)', () => {
    // v0.1.3: the synthetic hand is now a projected 3D model on 16:9 video, so
    // the same scripts give longer strokes on the page (e.g. F-repeated 256 px,
    // F3-dashes 64 px) than the old 2D model did; v0.1.2's code misses
    // 41 / 23 px per stroke on these new traces. The bound is therefore
    // relative to stroke length (and averaged over seeds) instead of 8 px.
    // Known limit (both versions): 64-px dashes drawn in 0.18 s lose about a
    // third — roughly one frame of motion at each end (pen-down settle and
    // pen-up trim) — so F3 has a looser bound.
    const bound: Record<string, number> = { 'F-repeated': 0.2, 'F2-fast-ticks': 0.2, 'F3-dashes': 0.4 }
    for (const id of ['F-repeated', 'F2-fast-ticks', 'F3-dashes']) {
      let missing = 0
      let length = 0
      for (let seed = 1; seed <= 3; seed++) {
        const { r, s } = run(id, seed)
        const sc = SCENARIOS.find((x) => x.id === id)!
        const { trace, truth } = sc.build(seed)
        for (const t of truthStrokes(truth, r.config, trace.videoAspect)) length += t.path.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - t.path[i]!.x, p.y - t.path[i]!.y), 0)
        missing += s.missing
      }
      expect(missing / length).toBeLessThan(bound[id]!)
    }
  })

  it('D: rapid and slow releases leave almost no tail', () => {
    expect(run('D-rapid-release').s.tail).toBeLessThan(8 * PX)
    // 16 px: v0.1.2's linear release-onset fit on the 3D-model traces (it was
    // under 12 px on the old 2D model; the opt-in quadratic fit gets ~10 px).
    expect(run('D2-slow-release').s.tail).toBeLessThan(16 * PX)
  })

  it('C: small symbols survive (shape error under 8 px)', () => {
    expect(run('C-math').s.shapeError).toBeLessThan(8 * PX)
  })

  it('midpoint pen beats the index tip on stray ink', () => {
    const sc = SCENARIOS.find((s) => s.id === 'C-math')!
    const { trace, truth } = sc.build(1)
    const mid = replay(trace, { processor: { penPoint: 'midpoint' } })
    const idx = replay(trace, { processor: { penPoint: 'index' } })
    const sm = score(mid, truthStrokes(truth, mid.config, trace.videoAspect))
    const si = score(idx, truthStrokes(truth, idx.config, trace.videoAspect))
    expect(sm.excess).toBeLessThan(si.excess)
  })
})

describe('acceptance-test scenarios — harsher "webcam" noise (robustness bounds)', () => {
  beforeAll(() => {
    setNoiseScale(1)
    setNoiseProfile('webcam')
  })
  afterAll(() => setNoiseProfile('model'))

  it('no accidental strokes while repositioning without a pinch', () => {
    for (let seed = 1; seed <= 4; seed++) expect(run('E-reposition', seed).s.strokes).toBe(0)
  })

  it('stroke counts stay close to the intended count across all scenarios', () => {
    // v0.1.3: averaged over 5 seeds (the 3D model draws its random numbers in a
    // different order, and with 3 seeds one unlucky glitch placement decided the
    // test — v0.1.2's code fails the old per-seed form on the new traces too).
    for (const sc of SCENARIOS) {
      let dev = 0
      for (let seed = 1; seed <= 5; seed++) {
        const { s } = run(sc.id, seed, sc.group === 'orientation' ? { processor: { pinchMetric: 'auto' } } : undefined)
        expect(Math.abs(s.strokes - s.expected)).toBeLessThanOrEqual(3)
        dev += Math.abs(s.strokes - s.expected) / 5
      }
      expect(dev).toBeLessThanOrEqual(1)
    }
  })

  it('tracking loss ends the stroke cleanly (no connecting line, no stray ink between)', () => {
    for (let seed = 1; seed <= 4; seed++) expect(run('L-tracking-loss', seed).s.unintended).toBe(0)
  })

  it('finished strokes have sub-pixel jitter even under webcam-like noise', () => {
    for (const id of ['A-slow-line', 'G-circle', 'B-hello']) expect(run(id).s.wobble).toBeLessThan(0.3 * PX)
  })
})

describe('noise-free sanity', () => {
  it('a noiseless line comes out straight and complete', () => {
    const { trace, truth } = synthesize(writeStrokes([{ path: line({ x: 0.3, y: 0.5 }, { x: 0.6, y: 0.5 }), duration: 1 }], { carryOn: false, mover: 'both' }), { noise: NO_NOISE })
    const r = replay(trace)
    const s = score(r, truthStrokes(truth, r.config, trace.videoAspect))
    expect(s.strokes).toBe(1)
    expect(s.wobble).toBeLessThan(0.05 * PX)
    expect(s.missing).toBeLessThan(10 * PX)
    expect(s.tail).toBe(0)
  })
})

describe('trace format', () => {
  it('packs/unpacks landmarks and records frames', () => {
    const lm = fakeHand(0.05)
    expect(unpackLandmarks(packLandmarks(lm))![8]!.x).toBeCloseTo(lm[8]!.x, 4)
    const rec = new TraceRecorder()
    rec.add(0, lm, 1, 1.5) // not recording: ignored
    rec.start()
    rec.add(10, lm, 0.9, 16 / 9)
    rec.add(43, null, 0, 16 / 9)
    const t = rec.stop('test')
    expect(t.frames).toHaveLength(2)
    expect(t.frames[1]!.lm).toBeNull()
    expect(parseTrace(JSON.parse(JSON.stringify(t))).frames).toHaveLength(2)
  })

  it('rejects non-trace files', () => {
    expect(() => parseTrace({ format: 'wisp.strokes' })).toThrow(/landmark trace/)
  })

  it('wobble ignores curvature (a clean circle has ~0 wobble)', () => {
    const circle = Array.from({ length: 200 }, (_, i) => ({ x: 0.5 + 0.05 * Math.cos(i / 20), y: 0.5 + 0.05 * Math.sin(i / 20) }))
    expect(wobble(circle)).toBeLessThan(0.01 * PX)
  })
})
