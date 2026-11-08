import { describe, expect, it } from 'vitest'
import { GestureStateMachine, type GestureAction } from '../src/gestures/gestureState'
import { rng } from '../src/replay/synth'
import { CLOSED, OPEN, ends, frames, hand, samples } from './helpers'

function run(m: GestureStateMachine, list: Parameters<typeof frames>[0], t0 = 0): GestureAction[] {
  return frames(list, t0).flatMap((f) => m.update(f))
}
const open3 = () => [hand(OPEN), hand(OPEN), hand(OPEN)]
const downs = (a: GestureAction[]) => samples(a).filter((s) => s.down)
const endOf = (a: GestureAction[]) => a.find((x) => x.type === 'end') as Extract<GestureAction, { type: 'end' }> | undefined

/** Gaussian noise for ratio sequences. */
function noisy(seed: number, sd: number) {
  const r = rng(seed)
  return (v: number) => {
    const u = Math.max(1e-9, r())
    return v + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
  }
}

describe('pen down (conservative)', () => {
  it('starts after the pinch holds and has settled, at the first settled frame', () => {
    const m = new GestureStateMachine()
    const a = run(m, [...open3(), hand(CLOSED, 0.4), hand(CLOSED, 0.5), hand(CLOSED, 0.6), hand(CLOSED, 0.7)])
    expect(m.state).toBe('writing')
    // The first pinched frame comes right after a big closing jump (still closing): it is not ink.
    expect(downs(a)[0]!.x).toBeGreaterThanOrEqual(0.5)
  })

  it('does not ink frames where the fingers are still closing (start hooks)', () => {
    const m = new GestureStateMachine()
    // Gradual close: 0.9 → 0.5 → 0.28 → 0.2 → 0.16 → 0.16 …; pen point moves with the closing finger.
    const a = run(m, [...open3(), hand(0.5, 0.40), hand(0.28, 0.42), hand(0.2, 0.44), hand(0.16, 0.45), hand(0.16, 0.45), hand(0.16, 0.46)])
    const first = downs(a)[0]
    expect(first).toBeDefined()
    expect(first!.x).toBeGreaterThanOrEqual(0.44)
  })

  it('ignores a one-frame pinch blip', () => {
    const m = new GestureStateMachine()
    const a = run(m, [...open3(), hand(CLOSED), hand(OPEN), hand(OPEN)])
    expect(downs(a)).toHaveLength(0)
    expect(m.state).toBe('hover')
  })

  it('a hand entering the frame already pinched never writes until it opens', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED)])
    expect(downs(a)).toHaveLength(0)
    const b = run(m, [hand(OPEN), hand(CLOSED), hand(CLOSED), hand(CLOSED)], 500)
    expect(downs(b).length).toBeGreaterThan(0)
  })

  it('requires the hand to be stable for minHandFrames', () => {
    const m = new GestureStateMachine({ minHandFrames: 4 })
    expect(downs(run(m, [hand(OPEN), hand(CLOSED), hand(CLOSED), hand(CLOSED)]))).toHaveLength(0)
  })
})

