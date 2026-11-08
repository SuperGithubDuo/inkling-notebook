import { describe, expect, it } from 'vitest'
import { toInklingCreateStroke } from '../src/integration/inklingAdapter'
import type { Stroke } from '../src/strokes/types'

describe('Inkling adapter sketch', () => {
  it('maps normalized points into an Inkling page rectangle', () => {
    const s: Stroke = {
      id: 's1',
      color: '#1f2430',
      width: 4,
      source: 'webcam',
      startedAt: 0,
      endedAt: 1,
      points: [{ x: 0, y: 0, t: 0 }, { x: 0.5, y: 1, t: 1 }]
    }
    const cmd = toInklingCreateStroke(s, { x: 100, y: 50, width: 800, height: 500 }, 1600)
    expect(cmd.type).toBe('createStroke')
    expect(cmd.stroke.points).toEqual([[100, 50], [500, 550]])
    expect(cmd.stroke.size).toBe(2) // 4 px on a 1600-wide page → 2 px on an 800-wide target
    expect(cmd.stroke).toMatchObject({ tool: 'pen', hasPressure: false, opacity: 1, color: '#1f2430' })
  })
})
