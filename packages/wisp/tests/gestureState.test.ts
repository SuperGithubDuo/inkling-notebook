import { describe, expect, it } from 'vitest'
import { GestureStateMachine, type GestureAction } from '../src/gestures/gestureState'
import { CLOSED, OPEN, ends, frames, hand, samples } from './helpers'

function run(m: GestureStateMachine, list: Parameters<typeof frames>[0], t0 = 0): GestureAction[] {
  return frames(list, t0).flatMap((f) => m.update(f))
}

describe('gesture state machine', () => {
  it('hover → writing after enterFrames, backdating the stroke to the first pinched frame', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(OPEN, 0.1), hand(OPEN, 0.2), hand(OPEN, 0.3), hand(CLOSED, 0.4), hand(CLOSED, 0.5), hand(CLOSED, 0.6)])
    expect(m.state).toBe('writing')
    const down = samples(a).filter((s) => s.down)
    expect(down.map((s) => s.x)).toEqual([0.4, 0.5, 0.6])
  })

  it('ignores a one-frame pinch blip (debounce)', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(OPEN), hand(OPEN)])
    expect(samples(a).some((s) => s.down)).toBe(false)
    expect(m.state).toBe('hover')
  })

  it('release needs exitFrames and drops the frames where the fingers were separating', () => {
    const m = new GestureStateMachine()
    const a = run(m, [
      hand(OPEN, 0.1), hand(OPEN, 0.1), hand(OPEN, 0.1),
      hand(CLOSED, 0.2), hand(CLOSED, 0.3), hand(CLOSED, 0.4),
      hand(OPEN, 0.45), hand(OPEN, 0.5)
    ])
    expect(m.state).toBe('hover')
    expect(ends(a)).toEqual([{ type: 'end', reason: 'released' }])
    const down = samples(a).filter((s) => s.down)
    expect(down.map((s) => s.x)).toEqual([0.2, 0.3, 0.4])
    // The end comes before the hover samples of the release.
    const endIdx = a.findIndex((x) => x.type === 'end')
    const hoverAfter = a.slice(endIdx).filter((x) => x.type === 'sample')
    expect(hoverAfter.every((x) => x.type === 'sample' && !x.sample.down)).toBe(true)
  })

  it('a one-frame release blip keeps writing (no broken stroke)', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), hand(OPEN, 0.7), hand(CLOSED, 0.8)])
    expect(ends(a)).toHaveLength(0)
    expect(m.state).toBe('writing')
    expect(samples(a).filter((s) => s.down).map((s) => s.x)).toContain(0.7)
  })

  it('does not write when the hand enters the frame already pinched', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED)])
    expect(samples(a).some((s) => s.down)).toBe(false)
    // After opening and closing again, it writes.
    const b = run(m, [hand(OPEN), hand(CLOSED), hand(CLOSED)], 500)
    expect(samples(b).some((s) => s.down)).toBe(true)
  })

  it('requires the hand to be stable for minHandFrames before a pinch', () => {
    const m = new GestureStateMachine({ minHandFrames: 4 })
    const a = run(m, [hand(OPEN), hand(CLOSED), hand(CLOSED), hand(CLOSED)])
    expect(samples(a).some((s) => s.down)).toBe(false)
  })

  it('ignores low-confidence frames as missing hands', () => {
    const m = new GestureStateMachine()
    run(m, [hand(OPEN, 0.5, 0.5, 0.2)])
    expect(m.state).toBe('no-hand')
  })

  describe('lost tracking', () => {
    it('keeps the stroke through a short dropout', () => {
      const m = new GestureStateMachine({ lostGraceMs: 160 })
      const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), null, null, hand(CLOSED, 0.55)])
      expect(ends(a)).toHaveLength(0)
      expect(m.state).toBe('writing')
    })

    it('ends the stroke when the hand stays missing past the grace period', () => {
      const m = new GestureStateMachine({ lostGraceMs: 100 })
      const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), null, null, null, null, null])
      expect(ends(a)).toEqual([{ type: 'end', reason: 'lost' }])
      expect(a.some((x) => x.type === 'tracking-lost')).toBe(true)
      expect(m.state).toBe('no-hand')
    })

    it('a hand coming back already pinched after loss does not resume writing', () => {
      const m = new GestureStateMachine({ lostGraceMs: 60 })
      run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), null, null, null, null])
      const b = run(m, [hand(CLOSED), hand(CLOSED), hand(CLOSED), hand(CLOSED)], 1000)
      expect(samples(b).some((s) => s.down)).toBe(false)
    })

    it('hand vanishing during release ends the stroke', () => {
      const m = new GestureStateMachine({ exitFrames: 3 })
      const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), hand(OPEN), null])
      expect(ends(a)).toHaveLength(1)
      expect(m.state).toBe('no-hand')
    })

    it('a pending pinch is dropped when the hand vanishes', () => {
      const m = new GestureStateMachine({ enterFrames: 3 })
      const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), null])
      expect(samples(a).some((s) => s.down)).toBe(false)
    })
  })

  it('rapid pinch/release produces well-formed start/end pairs', () => {
    const m = new GestureStateMachine({ enterFrames: 1, exitFrames: 1 })
    const pattern = [hand(OPEN), hand(OPEN), hand(OPEN)]
    for (let i = 0; i < 20; i++) pattern.push(hand(i % 2 ? OPEN : CLOSED))
    const a = run(m, pattern)
    let down = false
    for (const x of a) {
      if (x.type === 'sample' && x.sample.down) down = true
      if (x.type === 'end') {
        expect(down).toBe(true)
        down = false
      }
    }
    expect(ends(a).length).toBe(10)
  })

  it('reset() ends an active stroke and returns to no-hand', () => {
    const m = new GestureStateMachine()
    run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED)])
    const a = m.reset()
    expect(ends(a)).toHaveLength(1)
    expect(m.state).toBe('no-hand')
  })

  it('reports every state change', () => {
    const m = new GestureStateMachine()
    const a = run(m, [hand(OPEN), hand(OPEN), hand(OPEN), hand(CLOSED), hand(CLOSED), hand(OPEN), hand(OPEN)])
    const states = a.flatMap((x) => (x.type === 'state' ? [x.to] : []))
    expect(states).toEqual(['hover', 'pinch-pending', 'writing', 'release-pending', 'hover'])
  })
})
