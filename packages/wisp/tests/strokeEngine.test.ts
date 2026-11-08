import { describe, expect, it } from 'vitest'
import { StrokeEngine, type RawSample } from '../src/strokes/strokeEngine'
import type { WispEventMap } from '../src/integration/types'

const S = (x: number, y: number, t: number): RawSample => ({ x, y, t, source: 'mouse' })

function record(e: StrokeEngine) {
  const log: Array<{ type: keyof WispEventMap; payload: unknown }> = []
  for (const type of ['strokeStart', 'strokeUpdate', 'strokeEnd', 'cursor'] as const) {
    e.events.on(type, (payload) => log.push({ type, payload }))
  }
  return log
}

describe('stroke engine', () => {
  it('creates a stroke on pen down and completes it on pen up', () => {
    const e = new StrokeEngine({ smoothing: 0 })
    const log = record(e)
    e.input(S(0.1, 0.1, 0), false)
    expect(e.activeStroke).toBeNull()
    e.input(S(0.1, 0.1, 10), true)
    expect(e.activeStroke).not.toBeNull()
    for (let i = 1; i <= 10; i++) e.input(S(0.1 + i * 0.01, 0.1, 10 + i * 16), true)
    e.input(S(0.2, 0.1, 200), false)
    const end = log.find((l) => l.type === 'strokeEnd')!.payload as WispEventMap['strokeEnd']
    expect(end.reason).toBe('released')
    expect(end.stroke.points.length).toBe(11)
    expect(end.stroke.points[0]).toMatchObject({ x: 0.1, y: 0.1 })
    expect(end.stroke.points.at(-1)!.x).toBeCloseTo(0.2)
    expect(end.stroke.source).toBe('mouse')
    expect(e.activeStroke).toBeNull()
    expect(log.filter((l) => l.type === 'strokeStart')).toHaveLength(1)
  })

  it('keeps stroke boundaries: two strokes, no shared points', () => {
    const e = new StrokeEngine({ smoothing: 0 })
    const done: WispEventMap['strokeEnd'][] = []
    e.onStrokeEnd((x) => done.push(x))
    e.input(S(0.1, 0.1, 0), true)
    e.input(S(0.2, 0.1, 16), true)
    e.input(S(0.2, 0.1, 32), false)
    e.input(S(0.6, 0.6, 48), false)
    e.input(S(0.6, 0.6, 64), true)
    e.input(S(0.7, 0.6, 80), true)
    e.end()
    expect(done).toHaveLength(2)
    expect(done[1]!.stroke.points[0]).toMatchObject({ x: 0.6, y: 0.6 })
    expect(done[0]!.stroke.id).not.toBe(done[1]!.stroke.id)
  })

  it('keeps raw and smoothed positions separately', () => {
    const e = new StrokeEngine({ smoothing: 0.8 })
    e.input(S(0.5, 0.5, 0), true)
    for (let i = 1; i < 20; i++) e.input(S(0.5 + (i % 2 ? 0.006 : -0.006) + i * 0.003, 0.5, i * 33), true)
    const s = e.end()!
    const differs = s.points.some((p) => p.raw && (p.raw.x !== p.x || p.raw.y !== p.y))
    expect(differs).toBe(true)
  })

  it('drops a tracking spike instead of drawing a line to it', () => {
    const e = new StrokeEngine({ smoothing: 0 })
    const W = (x: number, y: number, t: number): RawSample => ({ x, y, t, source: 'webcam' })
    e.input(W(0.3, 0.3, 0), true)
    e.input(W(0.31, 0.3, 33), true)
    e.input(W(0.95, 0.95, 66), true) // spike
    e.input(W(0.32, 0.3, 99), true)
    const s = e.end()!
    expect(s.points.every((p) => p.x < 0.4)).toBe(true)
    expect(e.stats.rejected).toBe(1)
  })

  it('splits the stroke on a confirmed jump (no accidental connecting line)', () => {
    const e = new StrokeEngine({ smoothing: 0, refine: false })
    const ends: WispEventMap['strokeEnd'][] = []
    const W = (x: number, y: number, t: number): RawSample => ({ x, y, t, source: 'webcam' })
    e.onStrokeEnd((x) => ends.push(x))
    e.input(W(0.2, 0.2, 0), true)
    e.input(W(0.21, 0.2, 33), true)
    e.input(W(0.8, 0.8, 66), true)
    e.input(W(0.81, 0.8, 99), true)
    e.input(W(0.82, 0.8, 132), true)
    e.end()
    expect(ends.map((x) => x.reason)).toEqual(['discontinuity', 'released'])
    expect(ends[0]!.stroke.points.every((p) => p.x < 0.3)).toBe(true)
    expect(ends[1]!.stroke.points.every((p) => p.x > 0.7)).toBe(true)
  })

  it('stores fewer points than samples for tiny movements, but keeps the end point', () => {
    const e = new StrokeEngine({ smoothing: 0, minPointDistance: 0.01 })
    e.input(S(0.5, 0.5, 0), true)
    for (let i = 1; i <= 20; i++) e.input(S(0.5 + i * 0.0005, 0.5, i * 16), true)
    const s = e.end()!
    expect(s.points.length).toBeLessThan(5)
    expect(s.points.at(-1)!.x).toBeCloseTo(0.51, 6)
  })

  it('a tap makes a single-point stroke (dots for i and j)', () => {
    const e = new StrokeEngine()
    e.input(S(0.4, 0.4, 0), true)
    const s = e.end()!
    expect(s.points).toHaveLength(1)
  })

  it('ignores invalid samples', () => {
    const e = new StrokeEngine()
    e.input(S(Number.NaN, 0.5, 0), true)
    expect(e.activeStroke).toBeNull()
    e.input(S(0.5, 0.5, 1), true)
    e.input({ x: 0.6, y: Infinity, t: 2, source: 'mouse' }, true)
    expect(e.activeStroke!.points).toHaveLength(1)
  })

  it('clamps out-of-page input into the page', () => {
    const e = new StrokeEngine({ smoothing: 0 })
    e.input(S(1.4, -0.2, 0), true)
    expect(e.activeStroke!.points[0]).toMatchObject({ x: 1, y: 0 })
  })

  it('style changes apply to the next stroke only', () => {
    const e = new StrokeEngine()
    e.input(S(0.1, 0.1, 0), true)
    e.setStyle({ color: '#ff0000', width: 9 })
    const a = e.end()!
    e.input(S(0.2, 0.2, 50), true)
    const b = e.end()!
    expect(a.color).not.toBe('#ff0000')
    expect(b).toMatchObject({ color: '#ff0000', width: 9 })
  })

  it('unsubscribe stops delivery; a throwing listener does not break the pipeline', () => {
    const e = new StrokeEngine()
    let n = 0
    const off = e.onStrokeStart(() => n++)
    e.onStrokeStart(() => {
      throw new Error('boom')
    })
    const orig = console.error
    console.error = () => {}
    e.input(S(0.1, 0.1, 0), true)
    e.end()
    off()
    e.input(S(0.1, 0.1, 100), true)
    e.end()
    console.error = orig
    expect(n).toBe(1)
  })
})

