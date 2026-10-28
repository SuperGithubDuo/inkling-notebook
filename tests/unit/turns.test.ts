import { describe, expect, it } from 'vitest'
import { buildTurns, type ThreadEntry } from '../../src/renderer/src/ai/turns'
import { aiRequestSchema } from '../../src/shared/ai'

const img = (data: string) => ({ image: { mimeType: 'image/jpeg' as const, data } })
const user = (text: string, image?: string): ThreadEntry => ({ role: 'user', parts: image ? [{ text }, img(image)] : [{ text }], ok: true })
const model = (text: string, ok = true): ThreadEntry => ({ role: 'model', parts: [{ text }], ok })

describe('conversation history sent to the model', () => {
  it('keeps complete exchanges in order and ends with the new question', () => {
    const turns = buildTurns([user('q1'), model('a1'), user('q2'), model('a2')], [{ text: 'q3' }])
    expect(turns.map((t) => `${t.role}:${'text' in t.parts[0]! ? t.parts[0].text : 'img'}`)).toEqual(['user:q1', 'model:a1', 'user:q2', 'model:a2', 'user:q3'])
    expect(aiRequestSchema.safeParse({ task: 'chat', turns }).success).toBe(true)
  })

  it('drops failed exchanges and keeps only the last five', () => {
    const history = [user('bad'), model('', false)]
    for (let i = 0; i < 8; i++) history.push(user(`q${i}`), model(`a${i}`))
    const turns = buildTurns(history, [{ text: 'now' }])
    expect(turns).toHaveLength(11)
    expect(JSON.stringify(turns)).not.toContain('bad')
    expect(turns[0]!.parts[0]).toEqual({ text: 'q3' })
  })

  it('sends at most one earlier image, and none when the new question has its own', () => {
    const history = [user('first', 'AAAA'), model('a1'), user('second', 'BBBB'), model('a2')]
    const followUp = buildTurns(history, [{ text: 'why?' }])
    const images = (t: typeof followUp) => t.flatMap((x) => x.parts).filter((p) => 'image' in p)
    expect(images(followUp)).toEqual([img('BBBB')])
    const withNew = buildTurns(history, [{ text: 'and this?' }, img('CCCC')])
    expect(images(withNew)).toEqual([img('CCCC')])
    expect(aiRequestSchema.safeParse({ task: 'chat', turns: withNew }).success).toBe(true)
  })

  it('shortens long earlier answers', () => {
    const turns = buildTurns([user('q'), model('x'.repeat(10_000))], [{ text: 'next' }])
    expect((turns[1]!.parts[0] as { text: string }).text.length).toBeLessThanOrEqual(4001)
  })
})