describe('pen up (fast, relative, trimmed)', () => {
  const writeThen = (m: GestureStateMachine, release: number[]) =>
    run(m, [...open3(), ...Array.from({ length: 8 }, (_, i) => hand(0.16, 0.3 + i * 0.01)), ...release.map((r, i) => hand(r, 0.38 + (i + 1) * 0.01))])

  it('rapid release lifts the pen on the FIRST opening frame (no multi-frame debounce)', () => {
    const m = new GestureStateMachine()
    const a = writeThen(m, [0.45])
    expect(endOf(a)?.reason).toBe('released')
    expect(m.state).toBe('hover')
    // The opening frame itself is not ink.
    expect(downs(a).every((s) => s.x <= 0.375)).toBe(true)
  })

  it('a small deliberate opening (+0.12, held) lifts the pen — v0.1 needed the ratio to reach 0.45', () => {
    const m = new GestureStateMachine()
    const a = writeThen(m, [0.22, 0.28, 0.28])
    expect(endOf(a)).toBeDefined()
  })

  it('slow release: lifts during the opening and trims the ink drawn while opening', () => {
    const m = new GestureStateMachine()
    // Opening slowly over 6 frames.
    const a = writeThen(m, [0.19, 0.22, 0.25, 0.28, 0.31, 0.34])
    const e = endOf(a)!
    expect(e).toBeDefined()
    expect(e.trimAfter).toBeDefined()
    // Frames whose ratio had visibly risen are trimmed: the kept end is at or before the last steady frame.
    const lastSteady = 3 * 33 + 7 * 33 // t of the 8th pinched frame
    expect(e.trimAfter!).toBeLessThanOrEqual(lastSteady + 33)
  })

  it('a fast, large opening lifts the pen on its first frame', () => {
    const m = new GestureStateMachine()
    const a = writeThen(m, [0.4])
    expect(endOf(a)).toBeDefined()
  })

  it('a small, quick opening (+0.1) lifts the pen within three frames', () => {
    const m = new GestureStateMachine()
    const a = writeThen(m, [0.21, 0.26, 0.27])
    expect(endOf(a)).toBeDefined()
  })

  it('noisy measurements while pinched do not lift the pen (no flicker)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const n = noisy(seed, 0.035) // raw ratio noise similar to the 2.5× synthetic model
      const m = new GestureStateMachine()
      const a = run(m, [...open3(), ...Array.from({ length: 150 }, (_, i) => hand(Math.max(0.02, n(0.17)), 0.3 + i * 0.002))])
      expect(ends(a)).toHaveLength(0)
      expect(m.state).toBe('writing')
    }
  })

  it('after a release, noise near the release point cannot put the pen down again', () => {
    const m = new GestureStateMachine()
    writeThen(m, [0.3, 0.45])
    expect(m.state).toBe('hover')
    // Fingers hover around where the pen lifted (noise of ±0.05).
    const b = run(m, [hand(0.42), hand(0.36), hand(0.44), hand(0.37), hand(0.4), hand(0.35)], 2000)
    expect(downs(b)).toHaveLength(0)
  })

  it('opening then closing again starts a NEW stroke (never connected)', () => {
    const m = new GestureStateMachine()
    const a = run(m, [
      ...open3(),
      hand(0.16, 0.3), hand(0.16, 0.31), hand(0.16, 0.32), hand(0.16, 0.33),
      hand(0.7, 0.35), hand(0.7, 0.4), hand(0.7, 0.45),
      hand(0.16, 0.5), hand(0.16, 0.5), hand(0.16, 0.51), hand(0.16, 0.52)
    ])
    expect(ends(a)).toHaveLength(1)
    const endIdx = a.findIndex((x) => x.type === 'end')
    const after = samples(a.slice(endIdx)).filter((s) => s.down)
    expect(after.length).toBeGreaterThan(0)
    expect(after[0]!.x).toBeGreaterThanOrEqual(0.5)
  })

  it('rapid pinch/release cycles produce well-formed start/end pairs', () => {
    const m = new GestureStateMachine()
    const list = [...open3()]
    for (let i = 0; i < 8; i++) list.push(hand(0.16), hand(0.16), hand(0.16), hand(0.75), hand(0.75))
    const a = run(m, list)
    let down = false
    for (const x of a) {
      if (x.type === 'sample' && x.sample.down) down = true
      if (x.type === 'end') {
        expect(down).toBe(true)
        down = false
      }
    }
    expect(ends(a).length).toBe(8)
  })
})

describe('lost tracking', () => {
  it('keeps the stroke through a short dropout', () => {
    const m = new GestureStateMachine({ lostGraceMs: 160 })
    const a = run(m, [...open3(), hand(CLOSED), hand(CLOSED), hand(CLOSED), null, null, hand(CLOSED, 0.55)])
    expect(ends(a)).toHaveLength(0)
    expect(m.state).toBe('writing')
  })

  it('ends the stroke when the hand stays missing past the grace period', () => {
    const m = new GestureStateMachine({ lostGraceMs: 100 })
    const a = run(m, [...open3(), hand(CLOSED), hand(CLOSED), hand(CLOSED), null, null, null, null, null])
    expect(ends(a)).toEqual([{ type: 'end', reason: 'lost' }])
    expect(a.some((x) => x.type === 'tracking-lost')).toBe(true)
    expect(m.state).toBe('no-hand')
  })

  it('a hand coming back already pinched after loss does not resume writing', () => {
    const m = new GestureStateMachine({ lostGraceMs: 60 })
    run(m, [...open3(), hand(CLOSED), hand(CLOSED), hand(CLOSED), null, null, null, null])
    expect(downs(run(m, [hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED)], 1000))).toHaveLength(0)
  })

  it('a pending pinch is dropped when the hand vanishes', () => {
    const m = new GestureStateMachine({ enterFrames: 3 })
    expect(downs(run(m, [...open3(), hand(CLOSED), null]))).toHaveLength(0)
  })

  it('ignores low-confidence frames as missing hands', () => {
    const m = new GestureStateMachine()
    run(m, [hand(OPEN, 0.5, 0.5, 0.2)])
    expect(m.state).toBe('no-hand')
  })
})

it('reset() ends an active stroke and returns to no-hand', () => {
  const m = new GestureStateMachine()
  run(m, [...open3(), hand(CLOSED), hand(CLOSED), hand(CLOSED)])
  expect(ends(m.reset())).toHaveLength(1)
  expect(m.state).toBe('no-hand')
})

it('reports every state change', () => {
  const m = new GestureStateMachine()
  const a = run(m, [...open3(), hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(OPEN)])
  expect(a.flatMap((x) => (x.type === 'state' ? [x.to] : []))).toEqual(['hover', 'pinch-pending', 'writing', 'hover'])
})
