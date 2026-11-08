/**
 * Gesture regression guard (v0.1.4).
 *
 * The user confirmed on a real webcam that v0.1.2's pen-down / pen-up
 * behaviour works well. This test replays 72 synthetic traces (18 scenarios ×
 * 2 seeds × 2 noise profiles) and requires the CURRENT defaults to make
 * exactly the same decisions as v0.1.2 did: same number of strokes, same
 * stroke start times, same pen-up decision times and same trimmed end times
 * (to 0.1 ms).
 *
 * The fixture was produced by running the v0.1.2 commit (acf446f) on these
 * traces. If this test fails, a change has altered gesture behaviour; that
 * needs a demonstrated reason (see README), not a fixture update.
 */
import { afterAll, describe, expect, it } from 'vitest'
import golden from './fixtures/gesture-golden-v012.json'
import { replay } from '../src/replay/replay'
import { SCENARIOS, setNoiseProfile, setNoiseScale } from '../src/replay/scenarios'

interface Case {
  profile: 'model' | 'webcam'
  id: string
  seed: number
  starts: number[]
  ends: number[]
  endedAt: number[]
}
const r1 = (v: number) => Math.round(v * 10) / 10

describe('pen-down / pen-up behaviour is exactly v0.1.2', () => {
  afterAll(() => setNoiseProfile('model'))
  setNoiseScale(1)
  for (const c of (golden as { cases: Case[] }).cases) {
    it(`${c.profile} · ${c.id} · seed ${c.seed}`, () => {
      setNoiseProfile(c.profile)
      const { trace } = SCENARIOS.find((s) => s.id === c.id)!.build(c.seed)
      const r = replay(trace)
      expect(r.strokes.map((s) => r1(s.startedAt))).toEqual(c.starts)
      expect(r.endDecisions.map(r1)).toEqual(c.ends)
      expect(r.strokes.map((s) => r1(s.endedAt))).toEqual(c.endedAt)
    })
  }
})
