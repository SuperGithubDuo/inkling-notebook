import { describe, expect, it } from 'vitest'
import { quotaReason, quotaText } from '../../src/renderer/src/ai/AiSettings'
import type { CloudQuota } from '../../src/shared/ai'

const q = (over: Partial<CloudQuota>): CloudQuota => ({ installUsed: 0, installLimit: 10_000, networkUsed: 0, networkLimit: 50_000, globalUsed: 0, globalLimit: 250_000, approxAnswersLeft: 12, resetAt: '2026-11-07T00:00:00Z', ...over })

describe('allowance wording: never a promise the shared budget can’t keep', () => {
  it('this computer’s own allowance is the limit: a plain count', () => {
    expect(quotaText(q({}))).toBe('About 12 free answers left today on this computer.')
  })
  it('the shared budget is smaller than this computer’s allowance: says so', () => {
    expect(quotaText(q({ globalUsed: 245_000, approxAnswersLeft: 6 }))).toBe('About 6 free answers left today on this computer, while Inkling’s shared daily budget lasts.')
  })
  it('used up: says whose budget ran out', () => {
    expect(quotaText(q({ globalUsed: 250_000, approxAnswersLeft: 0 }))).toMatch(/shared free AI budget for today is used up for everyone/)
    expect(quotaText(q({ installUsed: 10_000, approxAnswersLeft: 0 }))).toMatch(/on this computer are used up/)
  })
  it('reduced or paced allowances come with a reason; normal days have none', () => {
    expect(quotaReason(q({ reduced: true }))).toMatch(/shared AI budget is nearly used up/)
    expect(quotaReason(q({ paced: true }))).toMatch(/enough left for the rest of the month/)
    expect(quotaReason(q({}))).toBeNull()
  })
})
