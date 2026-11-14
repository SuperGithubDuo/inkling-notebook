export interface FakeSupabase {
  url: string
  anonKey: string
  uidOf(email: string): string
  requests: Array<{ method: string; path: string; authorization: string }>
  setDown(v: boolean): void
  close(): Promise<void>
}
export function startFakeSupabase(options?: { port?: number }): Promise<FakeSupabase>
