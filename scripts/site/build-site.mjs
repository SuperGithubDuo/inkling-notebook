#!/usr/bin/env node
/**
 * Builds the download site (site/ → _site/) for GitHub Pages.
 *
 * The site never decides what to download in the visitor's browser. This script decides once,
 * at build time, using scripts/release/rules.mjs: the newest PUBLISHED release whose notes carry
 * the verified-build marker, whose tag points at the verified commit, and whose installers still
 * match the verified SHA-256 (GitHub's asset digests). Drafts, "DO NOT PUBLISH" builds and
 * withdrawn tags are never offered. When nothing qualifies, the site says so.
 *
 *   node scripts/site/build-site.mjs [--out _site]                  # live: GitHub API (GITHUB_TOKEN optional)
 *   node scripts/site/build-site.mjs --releases-file r.json --tag-commits c.json   # offline/tests
 *   node scripts/site/build-site.mjs --allow-preview                # keep the ?preview=sample mode (local only)
 *
 * Env: GITHUB_REPOSITORY (default SuperGithubDuo/inkling-notebook), GITHUB_TOKEN, FEEDBACK_URL,
 *      GITHUB_STEP_SUMMARY (a summary of what was chosen and why others were skipped).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noReleaseManifest, pickRelease } from '../release/rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** JSON safe to place inside <script type="application/json">. */
export const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

export function injectData(html, id, value) {
  const re = new RegExp(`(<script id="${id}" type="application/json">)[\\s\\S]*?(</script>)`)
  if (!re.test(html)) throw new Error(`site/index.html has no <script id="${id}"> placeholder`)
  return html.replace(re, (_, a, b) => `${a}${scriptJson(value)}${b}`)
}

export function safeFeedbackUrl(u) {
  if (!u) return ''
  try {
    const url = new URL(u)
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : ''
  } catch {
    return ''
  }
}

export function buildSite({ siteDir, outDir, releases, tagCommits, config, feedbackUrl, allowPreview, generatedAt }) {
  const { manifest, rejected } = pickRelease(releases, { withdrawn: config.withdrawn ?? [], tagCommits })
  const release = manifest ?? noReleaseManifest()
  const site = { feedbackUrl: safeFeedbackUrl(feedbackUrl), allowPreview: !!allowPreview, generatedAt }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  cpSync(siteDir, outDir, { recursive: true, filter: (src) => !src.endsWith('config.json') })
  let html = readFileSync(join(siteDir, 'index.html'), 'utf8')
  html = injectData(html, 'inkling-release', release)
  html = injectData(html, 'inkling-site', site)
  writeFileSync(join(outDir, 'index.html'), html)
  writeFileSync(join(outDir, 'release.json'), JSON.stringify({ ...release, generatedAt }, null, 2) + '\n')
  writeFileSync(join(outDir, '.nojekyll'), '')
  return { release, rejected }
}

async function api(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  })
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'SuperGithubDuo/inkling-notebook'
  const token = process.env.GITHUB_TOKEN
  const config = JSON.parse(readFileSync(join(root, 'site', 'config.json'), 'utf8'))
  let releases, tagCommits
  if (arg('--releases-file')) {
    releases = JSON.parse(readFileSync(arg('--releases-file'), 'utf8'))
    tagCommits = arg('--tag-commits') ? JSON.parse(readFileSync(arg('--tag-commits'), 'utf8')) : {}
  } else {
    releases = await api(`repos/${repo}/releases?per_page=100`, token)
    tagCommits = {}
    for (const r of releases) {
      if (r.draft || !r.tag_name) continue
      try { tagCommits[r.tag_name] = (await api(`repos/${repo}/commits/${encodeURIComponent(r.tag_name)}`, token)).sha } catch { /* left unresolved: refused */ }
    }
  }
  const outDir = resolve(arg('--out') || join(root, '_site'))
  const { release, rejected } = buildSite({
    siteDir: join(root, 'site'),
    outDir,
    releases,
    tagCommits,
    config,
    feedbackUrl: process.env.FEEDBACK_URL || config.feedbackUrl,
    allowPreview: process.argv.includes('--allow-preview'),
    generatedAt: new Date().toISOString()
  })
  const lines = [
    release.status === 'available'
      ? `### Download site: Inkling ${release.version}\n\n${Object.values(release.downloads).map((d) => `- [${d.file}](${d.url}) · SHA-256 \`${d.sha256}\``).join('\n')}`
      : `### Download site: no release offered\n\n${release.reason}`,
    rejected.length ? `\n**Skipped:**\n${rejected.map((r) => `- ${r.tag}: ${r.reasons.join('; ')}`).join('\n')}` : ''
  ].join('\n')
  console.log(lines)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines + '\n')
  if (!existsSync(join(outDir, 'index.html'))) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
