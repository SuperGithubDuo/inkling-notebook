import { describe, expect, it } from 'vitest'
import {
  applySensitivity,
  cameraToPage,
  defaultRegion,
  fitPage,
  pageToScreen,
  regionFromCorners,
  screenToPage
} from '../src/strokes/coordinates'

const full = { x0: 0, y0: 0, x1: 1, y1: 1 }

describe('coordinate mapping', () => {
  it('maps camera → page and mirrors x when requested', () => {
    expect(cameraToPage({ x: 0.25, y: 0.5 }, { mirror: false, region: full })).toMatchObject({ x: 0.25, y: 0.5 })
    expect(cameraToPage({ x: 0.25, y: 0.5 }, { mirror: true, region: full })).toMatchObject({ x: 0.75, y: 0.5 })
  })

  it('normalizes within the writing region and clamps outside it', () => {
    const m = { mirror: false, region: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 } }
    const mid = cameraToPage({ x: 0.4, y: 0.4 }, m)!
    expect(mid.x).toBeCloseTo(0.5, 9)
    expect(mid.y).toBeCloseTo(0.5, 9)
    expect(mid.clamped).toBe(false)
    expect(cameraToPage({ x: 0.9, y: 0.1 }, m)).toMatchObject({ x: 1, y: 0, clamped: true })
  })

  it('never produces invalid coordinates', () => {
    const m = { mirror: true, region: full }
    expect(cameraToPage(null, m)).toBeNull()
    expect(cameraToPage({ x: Number.NaN, y: 0.5 }, m)).toBeNull()
    expect(cameraToPage({ x: 0.5, y: Infinity }, m)).toBeNull()
    expect(cameraToPage({ x: 0.5, y: 0.5 }, { mirror: false, region: { x0: 0.5, y0: 0, x1: 0.5, y1: 1 } })).toBeNull()
  })

  it('default region keeps the page aspect in camera pixels (circles stay circles)', () => {
    const va = 16 / 9
    const pa = 1.6
    const r = defaultRegion(va, pa, 0.7)
    const pixelAspect = ((r.x1 - r.x0) * va) / (r.y1 - r.y0)
    expect(pixelAspect).toBeCloseTo(pa, 6)
    expect(r.x1 - r.x0).toBeLessThanOrEqual(0.7 + 1e-9)
    expect(r.y1 - r.y0).toBeLessThanOrEqual(0.7 + 1e-9)
    expect((r.x0 + r.x1) / 2).toBeCloseTo(0.5)
  })

  it('writing sensitivity shrinks/grows the region around its centre', () => {
    const r = applySensitivity({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, 2)
    expect(r).toEqual({ x0: 0.35, y0: 0.35, x1: 0.65, y1: 0.65 })
    const same = applySensitivity({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, Number.NaN)
    expect(same.x1 - same.x0).toBeCloseTo(0.6)
  })

  it('calibration corners in any order make a valid region; tiny regions are refused', () => {
    expect(regionFromCorners({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 })).toEqual({ x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.7 })
    expect(regionFromCorners({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.9 })).toBeNull()
  })

  it('letterboxes the page and round-trips page ↔ screen at any size', () => {
    for (const [w, h] of [[1200, 800], [500, 900], [3000, 400]] as const) {
      const fit = fitPage(w, h, 1600, 1000, 0)
      expect(fit.width / fit.height).toBeCloseTo(1.6, 6)
      expect(fit.width <= w + 1e-6 && fit.height <= h + 1e-6).toBe(true)
      const s = pageToScreen({ x: 0.3, y: 0.7 }, fit)
      const p = screenToPage(s, fit)
      expect(p.x).toBeCloseTo(0.3, 9)
      expect(p.y).toBeCloseTo(0.7, 9)
    }
  })
})
