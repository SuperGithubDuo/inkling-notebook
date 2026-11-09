/**
 * WISP v0.1.3 regression tests: orientation-aware (3D) pinch measurement,
 * early pen-up feedback, glitch-resistant release, faithful fast writing,
 * trace v3. Synthetic only — these prove the logic on MODELLED input, not
 * real-webcam accuracy.
 *
 * Since v0.1.4 the gesture features here are opt-in (v0.1.2's behaviour is
 * the default), so the tests enable them explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GestureStateMachine, type GestureAction } from '../src/gestures/gestureState'
import { HandFrameProcessor, blendWeight3D } from '../src/input/handFrameProcessor'
import { cameraHand, imageLandmarks, worldLandmarks, VIDEO_ASPECT, type Orientation } from '../src/replay/hand3d'
import { REPLAY_PROCESSOR, replay, score, truthStrokes } from '../src/replay/replay'
import { SCENARIOS, setNoiseProfile, setNoiseScale } from '../src/replay/scenarios'
import { parseTrace, TraceRecorder } from '../src/replay/trace'
import { sanitizeSettings } from '../src/core/settings'
import { NoiseEstimator, refineNoiseMatched } from '../src/strokes/smoothing'
import { StrokeEngine } from '../src/strokes/strokeEngine'
import { handPose, pinchRatio, pinchRatio3D } from '../src/tracking/landmarks'

const ORIENT: Record<string, Orientation> = {
  facing: { pitch: 0, yaw: 0, roll: 0 },
  r45: { pitch: 0, yaw: 45, roll: 0 },
  toward: { pitch: 70, yaw: 0, roll: 0 },
  sideways: { pitch: 0, yaw: 80, roll: 0 },
  tiltUp: { pitch: -35, yaw: 0, roll: 0 }
}
const pose = (o: Orientation, gap: number) => cameraHand({ pen: { x: 0.5, y: 0.5 }, depth: 0.45, gap, mover: 'index', orientation: o })

describe('3D pinch ratio and hand orientation', () => {
  it('the 3D ratio is the same in every orientation; the 2D ratio is foreshortened', () => {
    const r3 = Object.values(ORIENT).map((o) => pinchRatio3D(worldLandmarks(pose(o, 0.6)))!)
    const r2 = Object.values(ORIENT).map((o) => pinchRatio(imageLandmarks(pose(o, 0.6)), VIDEO_ASPECT)!)
    expect(Math.max(...r3) - Math.min(...r3)).toBeLessThan(0.01)
    expect(Math.max(...r2) - Math.min(...r2)).toBeGreaterThan(0.15)
  })

  it('rejects unusable world landmarks (missing, non-finite, impossible palm size)', () => {
    expect(pinchRatio3D(null)).toBeNull()
    const w = worldLandmarks(pose(ORIENT.facing!, 0.2))
    expect(pinchRatio3D(w.map((p) => ({ x: p.x * 10, y: p.y * 10, z: p.z * 10 })))).toBeNull()
    expect(pinchRatio3D(w.map((p, i) => (i === 4 ? { x: NaN, y: p.y, z: p.z } : p)))).toBeNull()
  })

  it('reports tracking quality from the hand-local frame', () => {
    expect(handPose(worldLandmarks(pose(ORIENT.facing!, 0.1)))!.quality).toBe('good')
    expect(handPose(worldLandmarks(pose(ORIENT.toward!, 0.1)))!.quality).toBe('poor')
    expect(handPose(null)).toBeNull()
  })

  it("'auto' uses 2D for a facing hand and shifts to 3D as the fingers point at the camera", () => {
    expect(blendWeight3D(handPose(worldLandmarks(pose(ORIENT.facing!, 0.1))))).toBe(0)
    expect(blendWeight3D(handPose(worldLandmarks(pose(ORIENT.toward!, 0.1))))).toBe(1)
    expect(blendWeight3D(null)).toBe(0)
  })

  it('falls back to the 2D ratio when a frame has no world landmarks (v1/v2 traces)', () => {
    const engine = new StrokeEngine()
    const proc = new HandFrameProcessor(engine, { ...REPLAY_PROCESSOR, pinchMetric: '3d' })
    const cam = pose(ORIENT.toward!, 0.6)
    const out2 = proc.process({ t: 0, landmarks: imageLandmarks(cam), world: null, confidence: 1, videoAspect: VIDEO_ASPECT })
    expect(out2.rawRatio).toBeCloseTo(out2.ratio2D!, 6)
    const out3 = proc.process({ t: 33, landmarks: imageLandmarks(cam), world: worldLandmarks(cam), confidence: 1, videoAspect: VIDEO_ASPECT })
    expect(out3.rawRatio).toBeCloseTo(out3.ratio3D!, 6)
    expect(out3.pose?.quality).toBe('poor')
  })
})

// ── Gesture timing ─────────────────────────────────────────────────────────
/** The v0.1.3 gesture options (off by default since v0.1.4). */
const V013 = { suspectFraction: 0.5, confirmRawJump: true, onsetShapes: [1, 2] }
const V013_REPLAY = { gesture: V013, processor: { pinchMetric: 'auto' as const } }
const hand = (r: number, x = 0.5) => ({ x, y: 0.5, pinchRatio: r, confidence: 1 })
/** Drives the state machine to 'writing' at ratio 0.15 with a clean signal. */
function writing(): { g: GestureStateMachine; t: number; feed: (r: number) => GestureAction[] } {
  const g = new GestureStateMachine({ initialNoise: 0.005, ...V013 })
  let t = 0
  const feed = (r: number) => g.update({ t: (t += 33), hand: hand(r, 0.3 + t / 10000) })
  for (let i = 0; i < 6; i++) feed(0.8)
  for (let i = 0; i < 25; i++) feed(0.15)
  expect(g.state).toBe('writing')
  return { g, t, feed }
}
const inked = (a: GestureAction[]) => a.filter((x) => x.type === 'sample' && x.sample.down).length
const ended = (a: GestureAction[]) => a.some((x) => x.type === 'end')

