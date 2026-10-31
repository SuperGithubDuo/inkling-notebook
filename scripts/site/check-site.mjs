#!/usr/bin/env node
/**
 * Final gate before the download site is deployed. Fails if the built page could send anyone
 * to something other than a verified installer of a published release:
 * - the embedded release data must match release.json and point only at
 *   https://github.com/SuperGithubDuo/inkling-notebook/releases/download/<tag>/<expected file>;
 * - no workflow artifacts (/actions/), draft-release ("untagged-") or other download links anywhere;
 * - the local preview mode is switched off;
 * - every local file the page references exists.
 *
 *   node scripts/site/check-site.mjs _site
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNER, REPO, installerNames } from '../release/rules.mjs'

export function checkSite(dir) {
  const problems = []
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  const data = (id) => {
    const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html)
    if (!m) { problems.push(`missing ${id} data`); return null }
    try { return JSON.parse(m[1]) } catch { problems.push(`${id} data is not JSON`); return null }
  }
  const release = data('inkling-release')
  const site = data('inkling-site')
  const file = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'))

  if (site?.allowPreview !== false) problems.push('preview mode is not switched off')
  if (site?.feedbackUrl && !/^(https:|mailto:)/.test(site.feedbackUrl)) problems.push('feedback link must be https: or mailto:')

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
      if (!/^[0-9a-f]{64}$/.test(String(d.sha256))) problems.push(`${k}: no SHA-256`)
    }
  } else if (release?.status !== 'none') problems.push(`unknown release status ${release?.status}`)
  else if (file.status !== 'none') problems.push('release.json and the page disagree')

  const body = html.replace(/<script id="inkling-release"[\s\S]*?<\/script>/, '')
  if (/\/actions\/(runs|artifacts)/.test(html)) problems.push('links to workflow runs or artifacts')
  if (/untagged-/.test(html)) problems.push('links to a draft release')
  if (/(href|src)="[^"]*\/releases\/download\//.test(body)) problems.push('download links outside the verified release data')

  for (const m of html.matchAll(/(?:src|href)="(assets\/[^"#?]+)"|url\("(assets\/[^"]+)"\)/g)) {
    const ref = m[1] || m[2]
    if (!existsSync(join(dir, ref))) problems.push(`missing file ${ref}`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] || '_site')
  const problems = checkSite(dir)
  if (problems.length) {
    for (const p of problems) console.log(`::error title=Download site::${p}`)
    process.exit(1)
  }
  console.log('Download site check passed.')
}
