import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, migrateV1, sanitizeSettings } from '../src/core/settings'

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

describe('settings v2 migration (WISP 0.1.1)', () => {
  it('defaults put the pen between thumb and index, with refinement on', () => {
    expect(DEFAULT_SETTINGS.penPoint).toBe('midpoint')
    expect(DEFAULT_SETTINGS.refine).toBe(true)
  })

  it('v1 settings keep display choices and calibration but reset tuning to the new defaults', () => {
    const v1 = { mirror: false, smoothing: 0.9, pinchSensitivity: 1.8, penPoint: 'index', showDiagnostics: true, region: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.5 } }
    const s = migrateV1(v1)
    expect(s.mirror).toBe(false)
    expect(s.showDiagnostics).toBe(true)
    expect(s.region).toEqual(v1.region)
    expect(s.smoothing).toBe(DEFAULT_SETTINGS.smoothing)
    expect(s.pinchSensitivity).toBe(DEFAULT_SETTINGS.pinchSensitivity)
    expect(s.penPoint).toBe('midpoint')
  })

  it('accepts legacy pen-point values', () => {
    expect(sanitizeSettings({ penPoint: 'pinch' }).penPoint).toBe('midpoint')
    expect(sanitizeSettings({ penPoint: 'index' }).penPoint).toBe('index')
  })
})