describe('early pen-up feedback (release suspect)', () => {
  it('pauses live ink on the first small opening, before the pen-up is decided', () => {
    const { feed } = writing()
    // Smoothed rise 0.6 × 0.065 = 0.039: over half of releaseRise (0.07), under the full threshold.
    const a = feed(0.15 + 0.065)
    expect(ended(a)).toBe(false)
    expect(inked(a)).toBe(0)
  })

  it('draws the held-back frames if the fingers settle again (no lost ink)', () => {
    const { feed } = writing()
    feed(0.215)
    const a = feed(0.15)
    expect(ended(a)).toBe(false)
    expect(inked(a)).toBe(2)
  })

  it('makes exactly the same pen-up decisions as without it (replay)', () => {
    setNoiseProfile('webcam')
    for (const id of ['B-hello', 'A-slow-line', 'P2-gentle-lift-hello']) {
      const { trace } = SCENARIOS.find((s) => s.id === id)!.build(2)
      const a = replay(trace, V013_REPLAY)
      const b = replay(trace, { ...V013_REPLAY, gesture: { ...V013, suspectFraction: 99 } })
      expect(a.endDecisions).toEqual(b.endDecisions)
    }
    setNoiseProfile('model')
  })

  it('removes most of the live tail on gentle lifts (replay, modelled noise)', () => {
    setNoiseProfile('webcam')
    let on = 0
    let off = 0
    for (let seed = 1; seed <= 4; seed++) {
      const { trace, truth } = SCENARIOS.find((s) => s.id === 'P2-gentle-lift-hello')!.build(seed)
      const a = replay(trace, V013_REPLAY)
      const b = replay(trace, { ...V013_REPLAY, gesture: { ...V013, suspectFraction: 99 } })
      on += score(a, truthStrokes(truth, a.config, trace.videoAspect)).liveTail
      off += score(b, truthStrokes(truth, b.config, trace.videoAspect)).liveTail
    }
    expect(on).toBeLessThan(off * 0.85)
    setNoiseProfile('model')
  })
})

describe('glitch-resistant release', () => {
  it('a one-frame landmark glitch does not end the stroke', () => {
    const { g, feed } = writing()
    // One-frame jump of 0.11: over the unsmoothed threshold (1.5 × 0.07), which
    // ended the stroke in v0.1.2, but its smoothed effect (0.066) is under 0.07.
    const a = feed(0.15 + 0.11)
    const b = feed(0.15)
    expect(ended(a) || ended(b)).toBe(false)
    expect(g.state).toBe('writing')
  })

  it('a real opening still ends it within two frames', () => {
    const { feed } = writing()
    const a = [...feed(0.29), ...feed(0.45)]
    expect(ended(a)).toBe(true)
  })

  it('a large, fast opening ends it on the first frame', () => {
    const { feed } = writing()
    expect(ended(feed(0.7))).toBe(true)
  })
})

describe('release onset for slow-starting (ease-in) openings', () => {
  it('trims back to where the fingers began to open', () => {
    const { feed } = writing()
    const before = feed(0.15)
    void before
    // Last steady frame, then an ease-in opening: +0.004, +0.016, +0.036, +0.064 …
    const steadyT = (() => {
      let last = 0
      const a = feed(0.15)
      for (const x of a) if (x.type === 'sample') last = x.sample.t
      return last
    })()
    let end: GestureAction | undefined
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const acts = feed(0.15 + 0.004 * k * k * 2)
      end = acts.find((x) => x.type === 'end') ?? end
      if (end) break
    }
    expect(end && end.type === 'end' ? end.trimAfter : undefined).toBeLessThanOrEqual(steadyT + 34)
  })
})

