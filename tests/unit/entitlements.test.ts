import { describe, expect, it } from 'vitest'
import { BETA_ENTITLEMENTS, FEATURES, FREE_ENTITLEMENTS, can, type Entitlements, type Feature } from '../../src/shared/entitlements'

describe('entitlements', () => {
  const core = (Object.keys(FEATURES) as Feature[]).filter((f) => FEATURES[f].core)

  it('the beta includes everything', () => {
    for (const f of Object.keys(FEATURES) as Feature[]) expect(can(BETA_ENTITLEMENTS, f)).toBe(true)
  })

  it('core notebook features are available even with a grant that switches them off', () => {
    const hostile: Entitlements = { edition: 'free', source: 'free', features: Object.fromEntries((Object.keys(FEATURES) as Feature[]).map((f) => [f, false])) as Record<Feature, boolean> }
    for (const f of core) expect(can(hostile, f)).toBe(true)
    expect(can(hostile, 'sync')).toBe(false)
  })

  it('a free edition keeps the core and a small cloud allowance', () => {
    expect(can(FREE_ENTITLEMENTS, 'pdf')).toBe(true)
    expect(can(FREE_ENTITLEMENTS, 'cloudAi')).toBe(true)
    expect(can(FREE_ENTITLEMENTS, 'cloudAiPlus')).toBe(false)
  })
})
