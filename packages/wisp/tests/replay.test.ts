/**
 * Replay-harness regression tests: synthetic landmark traces with known
 * intended strokes, run through the real webcam pipeline. These guard the
 * v0.1.1/v0.1.2 handwriting-quality fixes against regressions. They use
 * MODELLED noise ("model" = gentle Gaussian, "webcam" = harsher MediaPipe-like
 * profile), so they prove the logic, not real-webcam quality.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { replay, score, truthStrokes, wobble } from '../src/replay/replay'
import { SCENARIOS, setNoiseProfile, setNoiseScale } from '../src/replay/scenarios'
import { NO_NOISE, line, synthesize, writeStrokes } from '../src/replay/synth'
import { packLandmarks, parseTrace, TraceRecorder, unpackLandmarks } from '../src/replay/trace'
import { fakeHand } from './helpers'

const PX = 1 / 1600 // one pixel on the default 1600-px page
const run = (id: string, seed = 1) => {
  const sc = SCENARIOS.find((s) => s.id === id)!
  const { trace, truth } = sc.build(seed)
  const r = replay(trace)
  return { r, s: score(r, truthStrokes(truth, r.config, trace.videoAspect)) }
}

describe('acceptance-test scenarios — gentle "model" noise (strict bounds)', () => {
  beforeAll(() => {
    setNoiseScale(1)
    setNoiseProfile('model')
  })
  for (const id of SCENARIOS.map((s) => s.id)) {
    it(`${id}: one stroke per intended stroke (no breaks, no accidental connections)`, () => {
      for (let seed = 1; seed <= 3; seed++) {
        const { s } = run(id, seed)
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
    for (const id of ['F-repeated', 'F2-fast-ticks', 'F3-dashes']) {
      const { s } = run(id)
      // Missed ink per stroke stays under ~8 px on average.
      expect(s.missing / s.expected).toBeLessThan(8 * PX)
    }
  })

  it('D: rapid and slow releases leave almost no tail', () => {
    expect(run('D-rapid-release').s.tail).toBeLessThan(8 * PX)
    expect(run('D2-slow-release').s.tail).toBeLessThan(12 * PX)
  })

  it('C: small symbols survive (shape error under 8 px)', () => {
    expect(run('C-math').s.shapeError).toBeLessThan(8 * PX)
  })

  it('midpoint pen beats the index tip on stray ink', () => {
    const sc = SCENARIOS.find((s) => s.id === 'C-math')!
    const { trace, truth } = sc.build(1)
    const mid = replay(trace, { processor: { penPoint: 'midpoint' } })
    const idx = replay(trace, { processor: { penPoint: 'index' } })
    const sm = score(mid, truthStrokes(truth, mid.config, 1))
    const si = score(idx, truthStrokes(truth, idx.config, 1))
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

  it('stroke counts stay within one of the intended count across all scenarios', () => {
    for (const sc of SCENARIOS) {
      for (let seed = 1; seed <= 3; seed++) {
        const { s } = run(sc.id, seed)
        expect(Math.abs(s.strokes - s.expected)).toBeLessThanOrEqual(1)
      }
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
    const s = score(r, truthStrokes(truth, r.config, 1))
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
