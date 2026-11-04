/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FakeWorkersAi } from './fakeBeta.mjs'

export const FAKE_KEY: string
export interface FakeFailure {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  hangMs?: number
  garbage?: string
  errorEvent?: boolean
  idleAfterFirst?: boolean
}
export interface FakeOpenAi {
  url: string
  key: string
  model: FakeWorkersAi
  requests: Array<{ method: string; path: string; headers: Record<string, any>; body: any }>
  fail(f: FakeFailure): void
  completions(): Array<{ method: string; path: string; headers: Record<string, any>; body: any }>
  close(): Promise<void>
}
export function startFakeOpenAi(options?: { key?: string; path?: string; reportCost?: (usage: any) => number | undefined; cachedTokens?: number; responseHeaders?: Record<string, string>; groqUsage?: boolean }): Promise<FakeOpenAi>
