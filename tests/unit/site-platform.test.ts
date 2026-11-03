/**
 * The download page's choice of installer (site/assets/platform.js): which card it puts first
 * and which file name the Mac install steps show. Regressions from the 2 Nov 2026 site audit:
 * - an Intel browser on an Apple-silicon Mac (Chrome under Rosetta) reported 'x86' and the
 *   page skipped the GPU check, so it recommended the Intel build;
 * - when the Mac type was unknown (every Safari visitor) or the visitor wasn't on a Mac, the
 *   Mac steps named only the Apple-silicon file.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite } from '../../scripts/site/build-site.mjs'
import { checkSite } from '../../scripts/site/check-site.mjs'

const require = createRequire(import.meta.url)
const P = require('../../site/assets/platform.js') as {
  classifyOs(ua: string, maxTouchPoints?: number): string
  macArch(o: { uaArch?: string; renderer?: string }): string
  recommend(os: string, arch: string): string | null
  macGuideFile(rec: string | null, downloads: unknown): string | null
}

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windowsArm: 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 16002.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
}

describe('download page: which computer the visitor has', () => {
  it('tells Windows, Mac, phones and tablets, and everything else apart', () => {
    expect(P.classifyOs(UA.windows, 0)).toBe('windows')
    expect(P.classifyOs(UA.windowsArm, 0)).toBe('windows') // the x64 installer runs through Windows' emulation
    expect(P.classifyOs(UA.macSafari, 0)).toBe('mac')
    expect(P.classifyOs(UA.macSafari, 5)).toBe('mobile') // an iPad asking for the desktop site
    expect(P.classifyOs(UA.iphone, 5)).toBe('mobile')
    expect(P.classifyOs(UA.android, 5)).toBe('mobile')
    expect(P.classifyOs(UA.linux, 0)).toBe('other')
    expect(P.classifyOs(UA.chromebook, 0)).toBe('other')
    expect(P.classifyOs('', undefined)).toBe('other')
  })

  it('names the Mac chip from the GPU first, then the browser’s own architecture', () => {
    // Native Chrome on Apple silicon.
    expect(P.macArch({ uaArch: 'arm', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' })).toBe('arm')
    // Regression: an Intel build of Chrome under Rosetta on Apple silicon reports x86, but the GPU is an Apple M chip.
    expect(P.macArch({ uaArch: 'x86', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' })).toBe('arm')
    // Firefox (no client hints) on Apple silicon.
    expect(P.macArch({ renderer: 'Apple M2' })).toBe('arm')
    // A real Intel Mac.
    expect(P.macArch({ uaArch: 'x86', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)' })).toBe('intel')
    expect(P.macArch({ uaArch: 'x86', renderer: 'AMD Radeon Pro 5500M OpenGL Engine' })).toBe('intel')
    expect(P.macArch({ uaArch: 'x86', renderer: '' })).toBe('intel')
    // Safari masks the GPU and has no client hints: don't guess.
    expect(P.macArch({ renderer: 'Apple GPU' })).toBe('unknown')
    expect(P.macArch({ uaArch: 'x86', renderer: 'Apple GPU' })).toBe('unknown')
    expect(P.macArch({})).toBe('unknown')
  })

  it('recommends one installer only when it is sure, and otherwise offers both Macs or everything', () => {
    expect(P.recommend('windows', 'unknown')).toBe('windows')
    expect(P.recommend('mac', 'arm')).toBe('macArm')
    expect(P.recommend('mac', 'intel')).toBe('macIntel')
    expect(P.recommend('mac', 'unknown')).toBe('mac')
    expect(P.recommend('mobile', 'unknown')).toBeNull()
    expect(P.recommend('other', 'unknown')).toBeNull()
  })

  it('the Mac install steps name the right file, or both when the Mac type is unknown', () => {
    const downloads = { macArm: { file: 'Inkling-1.0.0-arm64.dmg' }, macIntel: { file: 'Inkling-1.0.0-x64.dmg' } }
    expect(P.macGuideFile('macArm', downloads)).toBe('Inkling-1.0.0-arm64.dmg')
    expect(P.macGuideFile('macIntel', downloads)).toBe('Inkling-1.0.0-x64.dmg')
    // Regression: these used to name only the Apple-silicon file.
    expect(P.macGuideFile('mac', downloads)).toBe('Inkling-1.0.0-arm64.dmg or Inkling-1.0.0-x64.dmg')
    expect(P.macGuideFile('windows', downloads)).toBe('Inkling-1.0.0-arm64.dmg or Inkling-1.0.0-x64.dmg')
    expect(P.macGuideFile(null, downloads)).toBe('Inkling-1.0.0-arm64.dmg or Inkling-1.0.0-x64.dmg')
    expect(P.macGuideFile('mac', {})).toBeNull()
  })
})

describe('download page build', () => {
  it('ships the platform script with the page, and the deploy check requires it', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'inkling-site-')), 'site')
    const root = join(import.meta.dirname, '../..')
    buildSite({ siteDir: join(root, 'site'), outDir: out, releases: [], tagCommits: {}, config: { withdrawn: [] }, feedbackUrl: '', allowPreview: false, generatedAt: '2026-11-03T00:00:00Z' })
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(html).toContain('<script src="assets/platform.js"></script>')
    // Loaded before the page script that uses it.
    expect(html.indexOf('assets/platform.js')).toBeLessThan(html.indexOf('window.InklingPlatform'))
    expect(checkSite(out)).toEqual([])
  })
})
