/** Unit tests for the WISP v0.1.2 mechanisms. */
import { describe, expect, it } from 'vitest'
import { GestureStateMachine, type GestureAction } from '../src/gestures/gestureState'
import { DEFAULT_PINCH } from '../src/gestures/pinchDetector'
import { rng } from '../src/replay/synth'
import { TraceRecorder, parseTrace } from '../src/replay/trace'
import { NoiseEstimator, OneEuroFilter, despike, noiseFromSecondDiff, oneEuroForStrength, refineNoiseMatched, whittaker } from '../src/strokes/smoothing'
import { StrokeEngine } from '../src/strokes/strokeEngine'
import { DEFAULT_DEPTH_WEIGHT, pinchRatio } from '../src/tracking/landmarks'
import { fakeHand, frames, hand } from './helpers'

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r())
const PX = 1 / 1600

describe('Whittaker smoother (banded solver)', () => {
  it('matches the analytic behaviour: λ→0 returns the data, a straight line is unchanged', () => {
    const y = [0, 1, 4, 9, 16, 25]
    whittaker(y, 1e-9).forEach((v, i) => expect(v).toBeCloseTo(y[i]!, 6))
    const lineY = [1, 3, 5, 7, 9, 11, 13]
    whittaker(lineY, 50).forEach((v, i) => expect(v).toBeCloseTo(lineY[i]!, 9))
  })

  it('removes alternating noise strongly', () => {
    const y = Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : -1))
    const z = whittaker(y, 10)
    expect(Math.max(...z.slice(3, -3).map(Math.abs))).toBeLessThan(0.05)
  })
})

describe('glitch removal and noise estimation', () => {
  it('despike replaces a one-frame glitch and leaves smooth motion alone', () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ x: 0.3 + i * 0.01, y: 0.5 }))
    pts[6] = { x: pts[6]!.x, y: 0.55 } // 80-px glitch
    const d = despike(pts, 0.006)
    expect(d[6]!.y).toBeCloseTo(0.5, 6)
    d.forEach((p, i) => i !== 6 && expect(p).toEqual(pts[i]))
  })

  it('second-difference noise estimate recovers the true σ on a moving line', () => {
    const r = rng(3)
    const sigma = 0.003
    const pts = Array.from({ length: 400 }, (_, i) => ({ x: i * 0.002 + sigma * gauss(r), y: 0.5 + sigma * gauss(r) }))
    expect(noiseFromSecondDiff(pts)!).toBeGreaterThan(sigma * 0.8)
    expect(noiseFromSecondDiff(pts)!).toBeLessThan(sigma * 1.2)
  })

  it('NoiseEstimator learns σ online from slow movement', () => {
    const r = rng(5)
    const est = new NoiseEstimator(0.01)
    for (let i = 0; i < 300; i++) est.add({ x: 0.5 + 0.002 * gauss(r), y: 0.5 + 0.002 * gauss(r) }, i * 33)
    expect(est.sigma).toBeGreaterThan(0.0015)
    expect(est.sigma).toBeLessThan(0.0026)
  })
})

describe('noise-matched refinement', () => {
  const r = rng(11)
  const sigma = 0.004

  it('straightens a short noisy tick (5 samples) without shortening it', () => {
    let err0 = 0, err1 = 0
    for (let k = 0; k < 40; k++) {
      const truth = Array.from({ length: 5 }, (_, i) => ({ x: 0.5, y: 0.45 + i * 0.012 }))
      const noisy = truth.map((p) => ({ x: p.x + sigma * gauss(r), y: p.y + sigma * gauss(r) }))
      const out = refineNoiseMatched(noisy, sigma, { maxLambda: 11, spikeMin: 0.012 })
      noisy.forEach((p, i) => (err0 += Math.abs(p.x - truth[i]!.x)))
      out.forEach((p, i) => (err1 += Math.abs(p.x - truth[i]!.x)))
      expect(Math.abs(out.at(-1)!.y - out[0]!.y)).toBeGreaterThan(0.035) // still ~0.048 long
    }
    expect(err1).toBeLessThan(err0 * 0.8)
  })

  it('keeps a small loop round (does not flatten real curves)', () => {
    const loop = Array.from({ length: 24 }, (_, i) => ({ x: 0.5 + 0.012 * Math.cos((i / 24) * 2 * Math.PI), y: 0.5 + 0.012 * Math.sin((i / 24) * 2 * Math.PI) }))
    const out = refineNoiseMatched(loop, 0.001, { maxLambda: 11, spikeMin: 0.006 })
    const radii = out.map((p) => Math.hypot(p.x - 0.5, p.y - 0.5))
    expect(Math.min(...radii.slice(2, -2))).toBeGreaterThan(0.012 * 0.85)
  })

  it('a finished webcam stroke loses a single-frame glitch', () => {
    const e = new StrokeEngine({ stabilizer: 0 })
    for (let i = 0; i <= 14; i++) e.input({ x: 0.3 + i * 0.01, y: i === 7 ? 0.53 : 0.5, t: i * 33, source: 'webcam' }, true)
    const s = e.end('released')!
    expect(Math.max(...s.points.map((p) => Math.abs(p.y - 0.5)))).toBeLessThan(6 * PX)
  })
})

