/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FakeAiAnswer {
  text?: string
  chunks?: string[]
  json?: unknown
  usage?: { inputTokens: number; outputTokens: number }
  noUsage?: boolean
  reasoning?: string
  error?: string
  midStreamError?: string
  chunkDelayMs?: number
  hang?: boolean
  finishReason?: string
}
export interface FakeAiCall {
  model: string
  inputs: any
  task: string
  cancelled: boolean
}
export interface FakeWorkersAi {
  calls: FakeAiCall[]
  reply(answer: FakeAiAnswer | ((call: FakeAiCall) => FakeAiAnswer | Promise<FakeAiAnswer>)): void
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}
export interface AiBindingLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}
export interface BetaServerOptions {
  ai?: AiBindingLike
  globalDailyNeurons?: number
  testerDailyNeurons?: number
  perMinute?: number
  typicalNeuronsPerAnswer?: number
  model?: string
  rates?: { inputPerM: number; outputPerM: number }
  reasoningEffort?: string
  disableThinking?: boolean
  structured?: 'json_schema' | 'prompt'
  imagePatch?: number
  port?: number
}
export interface BetaServer {
  url: string
  ai: FakeWorkersAi
  ledger: any
  config: any
  adminToken: string
  clock: { offset: number }
  addTester(name: string, dailyNeurons?: number): Promise<{ id: string; name: string; dailyNeurons: number; accessCode: string }>
  settled(): Promise<unknown>
  close(): Promise<void>
}
export const RATES: { inputPerM: number; outputPerM: number }
export function loadServer(): Promise<any>
export function taskOf(inputs: any): string
export function defaultAnswer(inputs: any): FakeAiAnswer
export function fakeWorkersAi(): FakeWorkersAi
export function startBetaServer(options?: BetaServerOptions): Promise<BetaServer>
