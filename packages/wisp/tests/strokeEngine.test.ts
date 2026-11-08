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
    e.input(S(0.3, 0.3, 0), true)
    e.input(S(0.31, 0.3, 33), true)
    e.input(S(0.95, 0.95, 66), true) // spike
    e.input(S(0.32, 0.3, 99), true)
    const s = e.end()!
    expect(s.points.every((p) => p.x < 0.4)).toBe(true)
    expect(e.stats.rejected).toBe(1)
  })

  it('splits the stroke on a confirmed jump (no accidental connecting line)', () => {
    const e = new StrokeEngine({ smoothing: 0 })
    const ends: WispEventMap['strokeEnd'][] = []
    e.onStrokeEnd((x) => ends.push(x))
    e.input(S(0.2, 0.2, 0), true)
    e.input(S(0.21, 0.2, 33), true)
    e.input(S(0.8, 0.8, 66), true)
    e.input(S(0.81, 0.8, 99), true)
    e.input(S(0.82, 0.8, 132), true)
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
