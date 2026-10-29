export interface RestCall {
  model: string
  inputs: Record<string, unknown>
  status: number
  ms: number
}
export function workersAiRest(options: { accountId?: string; apiToken?: string; onCall?: (c: RestCall) => void }): {
  calls: RestCall[]
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}