describe('noise-gated One Euro filter', () => {
  it('jitter does not loosen the filter when the noise gate is set', () => {
    const run = (gate: boolean) => {
      const r = rng(9)
      const f = new OneEuroFilter(oneEuroForStrength(0.5).params)
      if (gate) f.noiseSpeed = 200
      const out: number[] = []
      for (let i = 0; i < 200; i++) out.push(f.filter(500 + 4 * gauss(r), i * 33))
      const m = out.reduce((a, b) => a + b, 0) / out.length
      return Math.sqrt(out.reduce((a, b) => a + (b - m) ** 2, 0) / out.length)
    }
    expect(run(true)).toBeLessThan(run(false))
  })
})

describe('gesture changes (v0.1.2)', () => {
  const run = (m: GestureStateMachine, list: Parameters<typeof frames>[0], t0 = 0): GestureAction[] => frames(list, t0).flatMap((f) => m.update(f))
  const downs = (a: GestureAction[]) => a.filter((x) => x.type === 'sample' && x.sample.down)
  const endOf = (a: GestureAction[]) => a.find((x) => x.type === 'end') as Extract<GestureAction, { type: 'end' }> | undefined

  it('pen-down is slightly less sensitive and pen-up slightly more than v0.1.1', () => {
    expect(DEFAULT_PINCH.enter).toBeLessThan(0.3)
    expect(DEFAULT_PINCH.releaseRise).toBeLessThan(0.08)
    expect(DEFAULT_PINCH.openVelocity).toBeLessThan(2.0)
  })

  it('fingers drifting close together (no deliberate close) do not start ink', () => {
    const m = new GestureStateMachine()
    // Hover with fingers around 0.33–0.38, drifting down to 0.26 slowly: never closed from an open position.
    const list = [hand(0.38), hand(0.37), hand(0.36), hand(0.35), hand(0.34), hand(0.33), hand(0.31), hand(0.29), hand(0.27), hand(0.26), hand(0.26), hand(0.26)]
    expect(downs(run(m, list))).toHaveLength(0)
  })

  it('a one-frame tracking dropout while the pinch closes does not lose the stroke', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(0.75), hand(0.75), hand(0.75), hand(0.5), null, hand(0.16), hand(0.16), hand(0.16), hand(0.16)])
    expect(downs(a).length).toBeGreaterThan(0)
  })

  it('a long dropout before writing still resets (no stale pinch)', () => {
    const m = new GestureStateMachine({ lostGraceMs: 100 })
    run(m, [hand(0.75), hand(0.75), hand(0.75), hand(0.5), null, null, null, null, null])
    expect(m.state).toBe('no-hand')
  })

  it('quick release: the hinge fit keeps all ink up to the release (nothing trimmed)', () => {
    const m = new GestureStateMachine()
    const steady = Array.from({ length: 12 }, (_, i) => hand(i % 2 ? 0.2 : 0.13, 0.3 + i * 0.01))
    const a = run(m, [hand(0.75), hand(0.75), hand(0.75), ...steady, hand(0.6)])
    const e = endOf(a)!
    expect(e).toBeDefined()
    expect(e.trimAfter).toBe((3 + 12 - 1) * 33)
  })

  it('slow release: the hinge fit finds where the ramp began and trims after it', () => {
    const m = new GestureStateMachine()
    const steady = Array.from({ length: 12 }, (_, i) => hand(0.16, 0.3 + i * 0.01))
    const ramp = [0.2, 0.24, 0.28, 0.32, 0.36].map((r) => hand(r))
    const a = run(m, [hand(0.75), hand(0.75), hand(0.75), ...steady, ...ramp])
    const e = endOf(a)!
    expect(e).toBeDefined()
    const lastSteadyT = (3 + 12 - 1) * 33
    expect(e.trimAfter!).toBeGreaterThanOrEqual(lastSteadyT - 33)
    expect(e.trimAfter!).toBeLessThanOrEqual(lastSteadyT + 33)
  })
})

describe('pinch depth weight', () => {
  it('defaults to 0.25 and lowers the influence of fingertip depth noise', () => {
    expect(DEFAULT_DEPTH_WEIGHT).toBe(0.25)
    const lm = fakeHand(0.015)
    const noisy = lm.map((p, i) => (i === 8 ? { ...p, z: p.z + 0.03 } : p))
    const d25 = Math.abs(pinchRatio(noisy, 1)! - pinchRatio(lm, 1)!)
    const d50 = Math.abs(pinchRatio(noisy, 1, 0.5)! - pinchRatio(lm, 1, 0.5)!)
    expect(d25).toBeLessThan(d50)
  })
})

describe('trace v2 diagnostics', () => {
  it('records per-frame measurements, pen events and strokes, and still replays', () => {
    const rec = new TraceRecorder()
    rec.start()
    rec.add(10, fakeHand(0.1), 0.95, 16 / 9, { mid: [0.4, 0.5], cur: [0.41, 0.5], down: 0, r: 0.8, rs: 0.79, b: null, v: 0.1, s: 'hover' })
    rec.addEvent({ t: 20, type: 'pen-down' })
    rec.addStroke({ id: 's1', points: [{ x: 0.4, y: 0.5, t: 20 }], color: '#000000', width: 4, source: 'webcam', startedAt: 20, endedAt: 20 })
    rec.addEvent({ t: 30, type: 'pen-up', reason: 'released' })
    const t = rec.stop('note', { smoothing: 0.5 })
    expect(t.version).toBe(4) // v0.1.5 records trace v4 (a superset of v3)
    expect(t.frames[0]!.d).toMatchObject({ mid: [0.4, 0.5], s: 'hover', rs: 0.79 })
    expect(t.events).toHaveLength(2)
    expect(t.strokes).toHaveLength(1)
    const parsed = parseTrace(JSON.parse(JSON.stringify(t)))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.settings).toEqual({ smoothing: 0.5 })
  })
})
