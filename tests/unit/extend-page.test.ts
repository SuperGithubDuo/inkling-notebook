import { describe, expect, it } from 'vitest'
import { buildTransaction } from '@/canvas/commands'
import { applyTransaction, contentShift, invertTransaction } from '@/canvas/history'
import type { PageDoc, StrokeObject } from '@shared/schema'

const stroke = (id: string, x: number, y: number): StrokeObject => ({
  id,
  type: 'stroke',
  author: 'user',
  createdAt: 0,
  tool: 'pen',
  color: '#000000',
  size: 4,
  opacity: 1,
  hasPressure: false,
  points: [
    [x, y],
    [x + 10, y + 10]
  ]
})

const page = (over: Partial<PageDoc> = {}): PageDoc => ({
  schemaVersion: 3,
  id: 'page-000001',
  notebookId: 'notebook-01',
  width: 1240,
  height: 1754,
  paper: { type: 'grid', spacing: 31, color: '#e8eaee' },
  objects: [stroke('existing-01', 100, 100)],
  background: null,
  updatedAt: 0,
  ...over
})

describe('extendPage (infinite paper)', () => {
  it('grows right and down without moving anything, as one undoable step with the stroke', () => {
    const p = page()
    const { transaction } = buildTransaction(
      p,
      [
        { type: 'extendPage', left: 0, top: 0, right: 310, bottom: 620 },
        { type: 'createStroke', stroke: { tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[1400, 2200], [1450, 2250]] } }
      ],
      { author: 'user' }
    )
    const grown = applyTransaction(p, transaction)
    expect([grown.width, grown.height]).toEqual([1550, 2374])
    expect(grown.objects[0]).toEqual(p.objects[0])
    expect(grown.objects).toHaveLength(2)
    expect(contentShift(transaction)).toEqual([0, 0])
    const undone = applyTransaction(grown, invertTransaction(transaction))
    expect([undone.width, undone.height]).toEqual([1240, 1754])
    expect(undone.objects).toEqual(p.objects)
  })

  it('growing left/up moves existing content with the corner, and undo moves it back', () => {
    const p = page()
    const { transaction } = buildTransaction(p, [{ type: 'extendPage', left: 62, top: 93, right: 0, bottom: 0 }], { author: 'user' })
    const grown = applyTransaction(p, transaction)
    expect([grown.width, grown.height]).toEqual([1302, 1847])
    expect((grown.objects[0] as StrokeObject).points[0]).toEqual([162, 193])
    expect(contentShift(transaction)).toEqual([62, 93])
    const inverse = invertTransaction(transaction)
    expect(contentShift(inverse)).toEqual([-62, -93])
    expect(applyTransaction(grown, inverse).objects).toEqual(p.objects)
  })

  it('is refused for PDF pages, for the AI, and beyond the largest page size', () => {
    const grow = [{ type: 'extendPage' as const, left: 0, top: 0, right: 100, bottom: 0 }]
    const pdf = page({ background: { type: 'pdf', asset: 'a'.repeat(32) + '.pdf', page: 0, width: 600, height: 800, text: '' } as PageDoc['background'] })
    expect(() => buildTransaction(pdf, grow, { author: 'user' })).toThrow('PDF page keeps its size')
    expect(() => buildTransaction(page(), grow, { author: 'ai' })).toThrow('may not change the page size')
    expect(() => buildTransaction(page(), [{ type: 'extendPage', left: 0, top: 0, right: 19000, bottom: 0 }], { author: 'user' })).toThrow('at most 20000')
  })

  it('a zero extension changes nothing', () => {
    const { transaction } = buildTransaction(page(), [{ type: 'extendPage', left: 0, top: 0, right: 0, bottom: 0 }], { author: 'user' })
    expect(transaction.ops).toEqual([])
  })
})
