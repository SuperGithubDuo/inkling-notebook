export function checkUsageReport(value: unknown, canaries?: string[], path?: string): string[]
export function makeCanaries(): { question: string; note: string; answer: string; topic: string }
export const FIXTURE_JPEG: string
export function canaryRequests(k: { question: string; note: string; answer: string; topic: string }): Array<{ task: string; turns: unknown[] }>