describe('stroke engine v0.1.1 behaviour', () => {
  const W = (x: number, y: number, t: number): RawSample => ({ x, y, t, source: 'webcam' })

  it('a pen-down right after a quick move starts where the pen is, not where the filter lagged (no hook)', () => {
    const e = new StrokeEngine({ smoothing: 0.8, stabilizer: 0, refine: false })
    for (let i = 0; i < 10; i++) e.input(W(0.3 + i * 0.02, 0.5, i * 33), false)
    e.input(W(0.5, 0.5, 330), true)
    expect(e.activeStroke!.points[0]!.x).toBeCloseTo(0.5, 6)
  })

  it('pen-up/pen-down never reset smoothing while writing continues (cursor stays continuous)', () => {
    const e = new StrokeEngine({ smoothing: 0.5, stabilizer: 0, refine: false })
    const cursor: Array<{ x: number; down: boolean }> = []
    e.onCursor((c) => cursor.push(c))
    for (let i = 0; i < 12; i++) e.input(W(0.5 + (i % 2 ? 0.003 : -0.003), 0.5, i * 33), i >= 6)
    for (let i = 1; i < cursor.length; i++) expect(Math.abs(cursor[i]!.x - cursor[i - 1]!.x)).toBeLessThan(0.006)
  })

  it('pen-down seeding: a still hand starts the stroke at its average position', () => {
    const e = new StrokeEngine({ smoothing: 0.5, stabilizer: 0, refine: false })
    // Arrive fast from far away, then hold still (noisy) for ~100 ms before pinching.
    for (let i = 0; i < 6; i++) e.input(W(0.1 + i * 0.08, 0.5, i * 33), false)
    const still = [0.503, 0.497, 0.501]
    still.forEach((x, i) => e.input(W(x, 0.5, 200 + i * 33), false))
    e.input(W(0.5, 0.5, 300), true)
    // Without seeding the filter would still lag behind the approach (x well below 0.5).
    expect(e.activeStroke!.points[0]!.x).toBeGreaterThan(0.49)
  })

  it('end(trimAfter) removes ink recorded after the release onset, keeping at least one point', () => {
    const e = new StrokeEngine({ smoothing: 0, stabilizer: 0, refine: false })
    for (let i = 0; i <= 10; i++) e.input(W(0.3 + i * 0.01, 0.5, i * 33), true)
    const s = e.end('released', 6 * 33)!
    expect(s.points.every((p) => p.t <= 6 * 33)).toBe(true)
    expect(s.points.at(-1)!.x).toBeCloseTo(0.36, 6)
    expect(e.stats.trimmed).toBeGreaterThan(0)
    e.input(W(0.5, 0.5, 1000), true)
    expect(e.end('released', 0)!.points).toHaveLength(1)
  })

  it('refinement at pen-up removes lag: the stroke reaches its true end', () => {
    const line = (refine: boolean) => {
      const e = new StrokeEngine({ smoothing: 0.6, stabilizer: 0, refine })
      for (let i = 0; i <= 15; i++) e.input(W(0.3 + i * 0.01, 0.5, i * 33), true)
      return e.end('released')!
    }
    const live = line(false)
    const refined = line(true)
    expect(Math.abs(refined.points.at(-1)!.x - 0.45)).toBeLessThan(Math.abs(live.points.at(-1)!.x - 0.45))
    expect(refined.points.at(-1)!.x).toBeCloseTo(0.45, 2)
  })

  it('mouse strokes are not stabilized or refined (noise-free input)', () => {
    const e = new StrokeEngine({ smoothing: 0, stabilizer: 1, refine: true })
    for (let i = 0; i <= 5; i++) e.input(S(0.3 + i * 0.0005, 0.5, i * 16), true)
    const s = e.end()!
    expect(s.points.at(-1)!.x).toBeCloseTo(0.3025, 6)
  })

  it('stroke JSON shape is unchanged (serialization compatibility)', () => {
    const e = new StrokeEngine()
    for (let i = 0; i <= 8; i++) e.input(W(0.3 + i * 0.01, 0.5, i * 33), true)
    const s = e.end()!
    expect(Object.keys(s).sort()).toEqual(['color', 'endedAt', 'id', 'points', 'source', 'startedAt', 'width'])
    expect(Object.keys(s.points[0]!).sort()).toEqual(['raw', 't', 'x', 'y'])
  })
})

it('mouse input is never treated as a tracking spike (fast flicks are kept)', () => {
  const e = new StrokeEngine({ smoothing: 0 })
  e.input(S(0.1, 0.1, 0), false)
  e.input(S(0.9, 0.9, 5), true) // instant jump then press
  expect(e.activeStroke!.points[0]).toMatchObject({ x: 0.9, y: 0.9 })
  expect(e.stats.rejected).toBe(0)
})
