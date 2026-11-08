import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings'

describe('settings', () => {
  it('falls back to defaults for missing or corrupt values', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ smoothing: 'lots', mirror: 1, penPoint: 'toe' })).toEqual(DEFAULT_SETTINGS)
  })
  it('clamps ranges and keeps a valid calibrated region', () => {
    const s = sanitizeSettings({ writingSensitivity: 9, smoothing: -1, region: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.5 } })
    expect(s.writingSensitivity).toBe(2)
    expect(s.smoothing).toBe(0)
    expect(s.region).toEqual({ x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.5 })
    expect(sanitizeSettings({ region: { x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.9 } }).region).toBeNull()
  })
})
