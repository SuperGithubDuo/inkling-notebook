import { describe, expect, it } from 'vitest'
import {
  DistanceSampler,
  OneEuroFilter,
  OutlierGate,
  PointFilter,
  densify,
  ema,
  oneEuroForStrength
} from '../src/strokes/smoothing'

/** Deterministic pseudo-random noise. */
function noise(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296 - 0.5
  }
}

describe('One Euro filter', () => {
  it('reduces jitter on a held position', () => {
    const rnd = noise(7)
    const f = new PointFilter(oneEuroForStrength(0.5).params)
    const raw: number[] = []
    const out: number[] = []
    for (let i = 0; i < 120; i++) {
      const x = 0.5 + rnd() * 0.01
      raw.push(x)
      out.push(f.filter({ x, y: 0.5 }, i * 33).x)
    }
    const sd = (a: number[]) => {
      const m = a.reduce((s, v) => s + v, 0) / a.length
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
    }
    expect(sd(out.slice(30))).toBeLessThan(sd(raw.slice(30)) * 0.5)
  })

  it('adds little lag on fast movement (speed-adaptive cutoff)', () => {
    const f = new PointFilter(oneEuroForStrength(0.5).params)
    let last = 0
    for (let i = 0; i <= 15; i++) last = f.filter({ x: i * 0.03, y: 0 }, i * 33).x // ~0.9 page/s
    expect(0.45 - last).toBeLessThan(0.06) // lag < 2 frames of travel
  })

  it('strength 0 disables smoothing; higher strength smooths more', () => {
    expect(oneEuroForStrength(0).enabled).toBe(false)
    const lo = oneEuroForStrength(0.2).params.minCutoff
    const hi = oneEuroForStrength(0.9).params.minCutoff
    expect(hi).toBeLessThan(lo)
    const f = new PointFilter(oneEuroForStrength(0).params, false)
    expect(f.filter({ x: 0.123, y: 0.456 }, 0)).toEqual({ x: 0.123, y: 0.456 })
  })

  it('tolerates duplicate timestamps', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.01, dCutoff: 1 })
    f.filter(1, 10)
    expect(Number.isFinite(f.filter(2, 10))).toBe(true)
  })

  it('preserves a sharp corner (no overshoot beyond the input hull)', () => {
    const f = new PointFilter(oneEuroForStrength(0.5).params)
    const pts: { x: number; y: number }[] = []
    let t = 0
    for (let i = 0; i <= 20; i++) pts.push(f.filter({ x: 0.2 + i * 0.01, y: 0.2 }, (t += 33)))
    for (let i = 1; i <= 20; i++) pts.push(f.filter({ x: 0.4, y: 0.2 + i * 0.01 }, (t += 33)))
    for (const p of pts) {
      expect(p.x).toBeLessThanOrEqual(0.4 + 1e-9)
      expect(p.y).toBeGreaterThanOrEqual(0.2 - 1e-9)
    }
  })
})

describe('outlier rejection', () => {
  it('rejects a single-frame spike and keeps tracking', () => {
    const g = new OutlierGate()
    expect(g.check({ x: 0.5, y: 0.5 }, 0)).toBe('accept')
    expect(g.check({ x: 0.51, y: 0.5 }, 33)).toBe('accept')
    expect(g.check({ x: 0.95, y: 0.1 }, 66)).toBe('reject')
    expect(g.check({ x: 0.52, y: 0.5 }, 99)).toBe('accept')
  })

  it('two agreeing far samples are a discontinuity, not a connecting line', () => {
    const g = new OutlierGate()
    g.check({ x: 0.2, y: 0.2 }, 0)
    expect(g.check({ x: 0.8, y: 0.8 }, 33)).toBe('reject')
    expect(g.check({ x: 0.81, y: 0.8 }, 66)).toBe('discontinuity')
    expect(g.check({ x: 0.82, y: 0.8 }, 99)).toBe('accept')
  })

  it('large jumps are suspicious even after a long gap', () => {
    const g = new OutlierGate()
    g.check({ x: 0.1, y: 0.1 }, 0)
    expect(g.check({ x: 0.6, y: 0.1 }, 2000)).toBe('reject')
  })

  it('accepts extremely small movements', () => {
    const g = new OutlierGate()
    g.check({ x: 0.5, y: 0.5 }, 0)
    expect(g.check({ x: 0.5001, y: 0.5 }, 1)).toBe('accept')
  })
})

describe('resampling and interpolation', () => {
  it('distance sampler drops points closer than the minimum', () => {
    const s = new DistanceSampler(0.01)
    expect(s.accept({ x: 0, y: 0 })).toBe(true)
    expect(s.accept({ x: 0.005, y: 0 })).toBe(false)
    expect(s.accept({ x: 0.011, y: 0 })).toBe(true)
  })

  it('densify passes through every original point and fills long gaps', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }]
    const d = densify(pts, 0.02)
    for (const p of pts) expect(d.some((q) => q.x === p.x && q.y === p.y)).toBe(true)
    expect(d.length).toBeGreaterThan(pts.length)
    for (let i = 1; i < d.length; i++) expect(Math.hypot(d[i]!.x - d[i - 1]!.x, d[i]!.y - d[i - 1]!.y)).toBeLessThan(0.04)
  })

  it('ema is available for comparison', () => {
    expect(ema([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.5)[1]).toEqual({ x: 0.5, y: 0.5 })
  })
})
