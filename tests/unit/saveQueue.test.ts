import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_WAIT, SaveQueue, type SaveStatus } from '../../src/renderer/src/services/saveQueue'
import type { SaveResult } from '../../src/shared/ipc'
import type { PageDoc } from '../../src/shared/schema'

// The queue only reads `id` from what it saves; the rest of the page is opaque here.
const page = (id: string) => ({ id }) as unknown as PageDoc

let saved: string[]
let savedAt: number[]
let nextResult: SaveResult
let start: number
let statuses: SaveStatus[]

function makeQueue(): SaveQueue {
  return new SaveQueue({
    getPage: (id) => page(id),
    getNote: () => undefined,
    getLibrary: () => null,
    isBlocked: () => false,
    onStatus: (s) => statuses.push(s),
    onConflict: () => {}
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  start = Date.now()
  saved = []
  savedAt = []
  statuses = []
  nextResult = { status: 'saved' }
  ;(globalThis as { window?: unknown }).window = {
    inkling: {
      savePage: async (p: PageDoc) => {
        saved.push(p.id)
        savedAt.push(Date.now() - start)
        return nextResult
      }
    }
  }
})
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('SaveQueue', () => {
  it('writes a page once, shortly after the last edit', async () => {
    const q = makeQueue()
    q.markPage('p1')
    q.markPage('p1')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(saved).toEqual(['p1'])
    expect(statuses.at(-1)).toEqual({ state: 'saved' })
  })

  it('still saves during continuous writing (edits closer together than the debounce)', async () => {
    const q = makeQueue()
    // A stroke every 300 ms for 10 s: the debounce alone would never fire.
    for (let t = 0; t < 10_000; t += 300) {
      q.markPage('p1')
      await vi.advanceTimersByTimeAsync(300)
    }
    // Unfixed, nothing was written until the writing stopped. Now no change waits
    // much longer than MAX_WAIT (plus the wait for the next edit to arrive).
    expect(savedAt.length).toBeGreaterThanOrEqual(4)
    const gaps = savedAt.map((t, i) => t - (savedAt[i - 1] ?? 0))
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_WAIT + 300)
  })

  it('flush writes immediately and reports success', async () => {
    const q = makeQueue()
    q.markPage('p1')
    await expect(q.flush()).resolves.toEqual({ ok: true })
    expect(saved).toEqual(['p1'])
    expect(q.hasPending).toBe(false)
  })

  it('keeps a failed page dirty, reports it, and retries', async () => {
    const q = makeQueue()
    nextResult = { status: 'error', message: 'disk full' }
    q.markPage('p1')
    await vi.advanceTimersByTimeAsync(600)
    expect(saved).toEqual(['p1'])
    expect(q.hasPending).toBe(true)
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'disk full' })
    await expect(q.flush()).resolves.toEqual({ ok: false, message: 'disk full' })

    nextResult = { status: 'saved' }
    await vi.advanceTimersByTimeAsync(3_000)
    expect(q.hasPending).toBe(false)
    expect(statuses.at(-1)).toEqual({ state: 'saved' })
  })

  it('does not write a page that was forgotten (deleted) before the debounce fired', async () => {
    const q = makeQueue()
    q.markPage('p1')
    q.forgetPage('p1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(saved).toEqual([])
  })
})
