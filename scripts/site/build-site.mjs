#!/usr/bin/env node
/**
 * Builds the website (site/ → _site/) for GitHub Pages: the homepage (index.html) and the
 * download page (download/index.html).
 *
 * The site never decides what to download in the visitor's browser. This script decides once,
 * at build time, using scripts/release/rules.mjs: the newest PUBLISHED release whose notes carry
 * the verified-build marker, whose tag points at the verified commit, and whose installers still
 * match the verified SHA-256 (GitHub's asset digests). Drafts, "DO NOT PUBLISH" builds and
 * withdrawn tags are never offered. When nothing qualifies, the download page says so.
 *
 * The chosen release is written into the download page as plain HTML (links work without
 * JavaScript) and as JSON for the page script, which only reorders the three verified installers
 * to put the visitor's computer first.
 *
 * Reliability: a GitHub API failure (network, 5xx, rate limit) fails the build instead of
 * quietly treating a release as unverifiable, so a hiccup can never replace a good page with an
 * older release or "nothing available". The last good deployment stays live until the next run.
 *
 *   node scripts/site/build-site.mjs [--out _site]                  # live: GitHub API (GITHUB_TOKEN optional)
 *   node scripts/site/build-site.mjs --releases-file r.json --tag-commits c.json   # offline/tests
 *
 * Env: GITHUB_REPOSITORY (default SuperGithubDuo/inkling-notebook), GITHUB_TOKEN, FEEDBACK_URL,
 *      GITHUB_STEP_SUMMARY (a summary of what was chosen and why others were skipped).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillTemplate, noReleaseManifest, pickRelease } from '../release/rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The pages the build writes, relative to the site folder. The download page carries the release. */
export const PAGES = ['index.html', 'download/index.html']
export const DOWNLOAD_PAGE = 'download/index.html'

/** JSON safe to place inside <script type="application/json">. */
export const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function injectData(html, id, value) {
  const re = new RegExp(`(<script id="${id}" type="application/json">)[\\s\\S]*?(</script>)`)
  if (!re.test(html)) throw new Error(`the page has no <script id="${id}"> placeholder`)
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

/**
 * Keeps one of the page's alternative blocks and drops the others:
 *   <!-- if:available --> … <!-- end:available -->   and   <!-- if:none --> … <!-- end:none -->
 * (likewise if:feedback / if:no-feedback). An unbalanced marker is an error, so a typo can't ship.
 */
export function keepBlocks(html, keep) {
  const out = html.replace(/<!-- if:([a-z-]+) -->([\s\S]*?)<!-- end:\1 -->/g, (_, name, body) => (keep.includes(name) ? body : ''))
  const stray = /<!-- (?:if|end):[a-z-]+ -->/.exec(out)
  if (stray) throw new Error(`unbalanced block marker ${stray[0]}`)
  return out
}

const mb = (n) => (n > 0 ? `${Math.round(n / 1e6)}\u00a0MB` : '')
/** "7 November 2026" (the site is written in British English). */
export const longDate = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** The {{KEY}} values for a page. Every value is HTML-escaped; unknown keys throw (fillTemplate). */
export function pageValues(release, site) {
  const v = { FEEDBACK_URL: site.feedbackUrl || '' }
  if (site.demoVideo) Object.assign(v, { DEMO_SRC: site.demoVideo.src, DEMO_POSTER: site.demoVideo.poster || '' })
  if (release.status === 'available') {
    const d = release.downloads
    Object.assign(v, {
      VERSION: release.version,
      RELEASED: longDate(release.publishedAt),
      RELEASE_URL: release.releaseUrl,
      CHECKSUMS_URL: release.checksumsUrl,
      COMMIT: String(release.commit).slice(0, 7)
    })
    for (const [k, key] of [['WIN', 'windows'], ['MAC_ARM', 'macArm'], ['MAC_INTEL', 'macIntel']]) {
      v[`${k}_URL`] = d[key].url
      v[`${k}_FILE`] = d[key].file
      v[`${k}_SIZE`] = mb(d[key].size)
      v[`${k}_SHA`] = d[key].sha256
    }
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escapeHtml(x)]))
}

export function renderPage(html, release, site) {
  const keep = [release.status === 'available' ? 'available' : 'none', site.feedbackUrl ? 'feedback' : 'no-feedback', site.demoVideo ? 'video' : 'no-video']
  let out = fillTemplate(keepBlocks(html, keep), pageValues(release, site))
  if (out.includes('id="inkling-release"')) out = injectData(out, 'inkling-release', release)
  if (out.includes('id="inkling-site"')) out = injectData(out, 'inkling-site', site)
  return out
}

