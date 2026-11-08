import { describe, expect, it } from 'vitest'
import { HandFrameProcessor, effectiveRegion, penPointOf } from '../src/input/handFrameProcessor'
import { StrokeEngine } from '../src/strokes/strokeEngine'
import type { WispEventMap } from '../src/integration/types'
import { fakeHand } from './helpers'

const cfg = { mirror: true, writingSensitivity: 1, pinchSensitivity: 1, penPoint: 'index' as const, region: null, pageAspect: 1.6 }
const OPEN_GAP = 0.1
const PINCH_GAP = 0.012

function setup() {
  const engine = new StrokeEngine({ smoothing: 0 })
  const proc = new HandFrameProcessor(engine, cfg)
  const ends: WispEventMap['strokeEnd'][] = []
  const lost: WispEventMap['trackingLost'][] = []
  const gestures: string[] = []
  engine.onStrokeEnd((e) => ends.push(e))
  engine.onTrackingLost((e) => lost.push(e))
  engine.onGestureChange((e) => gestures.push(e.to))
  let t = 0
  const frame = (gap: number | null, cx = 0.5, cy = 0.5) =>
    proc.process({ t: (t += 33), landmarks: gap === null ? null : fakeHand(gap, cx, cy), confidence: 0.95, videoAspect: 16 / 9 })
  return { engine, proc, ends, lost, gestures, frame }
}

describe('webcam path with synthetic landmarks (no camera)', () => {
  it('pinch → write → release produces exactly one stroke', () => {
    const { frame, ends, engine } = setup()
    for (let i = 0; i < 4; i++) frame(OPEN_GAP, 0.5)
    for (let i = 0; i < 10; i++) frame(PINCH_GAP, 0.45 + i * 0.01, 0.5)
    expect(engine.activeStroke).not.toBeNull()
    frame(OPEN_GAP, 0.56)
    frame(OPEN_GAP, 0.57)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.stroke.source).toBe('webcam')
    expect(ends[0]!.stroke.points.length).toBeGreaterThan(5)
  })

  it('mirroring: moving the hand left in the camera moves the ink right', () => {
    const { frame, ends } = setup()
    for (let i = 0; i < 4; i++) frame(OPEN_GAP, 0.6)
    for (let i = 0; i < 8; i++) frame(PINCH_GAP, 0.6 - i * 0.01)
    frame(OPEN_GAP)
    frame(OPEN_GAP)
    const pts = ends[0]!.stroke.points
    expect(pts.at(-1)!.x).toBeGreaterThan(pts[0]!.x)
  })

  it('hand leaving the view ends the stroke and reports tracking loss', () => {
    const { frame, ends, lost } = setup()
    for (let i = 0; i < 4; i++) frame(OPEN_GAP)
    for (let i = 0; i < 4; i++) frame(PINCH_GAP, 0.5 + i * 0.005)
    for (let i = 0; i < 10; i++) frame(null)
    expect(ends.map((e) => e.reason)).toEqual(['lost'])
    expect(lost).toHaveLength(1)
    expect(lost[0]!.endedStroke).toBe(true)
  })

  it('does not forward anything while calibrating (forward = false)', () => {
    const { frame, proc, engine } = setup()
    proc.forward = false
    for (let i = 0; i < 4; i++) frame(OPEN_GAP)
    for (let i = 0; i < 4; i++) frame(PINCH_GAP)
    expect(engine.activeStroke).toBeNull()
    expect(proc.gestures.state).toBe('writing')
  })

  it('reset() ends the active stroke (camera stopped mid-stroke)', () => {
    const { frame, proc, ends } = setup()
    for (let i = 0; i < 4; i++) frame(OPEN_GAP)
    for (let i = 0; i < 4; i++) frame(PINCH_GAP)
    proc.reset(1000)
    expect(ends).toHaveLength(1)
  })

  it('pen point modes and region sensitivity', () => {
    const lm = fakeHand(0.04)
    expect(penPointOf(lm, 'index')).toEqual({ x: lm[8]!.x, y: lm[8]!.y })
    expect(penPointOf(lm, 'pinch').x).toBeCloseTo((lm[8]!.x + lm[4]!.x) / 2)
    const a = effectiveRegion(cfg, 16 / 9)
    const b = effectiveRegion({ ...cfg, writingSensitivity: 2 }, 16 / 9)
    expect(b.x1 - b.x0).toBeCloseTo((a.x1 - a.x0) / 2)
  })
})
