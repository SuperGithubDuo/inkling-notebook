export const VALID_KEY: string
export const BAD_KEY: string
export interface FakeError {
  status: number
  body: unknown
}
export const errors: {
  invalidKey(): FakeError
  perMinute(retry?: string): FakeError
  perDay(): FakeError
  noFreeTier(): FakeError
  notFound(model?: string): FakeError
  overloaded(): FakeError
}
export interface FakeRequest {
  method: string
  path: string
  model: string | null
  key: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  task: string | null
}
export interface FakeAnswer {
  text?: string
  chunks?: string[]
  json?: unknown
  error?: FakeError
  delayMs?: number
  chunkDelayMs?: number
  hang?: boolean
  finishReason?: string
}
export interface FakeGemini {
  url: string
  requests: FakeRequest[]
  reply(answer: FakeAnswer | ((req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>)): void
  setModels(list: unknown[]): void
  setDelay(ms: number): void
  generated(): FakeRequest[]
  close(): Promise<void>
}
export function startFakeGemini(): Promise<FakeGemini>
export function taskOf(body: unknown): string
export function defaultAnswer(body: unknown): FakeAnswer