/**
 * The homepage's demo film, from site/config.json: { "demoVideo": { "src": "assets/demo/inkling-demo.mp4",
 * "poster": "assets/demo/poster.webp" } }. Only files inside site/assets are accepted. Without it the
 * page shows a "being filmed" placeholder.
 */
export function demoVideo(v) {
  const ok = (p) => typeof p === 'string' && /^assets\/[\w./-]+$/.test(p) && !p.includes('..')
  if (!v || !ok(v.src)) return null
  return { src: v.src, poster: ok(v.poster) ? v.poster : '' }
}

export function buildSite({ siteDir, outDir, releases, tagCommits, config, feedbackUrl, generatedAt }) {
  const { manifest, rejected } = pickRelease(releases, { withdrawn: config.withdrawn ?? [], tagCommits })
  const release = manifest ?? noReleaseManifest()
  const site = { feedbackUrl: safeFeedbackUrl(feedbackUrl), demoVideo: demoVideo(config.demoVideo), generatedAt }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  cpSync(siteDir, outDir, { recursive: true, filter: (src) => !src.endsWith('config.json') })
  for (const page of PAGES) {
    const html = readFileSync(join(siteDir, page), 'utf8')
    writeFileSync(join(outDir, page), renderPage(html, release, site))
  }
  writeFileSync(join(outDir, 'release.json'), JSON.stringify({ ...release, generatedAt }, null, 2) + '\n')
  writeFileSync(join(outDir, '.nojekyll'), '')
  return { release, rejected }
}

// ------------------------------------------------------------------ GitHub API

/** An answer GitHub gave on purpose (the thing is missing or refused), as opposed to a hiccup. */
export class ApiAnswer extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * GET with retries. Network errors, 5xx and rate limits (403/429 with no remaining quota) are
 * retried, then thrown: the build must fail rather than decide with missing information.
 * Other 4xx (404 a tag that doesn't exist, 422 an unknown ref) are thrown as ApiAnswer.
 */
export async function apiGet(url, { token, fetchImpl = fetch, retries = 3, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(delayMs * attempt)
    let res
    try {
      res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    } catch (err) {
      last = new Error(`GitHub API ${url}: ${err.message}`)
      continue
    }
    if (res.ok) return { body: await res.json(), link: res.headers.get('link') ?? '' }
    const text = await res.text().catch(() => '')
    const limited = (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429 || /rate limit/i.test(text))
    if (res.status >= 500 || limited) { last = new Error(`GitHub API ${url}: ${res.status} ${text.slice(0, 200)}`); continue }
    throw new ApiAnswer(res.status, `GitHub API ${url}: ${res.status} ${text.slice(0, 200)}`)
  }
  throw last
}

/** Every release (all pages) and the commit each published release's tag points at. */
export async function fetchReleaseData(repo, opts = {}) {
  const releases = []
  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`
  for (let page = 0; url && page < 10; page++) {
    const { body, link } = await apiGet(url, opts)
    releases.push(...body)
    url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
  }
  const tagCommits = {}
  for (const r of releases) {
    if (r.draft || !r.tag_name) continue
    try {
      tagCommits[r.tag_name] = (await apiGet(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(r.tag_name)}`, opts)).body.sha
    } catch (err) {
      // A tag that really doesn't exist is GitHub's answer: that release is refused. Anything else
      // (network, outage, rate limit) stops the build so the live page isn't downgraded.
      if (!(err instanceof ApiAnswer)) throw err
    }
  }
  return { releases, tagCommits }
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'SuperGithubDuo/inkling-notebook'
  const config = JSON.parse(readFileSync(join(root, 'site', 'config.json'), 'utf8'))
  let releases, tagCommits
  if (arg('--releases-file')) {
    releases = JSON.parse(readFileSync(arg('--releases-file'), 'utf8'))
    tagCommits = arg('--tag-commits') ? JSON.parse(readFileSync(arg('--tag-commits'), 'utf8')) : {}
  } else {
    ;({ releases, tagCommits } = await fetchReleaseData(repo, { token: process.env.GITHUB_TOKEN }))
  }
  const outDir = resolve(arg('--out') || join(root, '_site'))
  const { release, rejected } = buildSite({
    siteDir: join(root, 'site'),
    outDir,
    releases,
    tagCommits,
    config,
    feedbackUrl: process.env.FEEDBACK_URL || config.feedbackUrl,
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
  if (!PAGES.every((p) => existsSync(join(outDir, p)))) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error title=Download site::${err.message} (nothing deployed; the current site stays live)`)
    process.exit(1)
  })
}
