/**
 * Download page acceptance test: the built page (scripts/site/build-site.mjs) in a real
 * Chromium (Electron), served over HTTP, as Windows, Mac, phone and Linux visitors see it.
 *
 * Covers, for a published verified release and for "no release yet":
 * - which installer is recommended (hero button and "Your computer" card), including an
 *   Intel browser on an Apple-silicon Mac, and an x86 browser with WebGL unavailable, which
 *   gets both Macs (regressions, 2 Nov 2026 audit);
 * - the Mac install steps name the right file, or both when the Mac type is unknown (regression);
 * - every download link is one of the three verified installers; none before a release;
 * - no sideways scrolling at 320, 375, 768 and 1280 px.
 *
 * The browser is described by stubbing what the page reads: the user agent, User-Agent Client
 * Hints (navigator.userAgentData) and the WebGL renderer name.
 *
 * Usage: xvfb-run -a node tests/e2e/site.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { electronPath } from '../support/electronPath.mjs'
import { buildSite } from '../../scripts/site/build-site.mjs'
import { checksumsName, installerNames, renderMarker } from '../../scripts/release/rules.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
mkdirSync(shots, { recursive: true })
const step = (msg) => console.log(`  ✓ ${msg}`)

// ------------------------------------------------------------------ the two sites
const V = '0.9.0-beta.1'
const TAG = `v${V}`
const COMMIT = 'c'.repeat(40)
const PREFIX = `https://github.com/SuperGithubDuo/inkling-notebook/releases/download/${TAG}/`
const names = installerNames(V)
const sha256 = Object.fromEntries(Object.values(names).map((n) => [n, createHash('sha256').update(n).digest('hex')]))
const release = {
  draft: false,
  prerelease: true,
  tag_name: TAG,
  name: `Inkling ${V}`,
  published_at: '2026-11-10T17:00:00Z',
  html_url: `https://github.com/SuperGithubDuo/inkling-notebook/releases/tag/${TAG}`,
  body: `Notes\n\n${renderMarker({ version: V, commit: COMMIT, run: 'https://example.invalid/run/1', sha256 })}`,
  assets: [...Object.values(names), checksumsName(V), 'latest.yml', 'latest-mac.yml'].map((name) => ({
    name,
    state: 'uploaded',
    size: 130_000_000,
    browser_download_url: PREFIX + name,
    ...(sha256[name] ? { digest: `sha256:${sha256[name]}` } : {})
  }))
}
const tmp = mkdtempSync(join(tmpdir(), 'inkling-site-e2e-'))
const build = (dir, releases) =>
  buildSite({ siteDir: join(root, 'site'), outDir: join(tmp, dir), releases, tagCommits: { [TAG]: COMMIT }, config: { withdrawn: [] }, feedbackUrl: '', allowPreview: false, generatedAt: '2026-11-10T17:05:00Z' })
assert.equal(build('released', [release]).release.status, 'available')
assert.equal(build('none', []).release.status, 'none')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0])
  const file = join(tmp, path.endsWith('/') ? `${path}index.html` : path)
  if (!file.startsWith(tmp) || !existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ------------------------------------------------------------------ visitors
const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
}
const VISITORS = {
  windows: { ua: UA.windows, uaArch: 'x86', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)', touch: 0 },
  macArmChrome: { ua: UA.macChrome, uaArch: 'arm', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', touch: 0 },
  macRosettaChrome: { ua: UA.macChrome, uaArch: 'x86', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', touch: 0 },
  macIntelChrome: { ua: UA.macChrome, uaArch: 'x86', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)', touch: 0 },
  macX86NoWebgl: { ua: UA.macChrome, uaArch: 'x86', renderer: null, touch: 0 },
  macSafari: { ua: UA.macSafari, uaArch: null, renderer: 'Apple GPU', touch: 0 },
  iphone: { ua: UA.iphone, uaArch: null, renderer: 'Apple GPU', touch: 5 },
  linux: { ua: UA.linux, uaArch: 'x86', renderer: 'Mesa Intel(R) UHD Graphics', touch: 0 }
}

/** Runs in the page before its scripts: describes the browser the way the page reads it. */
function describeBrowser(v) {
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => v.touch, configurable: true })
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => (v.uaArch ? { getHighEntropyValues: async () => ({ architecture: v.uaArch }) } : undefined),
    configurable: true
  })
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    if (kind !== 'webgl') return original.call(this, kind, ...rest)
    if (v.renderer === null) return null // WebGL switched off or unavailable
    return { getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null), getParameter: (p) => (p === 37446 ? v.renderer : null) }
  }
}

const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', join(root, 'tests/support/siteBrowser.cjs')], env })
const page = await app.firstWindow()

