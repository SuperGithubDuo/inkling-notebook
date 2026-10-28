import { describe, expect, it } from 'vitest'
import type { CanvasObject, StrokeObject, TextObject } from '../../src/shared/schema'
import { applyTransaction, invertTransaction, removeOp } from '../../src/renderer/src/canvas/history'
import { eraserHits } from '../../src/renderer/src/canvas/geometry'
import { outlinePath } from '../../src/renderer/src/canvas/ink'
import { createPageDoc } from '../../src/shared/factory'

const stroke = (id: string, points: StrokeObject['points']): StrokeObject => ({
  id,
  type: 'stroke',
  author: 'user',
  createdAt: 0,
  tool: 'pen',
  color: '#000000',
  size: 4,
  opacity: 1,
  hasPressure: false,
  points
})
const text: TextObject = {
  id: 'text-000001',
  type: 'text',
  author: 'user',
  createdAt: 0,
  x: 100,
  y: 100,
  width: 200,
  text: 'hello',
  color: '#000000',
  fontSize: 20,
  font: 'sans'
}

describe('history', () => {
  const a = stroke('stroke-a01', [[0, 0], [10, 10]])
  const b = stroke('stroke-b01', [[50, 50], [60, 60]])
  const c = stroke('stroke-c01', [[90, 90], [95, 95]])
  const base = { ...createPageDoc('notebook-1', 'page-0001'), objects: [a, b, c] as CanvasObject[] }

  it('undoing a removal restores objects at their original layer index', () => {
    const tx = { label: 'Erase', ops: [removeOp(base.objects, new Set([b.id]))] }
    const erased = applyTransaction(base, tx)
    expect(erased.objects.map((o) => o.id)).toEqual([a.id, c.id])
    const restored = applyTransaction(erased, invertTransaction(tx))
    expect(restored.objects.map((o) => o.id)).toEqual([a.id, b.id, c.id])
  })

  it('add and update invert cleanly', () => {
    const d = stroke('stroke-d01', [[1, 1]])
    const add = { label: 'Draw', ops: [{ kind: 'add' as const, items: [{ object: d, index: base.objects.length }] }] }
    const added = applyTransaction(base, add)
    expect(added.objects.at(-1)?.id).toBe(d.id)
    expect(applyTransaction(added, invertTransaction(add)).objects).toHaveLength(3)

    const edited = { ...text, text: 'changed' }
    const withText = { ...base, objects: [text] as CanvasObject[] }
    const upd = { label: 'Edit', ops: [{ kind: 'update' as const, before: [text], after: [edited] }] }
    const after = applyTransaction(withText, upd)
    expect((after.objects[0] as TextObject).text).toBe('changed')
    expect((applyTransaction(after, invertTransaction(upd)).objects[0] as TextObject).text).toBe('hello')
  })
})

describe('eraser hit-testing', () => {
  const diagonal = stroke('stroke-e01', [[0, 0], [100, 100]])
  it('hits a stroke the eraser path crosses', () => {
    expect(eraserHits(diagonal, [0, 100], [100, 0], 2)).toBe(true)
  })
  it('misses a stroke whose bounding box it enters but whose line it does not touch', () => {
    expect(eraserHits(diagonal, [90, 10], [90, 10], 5)).toBe(false)
  })
  it('hits text boxes by area', () => {
    expect(eraserHits(text, [150, 110], [150, 110], 3)).toBe(true)
    expect(eraserHits(text, [150, 300], [150, 300], 3)).toBe(false)
  })
})

describe('ink', () => {
  it('ignores pressure values unless the stroke has real stylus pressure', () => {
    const light: StrokeObject['points'] = [[0, 0, 0.1], [20, 0, 0.1], [40, 0, 0.1]]
    const heavy: StrokeObject['points'] = [[0, 0, 0.9], [20, 0, 0.9], [40, 0, 0.9]]
    const style = { tool: 'pen' as const, size: 4, hasPressure: false }
    expect(outlinePath(light, style)).toBe(outlinePath(heavy, style))
    const pressured = { ...style, hasPressure: true }
    expect(outlinePath(light, pressured)).not.toBe(outlinePath(heavy, pressured))
  })
})