describe('faithful fast writing (refinement)', () => {
  it('the robust noise level ignores the accelerations of fast writing', () => {
    const n = new NoiseEstimator()
    let s = 1
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * 0.0009 // σ ≈ 0.0005
    // Up-and-down strokes reversing every 5 frames (like writing "lll" quickly):
    // each reversal is a large second difference that is motion, not noise.
    let x = 0.5
    let dir = 1
    for (let i = 0; i < 300; i++) {
      if (i % 5 === 0) dir = -dir
      x += dir * 0.009
      n.add({ x: x + rnd(), y: 0.5 + rnd() }, i * 33)
    }
    expect(n.sigma).toBeGreaterThan(0.002) // v0.1.2 estimate: inflated by the reversals
    expect(n.robustSigma).toBeLessThan(0.0015) // within ~3× of the true 0.0005 (it is scaled ×1.5 on purpose)
  })

  it('does not flatten a 7-sample fast loop when the noise is small', () => {
    const loop = Array.from({ length: 7 }, (_, i) => {
      const a = (i / 6) * 2 * Math.PI
      return { x: 0.5 + 0.03 * Math.cos(a), y: 0.5 + 0.03 * Math.sin(a) }
    })
    const out = refineNoiseMatched(loop, 0.001, { maxLambda: 11, spikeMin: 0.006 })
    const maxDev = Math.max(...out.map((p, i) => Math.hypot(p.x - loop[i]!.x, p.y - loop[i]!.y)))
    expect(maxDev).toBeLessThan(0.006)
  })

  it('fast "Hello" keeps its shape under gentle noise (missing ink per stroke < 40 px; v0.1.2 ≈ 86 px)', () => {
    setNoiseProfile('model')
    for (let seed = 1; seed <= 3; seed++) {
      const { trace, truth } = SCENARIOS.find((s) => s.id === 'S3-hello-3x')!.build(seed)
      const r = replay(trace)
      const s = score(r, truthStrokes(truth, r.config, trace.videoAspect))
      expect((s.missing / s.expected) * 1600).toBeLessThan(40)
    }
  })
})

describe('orientation scenarios (modelled webcam noise, 3D model)', () => {
  beforeAll(() => {
    setNoiseScale(1)
    setNoiseProfile('webcam')
  })
  afterAll(() => setNoiseProfile('model'))

  it("repositioning with the fingers toward the camera draws nothing (opt-in 'auto' metric)", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const { trace, truth } = SCENARIOS.find((s) => s.id === 'O10-reposition-toward')!.build(seed)
      const r = replay(trace, V013_REPLAY)
      expect(score(r, truthStrokes(truth, r.config, trace.videoAspect)).strokes).toBe(0)
    }
  })

  it("'auto' has fewer broken, accidental and lost strokes than 2D when the fingers point at the camera", () => {
    let auto = 0
    let flat = 0
    for (let seed = 1; seed <= 4; seed++) {
      const { trace, truth } = SCENARIOS.find((s) => s.id === 'O3-toward')!.build(seed)
      for (const [metric, add] of [['auto', (v: number) => (auto += v)], ['2d', (v: number) => (flat += v)]] as const) {
        const r = replay(trace, { gesture: V013, processor: { pinchMetric: metric } })
        const s = score(r, truthStrokes(truth, r.config, trace.videoAspect))
        add(s.broken + s.unintended + s.lost)
      }
    }
    expect(auto).toBeLessThan(flat)
  })
})

describe('trace v3 and settings', () => {
  it('records world landmarks and v3 diagnostics, and parses them back', () => {
    const cam = pose(ORIENT.facing!, 0.2)
    const rec = new TraceRecorder()
    rec.start()
    rec.add(0, imageLandmarks(cam), 0.9, VIDEO_ASPECT, { r: 0.2, r2: 0.21, r3: 0.2, n: [0, 0, -1], q: 'good', dt: 33.3, inf: 9.12, age: 41.27 }, worldLandmarks(cam))
    const t = parseTrace(JSON.parse(JSON.stringify(rec.stop())))
    expect(t.version).toBe(4) // v0.1.5 records trace v4 (a superset of v3)
    expect(t.frames[0]!.w).toHaveLength(63)
    const raw = rec // recorder is reset after stop
    void raw
  })

  it('keeps v3 diagnostic fields when recording', () => {
    const cam = pose(ORIENT.facing!, 0.2)
    const rec = new TraceRecorder()
    rec.start()
    rec.add(0, imageLandmarks(cam), 0.9, VIDEO_ASPECT, { r2: 0.21, r3: 0.2, q: 'reduced', dt: 33.33, inf: 9.12, age: 41.27 }, worldLandmarks(cam))
    const d = rec.stop().frames[0]!.d!
    expect(d).toMatchObject({ r2: 0.21, r3: 0.2, q: 'reduced', dt: 33.3, inf: 9.1, age: 41.3 })
  })

  it('pinch measurement setting is validated and defaults to 2d (v0.1.2 behaviour)', () => {
    expect(sanitizeSettings({}).pinchMetric).toBe('2d')
    expect(sanitizeSettings({ pinchMetric: 'auto' }).pinchMetric).toBe('auto')
    expect(sanitizeSettings({ pinchMetric: 'bogus' }).pinchMetric).toBe('2d')
  })
})
