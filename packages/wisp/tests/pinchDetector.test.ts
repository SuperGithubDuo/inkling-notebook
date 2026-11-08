import { describe, expect, it } from 'vitest'
import { DEFAULT_PINCH, PinchSignal, pinchThresholds } from '../src/gestures/pinchDetector'
import { pinchRatio } from '../src/tracking/landmarks'
import { fakeHand } from './helpers'

describe('pinch ratio from landmarks', () => {
  it('is below the start threshold when tips touch and well above it when open', () => {
    expect(pinchRatio(fakeHand(0.015), 1)!).toBeLessThan(DEFAULT_PINCH.enter)
    expect(pinchRatio(fakeHand(0.1), 1)!).toBeGreaterThan(DEFAULT_PINCH.releaseAbs)
  })
})

describe('pinch thresholds (asymmetric)', () => {
  it('defaults: release is relative and far smaller than v0.1’s absolute 0.45', () => {
    const t = pinchThresholds()
    expect(t).toEqual(DEFAULT_PINCH)
    // Relative rise needed to lift the pen is 0.10 palm-widths (v0.1: open to 0.45 absolute).
    expect(t.releaseRise).toBeLessThanOrEqual(0.1)
    expect(t.releaseAbs).toBeLessThan(0.45)
  })

  it('pen-down sensitivity scales the start threshold; the backstop stays above it', () => {
    const t = pinchThresholds(1.5, 1)
    expect(t.enter).toBeCloseTo(DEFAULT_PINCH.enter * 1.5)
    expect(t.releaseAbs).toBeGreaterThan(t.enter)
  })

  it('pen-up sensitivity shrinks the opening needed to lift the pen', () => {
    const fast = pinchThresholds(1, 2)
    const slow = pinchThresholds(1, 0.5)
    expect(fast.releaseRise).toBeCloseTo(DEFAULT_PINCH.releaseRise / 2)
    expect(slow.releaseRise).toBeCloseTo(DEFAULT_PINCH.releaseRise * 2)
    expect(fast.openVelocity).toBeLessThan(slow.openVelocity)
  })

  it('clamps out-of-range or invalid sensitivities', () => {
    expect(pinchThresholds(99, 99).enter).toBeCloseTo(DEFAULT_PINCH.enter * 2)
    expect(pinchThresholds(Number.NaN, Number.NaN)).toEqual(DEFAULT_PINCH)
  })
})

describe('PinchSignal', () => {
  it('smooths single-frame noise', () => {
    const s = new PinchSignal()
    s.update(0, 0.2)
    const v = s.update(33, 0.4)!
    expect(v).toBeGreaterThan(0.2)
    expect(v).toBeLessThan(0.4)
  })

  it('reports opening velocity (positive) and closing velocity (negative)', () => {
    const s = new PinchSignal()
    s.update(0, 0.2)
    s.update(33, 0.3)
    s.update(66, 0.4)
    expect(s.velocity).toBeGreaterThan(1)
    expect(s.rawVelocity).toBeCloseTo(0.2 / 0.066, 1)
    const c = new PinchSignal()
    c.update(0, 0.6)
    c.update(33, 0.4)
    c.update(66, 0.2)
    expect(c.rawVelocity).toBeLessThan(-5)
  })

  it('ignores invalid ratios', () => {
    const s = new PinchSignal()
    s.update(0, 0.2)
    expect(s.update(33, null)).toBeCloseTo(0.2)
    expect(s.update(66, Number.NaN)).toBeCloseTo(0.2)
  })
})
