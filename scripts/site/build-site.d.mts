export function scriptJson(v: unknown): string
export function injectData(html: string, id: string, value: unknown): string
export function safeFeedbackUrl(u: string | undefined): string
export function buildSite(opts: { siteDir: string; outDir: string; releases: any[]; tagCommits: Record<string, string>; config: { withdrawn?: string[] }; feedbackUrl?: string; allowPreview?: boolean; generatedAt: string }): { release: any; rejected: { tag: string; reasons: string[] }[] }
