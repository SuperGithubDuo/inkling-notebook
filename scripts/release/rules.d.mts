// Types for rules.mjs (used by tests/unit/release-site.test.ts).
export const OWNER: string
export const REPO: string
export const VERSION_RE: RegExp
export const UPDATE_METADATA: string[]
export const BLOCKING_PHRASES: RegExp[]
export function installerNames(version: string): { windows: string; macArm: string; macIntel: string }
export function checksumsName(version: string): string
export function perOsChecksumsNames(version: string): string[]
export function requiredAssets(version: string): string[]
export function parseSums(text: string): Map<string, string>
export function formatSums(map: Map<string, string>): string
export function parseLatestYml(text: string): { version: string | null; files: { url: string; sha512?: string; size?: number }[] }
export function renderMarker(m: { version: string; commit: string; run: string; sha256: Record<string, string> }): string
export function parseMarker(body: string | null | undefined): any
export function evaluateRelease(release: any, opts?: { withdrawn?: string[]; tagCommit?: string; owner?: string; repo?: string }): { ok: boolean; reasons?: string[]; manifest?: any }
export function pickRelease(releases: any[], opts?: { withdrawn?: string[]; tagCommits?: Record<string, string> }): { manifest: any; rejected: { tag: string; reasons: string[] }[] }
export function noReleaseManifest(reason?: string): { status: 'none'; reason: string }
export function fillTemplate(template: string, values: Record<string, string>): string
