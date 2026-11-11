export function hashFile(path: string, algorithm: string, encoding?: 'hex' | 'base64'): Promise<string>
export function finalizeDraft(opts: {
  api: { getDraft(tag: string): Promise<any>; downloadAll(tag: string, dir: string): Promise<void>; upload(tag: string, path: string): Promise<void>; deleteAsset(tag: string, name: string): Promise<void> }
  version: string; sha: string; runUrl: string; feedback?: string; downloadPage: string; template: string; workDir: string
  /** Whether each installer was code-signed. A stable (non-prerelease) version must be signed on both. */
  signed?: { windows: boolean; mac: boolean }
}): Promise<string>
export function ghApi(repo: string): any
