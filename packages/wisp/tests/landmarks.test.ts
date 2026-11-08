import { describe, expect, it } from 'vitest'
import { landmarkDistance, palmSize, pinchRatio, validLandmarks } from '../src/tracking/landmarks'
import { fakeHand } from './helpers'

describe('landmark geometry', () => {
  it('measures distance in frame-width units on non-square video', () => {
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 0, y: 0.16, z: 0 }
    // 0.16 of the height on 16:9 video is 0.09 of the width.
    expect(landmarkDistance(a, b, 16 / 9)).toBeCloseTo(0.09, 5)
  })

  it('pinch ratio is scale-invariant (same gesture near or far)', () => {
    const near = fakeHand(0.02)
    const far = fakeHand(0.02).map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.5, y: 0.5 + (p.y - 0.5) * 0.5, z: 0 }))
    expect(pinchRatio(near, 1)).toBeCloseTo(pinchRatio(far, 1)!, 6)
  })

  it('returns null for degenerate or incomplete hands', () => {
    expect(pinchRatio(fakeHand(0.02).slice(0, 10), 1)).toBeNull()
    const flat = fakeHand(0.02).map(() => ({ x: 0.5, y: 0.5, z: 0 }))
    expect(palmSize(flat, 1)).toBe(0)
    expect(pinchRatio(flat, 1)).toBeNull()
  })

  it('validates landmark lists', () => {
    expect(validLandmarks(fakeHand(0.1))).toBe(true)
    const bad = fakeHand(0.1)
    bad[3] = { x: Number.NaN, y: 0, z: 0 }
    expect(validLandmarks(bad)).toBe(false)
    expect(validLandmarks(undefined)).toBe(false)
  })
})