async function visit(site, who, width = 1280) {
  const v = VISITORS[who]
  await app.evaluate(({ BrowserWindow }, ua) => BrowserWindow.getAllWindows()[0].webContents.setUserAgent(ua), v.ua)
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript(describeBrowser, v)
  await page.goto(`${base}/${site}/`)
  // The page renders after its asynchronous browser check.
  await page.waitForFunction(() => document.getElementById('platforms').children.length === 3)
  return page.evaluate(() => {
    const shown = (e) => !!e && !e.closest('[hidden]') && e.getClientRects().length > 0
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
    return {
      hero: [...document.querySelectorAll('#cta-row a.btn')].filter(shown).map((a) => a.getAttribute('href')),
      recommended: [...document.querySelectorAll('#platforms .card.recommended h3')].map((h) => h.textContent),
      cards: [...document.querySelectorAll('#platforms .card a.btn')].map((a) => a.getAttribute('href')),
      macGuide: document.querySelector('[data-file="mac"]').textContent,
      winGuide: document.querySelector('[data-file="windows"]').textContent,
      macTab: document.getElementById('tab-mac').getAttribute('aria-selected') === 'true',
      status: shown(document.getElementById('status')),
      mobileNote: shown(document.getElementById('mobile-note')),
      downloads: hrefs.filter((h) => /\/releases\/download\//.test(h)),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })
}
const url = (k) => PREFIX + names[k]

try {
  console.log('site')
  let r = await visit('released', 'windows')
  assert.deepEqual(r.hero, [url('windows')])
  assert.deepEqual(r.recommended, ['Windows'])
  assert.equal(r.winGuide, names.windows)
  assert.equal(r.macTab, false)
  await page.screenshot({ path: join(shots, 'site-windows.png'), fullPage: true })
  step('Windows: the Windows installer first, with its file name in the steps')

  r = await visit('released', 'macArmChrome')
  assert.deepEqual(r.hero, [url('macArm')])
  assert.deepEqual(r.recommended, ['Mac with Apple silicon'])
  assert.equal(r.macGuide, names.macArm)
  assert.equal(r.macTab, true)
  r = await visit('released', 'macRosettaChrome')
  assert.deepEqual(r.hero, [url('macArm')], 'an Intel browser on Apple silicon still gets the Apple-silicon build')
  assert.equal(r.macGuide, names.macArm)
  r = await visit('released', 'macIntelChrome')
  assert.deepEqual(r.hero, [url('macIntel')])
  assert.deepEqual(r.recommended, ['Mac with Intel'])
  assert.equal(r.macGuide, names.macIntel)
  r = await visit('released', 'macX86NoWebgl')
  assert.deepEqual(r.hero, [url('macArm'), url('macIntel')], 'x86 without a GPU name could be either Mac: both offered')
  assert.deepEqual(r.recommended, [])
  assert.equal(r.macGuide, `${names.macArm} or ${names.macIntel}`)
  step('Mac: Apple silicon and Intel told apart, including an Intel browser under Rosetta; x86 without WebGL offers both')

  r = await visit('released', 'macSafari')
  assert.deepEqual(r.hero, [url('macArm'), url('macIntel')], 'unsure which Mac: both offered')
  assert.equal(r.macGuide, `${names.macArm} or ${names.macIntel}`)
  assert.equal(r.macTab, true)
  await page.screenshot({ path: join(shots, 'site-mac-safari.png'), fullPage: true })
  step('Safari (Mac type hidden): both Mac installers offered; the steps name both files')

  r = await visit('released', 'iphone', 375)
  assert.deepEqual(r.hero, [], 'no download button at the top on a phone')
  assert.equal(r.mobileNote, true)
  assert.deepEqual(r.recommended, [])
  await page.screenshot({ path: join(shots, 'site-iphone.png'), fullPage: true })
  r = await visit('released', 'linux')
  assert.deepEqual(r.hero, [url('windows'), url('macArm'), url('macIntel')])
  assert.equal(r.macGuide, `${names.macArm} or ${names.macIntel}`)
  step('phones explain there is no phone version; other computers see all three installers')

  for (const site of ['released', 'none']) {
    for (const width of [320, 375, 768, 1280]) {
      r = await visit(site, width < 768 ? 'iphone' : 'windows', width)
      assert.equal(r.sideways, false, `${site} at ${width} px scrolls sideways`)
      const allowed = site === 'released' ? Object.keys(names).map(url) : []
      for (const h of r.downloads) assert.ok(allowed.includes(h), `${site}: unexpected download link ${h}`)
      if (site === 'none') assert.deepEqual(r.downloads, [], 'no download links before a release')
    }
  }
  r = await visit('none', 'windows')
  assert.equal(r.status, true)
  assert.deepEqual(r.cards, [null, null, null], 'buttons are disabled before a release')
  await page.screenshot({ path: join(shots, 'site-none.png'), fullPage: true })
  step('no sideways scrolling at 320–1280 px; links only to verified installers; none before a release')

  console.log('\nDownload site acceptance: all checks passed')
} catch (err) {
  console.error('\nDownload site acceptance FAILED:', err)
  await page.screenshot({ path: join(shots, 'site-failure.png'), fullPage: true }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
  server.close()
}
