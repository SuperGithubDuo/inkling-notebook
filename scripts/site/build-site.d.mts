export const PAGES: string[]
export const DOWNLOAD_PAGE: string
export function scriptJson(v: unknown): string
export function escapeHtml(s: unknown): string
export function injectData(html: string, id: string, value: unknown): string
export function safeFeedbackUrl(u: string | undefined): string
export function keepBlocks(html: string, keep: string[]): string
export function longDate(iso: string): string
export function pageValues(release: any, site: any): Record<string, string>
export function renderPage(html: string, release: any, site: any): string
export function buildSite(opts: { siteDir: string; outDir: string; releases: any[]; tagCommits: Record<string, string>; config: { withdrawn?: string[] }; feedbackUrl?: string; generatedAt: string }): { release: any; rejected: { tag: string; reasons: string[] }[] }
export class ApiAnswer extends Error { status: number; constructor(status: number, message: string) }
export function apiGet(url: string, opts?: { token?: string; fetchImpl?: typeof fetch; retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ body: any; link: string }>
export function fetchReleaseData(repo: string, opts?: { token?: string; fetchImpl?: typeof fetch; retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ releases: any[]; tagCommits: Record<string, string> }>
