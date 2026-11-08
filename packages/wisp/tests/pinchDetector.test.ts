import { describe, expect, it } from 'vitest'
import { DEFAULT_PINCH, PinchDetector, pinchThresholds } from '../src/gestures/pinchDetector'
import { pinchRatio } from '../src/tracking/landmarks'
import { fakeHand } from './helpers'

describe('pinch thresholds', () => {
  it('detects a pinch from real landmark geometry', () => {
    const d = new PinchDetector()
    expect(d.update(pinchRatio(fakeHand(0.1), 1))).toBe(false) // wide open
    expect(d.update(pinchRatio(fakeHand(0.015), 1))).toBe(true) // tips touching
  })

  it('closes only below enter and opens only above exit (hysteresis)', () => {
    const d = new PinchDetector({ enter: 0.3, exit: 0.45 })
    expect(d.update(0.35)).toBe(false) // between thresholds, still open
    expect(d.update(0.29)).toBe(true)
    expect(d.update(0.4)).toBe(true) // between thresholds, stays pinched
    expect(d.update(0.44)).toBe(true)
    expect(d.update(0.46)).toBe(false)
    expect(d.update(0.35)).toBe(false)
  })

  it('does not flicker on noise around a single threshold', () => {
    const d = new PinchDetector()
    d.update(0.1)
    let toggles = 0
    let prev = true
    for (let i = 0; i < 200; i++) {
      const s = d.update(0.3 + Math.sin(i) * 0.05) // noise around `enter`
      if (s !== prev) toggles++
      prev = s
    }
    expect(toggles).toBe(0)
  })

  it('ignores invalid ratios', () => {
    const d = new PinchDetector()
    d.update(0.1)
    expect(d.update(null)).toBe(true)
    expect(d.update(Number.NaN)).toBe(true)
  })

  it('pinch sensitivity scales both thresholds and is clamped', () => {
    expect(pinchThresholds(1)).toEqual(DEFAULT_PINCH)
    const easy = pinchThresholds(1.5)
    expect(easy.enter).toBeCloseTo(DEFAULT_PINCH.enter * 1.5)
    expect(easy.exit).toBeGreaterThan(easy.enter)
    expect(pinchThresholds(99).enter).toBeCloseTo(DEFAULT_PINCH.enter * 2)
    expect(pinchThresholds(Number.NaN)).toEqual(DEFAULT_PINCH)
  })

  it('rejects inverted thresholds', () => {
    expect(() => new PinchDetector({ enter: 0.5, exit: 0.4 })).toThrow()
  })
})
