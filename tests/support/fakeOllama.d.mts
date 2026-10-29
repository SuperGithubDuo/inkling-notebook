export interface FakeOllamaTag {
  name: string
  size?: number
  digest?: string
  capabilities: string[]
}
export const DEFAULT_TAGS: FakeOllamaTag[]
export interface FakeOllamaRequest {
  method: string
  path: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  task: string | null
}
export interface FakeOllamaAnswer {
  text?: string
  chunks?: string[]
  json?: unknown
  error?: string
  status?: number
  delayMs?: number
  chunkDelayMs?: number
  hang?: boolean
  midStreamError?: string
  doneReason?: string
}
export interface FakeOllama {
  url: string
  requests: FakeOllamaRequest[]
  reply(answer: FakeOllamaAnswer | ((req: FakeOllamaRequest) => FakeOllamaAnswer | Promise<FakeOllamaAnswer>)): void
  setTags(list: FakeOllamaTag[]): void
  setVersion(v: string): void
  chats(): FakeOllamaRequest[]
  close(): Promise<void>
}
export function startFakeOllama(): Promise<FakeOllama>
export function taskOf(body: unknown): string
export function defaultAnswer(body: unknown): FakeOllamaAnswer
