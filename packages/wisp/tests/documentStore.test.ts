import { describe, expect, it } from 'vitest'
import { DocumentStore } from '../src/strokes/documentStore'
import { createDocument, type Stroke } from '../src/strokes/types'

const stroke = (id: string): Stroke => ({
  id,
  points: [{ x: 0.1, y: 0.1, t: 0 }],
  color: '#000000',
  width: 3,
  source: 'mouse',
  startedAt: 0,
  endedAt: 0
})
const ids = (s: DocumentStore) => s.document.strokes.map((x) => x.id)

describe('document store: undo / redo', () => {
  it('undoes and redoes completed strokes in order', () => {
    const s = new DocumentStore()
    s.addStroke(stroke('a'))
    s.addStroke(stroke('b'))
    expect(s.undo()).toBe(true)
    expect(ids(s)).toEqual(['a'])
    expect(s.redo()).toBe(true)
    expect(ids(s)).toEqual(['a', 'b'])
    expect(s.redo()).toBe(false)
  })

  it('a new stroke after undo clears redo (predictable branching)', () => {
    const s = new DocumentStore()
    s.addStroke(stroke('a'))
    s.addStroke(stroke('b'))
    s.undo()
    s.addStroke(stroke('c'))
    expect(ids(s)).toEqual(['a', 'c'])
    expect(s.getSnapshot().history.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
  })

  it('clear is undoable and redoable', () => {
    const s = new DocumentStore()
    s.addStroke(stroke('a'))
    s.addStroke(stroke('b'))
    s.clear()
    expect(ids(s)).toEqual([])
    s.undo()
    expect(ids(s)).toEqual(['a', 'b'])
    s.redo()
    expect(ids(s)).toEqual([])
  })

  it('import (replace) is undoable', () => {
    const s = new DocumentStore()
    s.addStroke(stroke('a'))
    const other = { ...createDocument(), strokes: [stroke('x'), stroke('y')] }
    s.replace(other)
    expect(ids(s)).toEqual(['x', 'y'])
    s.undo()
    expect(ids(s)).toEqual(['a'])
  })

  it('undo with empty history is a no-op; clearing an empty page adds no history', () => {
    const s = new DocumentStore()
    expect(s.undo()).toBe(false)
    s.clear()
    expect(s.getSnapshot().history.canUndo).toBe(false)
  })

  it('stored strokes are copies (later engine mutation cannot change history)', () => {
    const s = new DocumentStore()
    const live = stroke('a')
    s.addStroke(live)
    live.points.push({ x: 0.9, y: 0.9, t: 1 })
    expect(s.document.strokes[0]!.points).toHaveLength(1)
  })

  it('notifies subscribers with a new snapshot', () => {
    const s = new DocumentStore()
    let calls = 0
    const off = s.subscribe(() => calls++)
    const before = s.getSnapshot()
    s.addStroke(stroke('a'))
    expect(calls).toBe(1)
    expect(s.getSnapshot()).not.toBe(before)
    off()
    s.addStroke(stroke('b'))
    expect(calls).toBe(1)
  })
})
