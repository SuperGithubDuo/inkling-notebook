#!/usr/bin/env node
/**
 * Final gate before the website is deployed. Fails if any built page could send anyone to
 * something other than a verified installer of a published release:
 * - the download page's embedded release data must match release.json and point only at
 *   https://github.com/SuperGithubDuo/inkling-notebook/releases/download/<tag>/<expected file>;
 * - every link to a release file, on every page, must be exactly one of those verified files
 *   (the three installers and the checksum file), and there are none at all when no release is offered;
 * - no workflow artifacts (/actions/), draft-release ("untagged-") or unfilled template parts;
 * - every local file a page references exists;
 * - the web app the pages' "Open Inkling" opens is there (app/).
 *
 *   node scripts/site/check-site.mjs _site
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNER, REPO, installerNames } from '../release/rules.mjs'

const PAGES = ['index.html', 'download/index.html']

const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

export function checkSite(dir, { requireApp = false } = {}) {
  const problems = []
  const pages = {}
  for (const p of PAGES) {
    if (!existsSync(join(dir, p))) problems.push(`missing page ${p}`)
    else pages[p] = readFileSync(join(dir, p), 'utf8')
  }
  // “Open Inkling” must open something: the web app, its service worker and manifest.
  if (requireApp) for (const f of ['app/index.html', 'app/sw.js', 'app/manifest.webmanifest']) if (!existsSync(join(dir, f))) problems.push(`missing ${f}: build the web app first (npm run build:web) and pass --app out/web`)
  const html = pages['download/index.html'] ?? ''
  const data = (id) => {
    const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html)
    if (!m) { problems.push(`missing ${id} data`); return null }
    try { return JSON.parse(m[1]) } catch { problems.push(`${id} data is not JSON`); return null }
  }
  const release = data('inkling-release')
  const site = data('inkling-site')
  const file = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'))

  if (site?.feedbackUrl && !/^(https:|mailto:)/.test(site.feedbackUrl)) problems.push('feedback link must be https: or mailto:')

  const allowed = new Set()
  if (release?.status === 'available') {
    const { generatedAt, ...fromFile } = file
    if (JSON.stringify(fromFile) !== JSON.stringify(release)) problems.push('release.json and the page disagree')
    const names = installerNames(release.version)
    const prefix = `https://github.com/${OWNER}/${REPO}/releases/download/${release.tag}/`
    if (release.tag !== `v${release.version}`) problems.push('tag and version disagree')
    for (const [k, name] of Object.entries(names)) {
      const d = release.downloads?.[k]
      if (!d) { problems.push(`no ${k} download`); continue }
      if (d.file !== name) problems.push(`${k}: expected ${name}, got ${d.file}`)
      if (d.url !== prefix + encodeURIComponent(name)) problems.push(`${k}: unexpected link ${d.url}`)
      else allowed.add(d.url)
      if (!/^[0-9a-f]{64}$/.test(String(d.sha256))) problems.push(`${k}: no SHA-256`)
    }
    if (release.checksumsUrl === `${prefix}Inkling-${release.version}-SHA256SUMS.txt`) allowed.add(release.checksumsUrl)
    else problems.push(`unexpected checksum link ${release.checksumsUrl}`)
  } else if (release?.status !== 'none') problems.push(`unknown release status ${release?.status}`)
  else if (file.status !== 'none') problems.push('release.json and the page disagree')

  for (const [page, text] of Object.entries(pages)) {
    if (/\/actions\/(runs|artifacts)/.test(text)) problems.push(`${page}: links to workflow runs or artifacts`)
    if (/untagged-/.test(text)) problems.push(`${page}: links to a draft release`)
    if (/\{\{[A-Z0-9_]+\}\}|<!-- (?:if|end):/.test(text)) problems.push(`${page}: unfilled template parts`)
    const body = text.replace(/<script id="inkling-release"[\s\S]*?<\/script>/, '')
    for (const m of body.matchAll(/(?:href|src)="([^"]*\/releases\/download\/[^"]*)"/g)) {
      if (!allowed.has(unescape(m[1]))) problems.push(`${page}: download link to something other than a verified installer: ${m[1]}`)
    }
    if (page !== 'download/index.html' && /\/releases\/download\//.test(body)) problems.push(`${page}: release files are only linked from the download page`)
    const base = dirname(join(dir, page))
    for (const m of text.matchAll(/(?:src|href)="((?:\.\.\/)*assets\/[^"#?]+)"|url\("((?:\.\.\/)*assets\/[^"]+)"\)/g)) {
      const ref = m[1] || m[2]
      const target = normalize(join(base, ref))
      if (!target.startsWith(resolve(dir)) || !existsSync(target)) problems.push(`${page}: missing file ${ref}`)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] || '_site')
  const problems = checkSite(dir, { requireApp: true })
  if (problems.length) {
    for (const p of problems) console.log(`::error title=Download site::${p}`)
    process.exit(1)
  }
  console.log('Download site check passed.')
}
