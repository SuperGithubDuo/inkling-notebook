import { describe, expect, it } from 'vitest'
import { boxToPage, planAnnotations } from '../../src/renderer/src/ai/annotate'
import { buildTransaction } from '../../src/renderer/src/canvas/commands'
import { createPageDoc } from '../../src/shared/factory'
import { parseTaskResult } from '../../src/shared/tutor'
import { defaultAnswer } from '../support/fakeGemini.mjs'
import type { Annotation } from '../../src/shared/tutor'

const page = createPageDoc('nb', 'pg')
const region = { x: 100, y: 150, width: 440, height: 300 }
const userStroke = { type: 'createStroke' as const, id: crypto.randomUUID(), stroke: { color: '#1f2430', size: 3, points: [[120, 180] as [number, number], [300, 200] as [number, number]] } }

describe('annotation proposals → canvas commands', () => {
  it('maps Gemini 0–1000 boxes over the image back to page coordinates', () => {
    expect(boxToPage([0, 0, 1000, 1000], region)).toEqual(region)
    expect(boxToPage([500, 250, 750, 500], region)).toEqual({ x: 210, y: 300, width: 110, height: 75 })
    expect(boxToPage([-20, 0, 1200, 1000], region).height).toBe(300)
  })

  it('turns the default fake markup into valid AI-authored objects in one transaction', () => {
    const json = JSON.stringify(defaultAnswer({ systemInstruction: { parts: [{ text: 'Mark it up the way a teacher would' }] } }).json)
    const set = parseTaskResult('annotate', json)!
    expect(set.annotations).toHaveLength(4)
    const placed = planAnnotations(set.annotations, { region, page })
    const commands = placed.flatMap((p) => p.commands)
    const base = buildTransaction(page, [userStroke], { author: 'user' })
    const withUser = { ...page, objects: base.transaction.ops.flatMap((o) => (o.kind === 'add' ? o.items.map((i) => i.object) : [])) }
    const { transaction, created } = buildTransaction(withUser, commands, { author: 'ai' })
    expect(transaction.ops).toHaveLength(commands.length)
    const objects = transaction.ops.flatMap((o) => (o.kind === 'add' ? o.items.map((i) => i.object) : []))
    expect(created).toHaveLength(objects.length)
    expect(objects.every((o) => o.author === 'ai')).toBe(true)
    const texts = objects.filter((o) => o.type === 'text')
    expect(texts.map((t) => t.type === 'text' && t.text)).toEqual(['2x = 8', '11 − 3 = 8, so x = 4'])
    expect(texts.every((t) => t.type === 'text' && t.font === 'hand')).toBe(true)
  })

  it('writes notes beside the work, not on it, and stacks them without overlap', () => {
    const notes: Annotation[] = [0, 1, 2].map((i) => ({ kind: 'note', box_2d: [400, 100, 520, 900], text: `note number ${i}` }))
    const placed = planAnnotations(notes, { region, page })
    const boxes = placed.map((p) => p.commands.find((c) => c.type === 'createText')!).map((c) => (c.type === 'createText' ? c.text : null)!)
    for (const b of boxes) expect(b.x).toBeGreaterThanOrEqual(region.x + region.width)
    const ys = boxes.map((b) => b.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(26)
  })

  it('places notes below the work when there is no room beside it', () => {
    const wide = { x: 60, y: 200, width: 1100, height: 200 }
    const [p] = planAnnotations([{ kind: 'note', box_2d: [0, 0, 500, 500], text: 'Check the sign' }], { region: wide, page })
    const t = p!.commands.find((c) => c.type === 'createText')
    expect(t?.type === 'createText' && t.text.y).toBeGreaterThanOrEqual(wide.y + wide.height)
  })

  it('converts LaTeX in notes to plain Unicode, and keeps marks on the page', () => {
    const edge = { x: 1100, y: 1600, width: 140, height: 154 }
    const placed = planAnnotations(
      [
        { kind: 'correction', box_2d: [0, 0, 1000, 1000], text: '$x^2 = \\frac{1}{2}$' },
        { kind: 'check', box_2d: [900, 900, 1000, 1000] },
        { kind: 'circle', box_2d: [100, 100, 300, 300] },
        { kind: 'underline', box_2d: [100, 100, 300, 300] }
      ],
      { region: edge, page }
    )
    const text = placed[0]!.commands.find((c) => c.type === 'createText')
    expect(text?.type === 'createText' && text.text.text).toBe('x² = 1/2')
    expect(() => buildTransaction(page, placed.flatMap((p) => p.commands), { author: 'ai' })).not.toThrow()
  })
})
