export function environmentProblems(env: unknown, policies: unknown, defaultBranch?: string): string[]
export function checkEnvironment(options: { token: string; repo: string; name?: string; fetch?: typeof globalThis.fetch }): Promise<{ env: unknown; policies: unknown; defaultBranch: string; problems: string[] }>
