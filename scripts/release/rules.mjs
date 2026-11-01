/**
 * The rules that decide which Inkling build ordinary users may download.
 *
 * Shared by:
 * - scripts/release/finalize-draft.mjs (Release workflow): verifies a draft's
 *   files and writes its notes, including the "verified build" marker;
 * - scripts/site/build-site.mjs (download site): picks the newest PUBLISHED
 *   release that carries that marker and whose files still match it.
 *
 * Pure functions only (no network, no filesystem), so tests/unit/release-rules.test.ts
 * can cover every way a release can be refused.
 */

export const OWNER = 'SuperGithubDuo'
export const REPO = 'inkling-notebook'

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

/** The three files a user ever needs, by platform. */
export function installerNames(version) {
  return {
    windows: `Inkling-Setup-${version}-x64.exe`,
    macArm: `Inkling-${version}-arm64.dmg`,
    macIntel: `Inkling-${version}-x64.dmg`
  }
}

export const checksumsName = (version) => `Inkling-${version}-SHA256SUMS.txt`
/** Per-OS checksum files the installer jobs upload; finalize-draft merges them into one. */
export const perOsChecksumsNames = (version) => [`Inkling-${version}-SHA256SUMS-Windows.txt`, `Inkling-${version}-SHA256SUMS-macOS.txt`]
export const UPDATE_METADATA = ['latest.yml', 'latest-mac.yml']

/** Files a finished release must contain. (.zip and .blockmap files are allowed too: in-app updates use them.) */
export function requiredAssets(version) {
  return [...Object.values(installerNames(version)), checksumsName(version), ...UPDATE_METADATA]
}

const HEX64 = /^[0-9a-f]{64}$/

/** `sha256sum` format: "<hex>  <name>" per line. */
export function parseSums(text) {
  const out = new Map()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!m) throw new Error(`Unreadable checksum line: ${line}`)
    out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

export function formatSums(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hex]) => `${hex}  ${name}`)
    .join('\n') + '\n'
}

/** The subset of electron-builder's latest*.yml that matters: version and the files it points at. */
export function parseLatestYml(text) {
  const lines = String(text).split(/\r?\n/)
  const unq = (s) => s.trim().replace(/^['"]|['"]$/g, '')
  let version = null
  const files = []
  let cur = null
  let inFiles = false
  for (const line of lines) {
    let m
    if ((m = /^version:\s*(.+)$/.exec(line))) { version = unq(m[1]); inFiles = false; continue }
    if (/^files:\s*$/.test(line)) { inFiles = true; continue }
    if (/^\S/.test(line)) { inFiles = false; continue }
    if (!inFiles) continue
    if ((m = /^\s*-\s*url:\s*(.+)$/.exec(line))) { cur = { url: unq(m[1]) }; files.push(cur); continue }
    if (cur && (m = /^\s+sha512:\s*(.+)$/.exec(line))) cur.sha512 = unq(m[1])
    else if (cur && (m = /^\s+size:\s*(\d+)\s*$/.exec(line))) cur.size = Number(m[1])
  }
  return { version, files }
}

const MARKER_RE = /<!--\s*inkling-verified-build\s+(\{[\s\S]*?\})\s*-->/

/**
 * Written into the release notes only by finalize-draft after every build, test and file check
 * passed. It records what was verified, so the download site can check the files haven't changed.
 */
export function renderMarker({ version, commit, run, sha256 }) {
  return `<!-- inkling-verified-build ${JSON.stringify({ version, commit, run, sha256 })} -->`
}

export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''))
  if (!m) return null
  try {
    const v = JSON.parse(m[1])
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** Phrases that must keep a release off the download page, wherever they appear in its notes or title. */
export const BLOCKING_PHRASES = [/DO NOT PUBLISH/i, /\bWITHDRAWN\b/i, /\bNOT FOR DOWNLOAD\b/i]

/**
 * Decides whether one GitHub release (REST API shape) may be offered as a download.
 * opts.tagCommit: the commit the release's git tag points at (resolved by the caller).
 * opts.withdrawn: tags that must never be offered again.
 * Returns { ok: true, manifest } or { ok: false, reasons }.
 */
export function evaluateRelease(release, opts = {}) {
  const { withdrawn = [], tagCommit, owner = OWNER, repo = REPO } = opts
  const reasons = []
  const tag = String(release?.tag_name ?? '')
  const version = tag.startsWith('v') ? tag.slice(1) : ''

  if (!release || typeof release !== 'object') return { ok: false, reasons: ['no release'] }
  if (release.draft !== false) reasons.push('draft: not published (publishing is the approval step)')
  if (!VERSION_RE.test(version)) reasons.push(`tag "${tag}" is not v<version>`)
  if (withdrawn.includes(tag)) reasons.push(`${tag} is listed as withdrawn in site/config.json`)
  const text = `${release.name ?? ''}\n${release.body ?? ''}`
  for (const re of BLOCKING_PHRASES) if (re.test(text)) reasons.push(`notes or title say "${re.source.replace(/\\b/g, '')}"`)

  const marker = parseMarker(release.body)
  if (!marker) reasons.push('no verified-build marker: the Release workflow did not finish verifying this build')
  else {
    if (marker.version !== version) reasons.push(`marker is for version ${marker.version}, release is ${version}`)
    if (!/^[0-9a-f]{40}$/.test(String(marker.commit))) reasons.push('marker has no source commit')
    else if (!tagCommit) reasons.push('could not confirm which commit the tag points at')
    else if (tagCommit !== marker.commit) reasons.push(`tag points at ${tagCommit.slice(0, 7)}, but ${String(marker.commit).slice(0, 7)} was verified`)
  }

  const assets = new Map((release.assets ?? []).map((a) => [a.name, a]))
  const prefix = `https://github.com/${owner}/${repo}/releases/download/${tag}/`
  const downloads = {}
  if (VERSION_RE.test(version)) {
    for (const name of requiredAssets(version)) {
      const a = assets.get(name)
      if (!a) reasons.push(`missing ${name}`)
      else if (a.state !== 'uploaded' || !(a.size > 0)) reasons.push(`${name} is not completely uploaded`)
    }
    for (const [platform, name] of Object.entries(installerNames(version))) {
      const a = assets.get(name)
      if (!a) continue
      const expected = marker?.sha256?.[name]
      if (!HEX64.test(String(expected))) { reasons.push(`no verified SHA-256 for ${name}`); continue }
      if (!a.digest) reasons.push(`GitHub reports no digest for ${name}, so it can't be compared with the verified checksum`)
      else if (a.digest !== `sha256:${expected}`) reasons.push(`${name} changed after it was verified`)
      if (a.browser_download_url !== prefix + encodeURIComponent(name)) reasons.push(`${name} has an unexpected download address`)
      downloads[platform] = { file: name, url: a.browser_download_url, size: a.size, sha256: expected }
    }
  }

  if (reasons.length) return { ok: false, reasons }
  const sums = assets.get(checksumsName(version))
  return {
    ok: true,
    manifest: {
      status: 'available',
      version,
      tag,
      prerelease: !!release.prerelease,
      publishedAt: release.published_at,
      releaseUrl: release.html_url,
      commit: marker.commit,
      checksumsUrl: sums.browser_download_url,
      downloads
    }
  }
}

/** Newest published release that passes, plus why the others were skipped. */
export function pickRelease(releases, opts = {}) {
  const rejected = []
  const candidates = [...(releases ?? [])]
    .filter((r) => {
      if (r.draft !== false) { rejected.push({ tag: r.tag_name || '(draft without tag)', reasons: ['draft: not published'] }); return false }
      return true
    })
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
  for (const r of candidates) {
    const res = evaluateRelease(r, { ...opts, tagCommit: opts.tagCommits?.[r.tag_name] })
    if (res.ok) return { manifest: res.manifest, rejected }
    rejected.push({ tag: r.tag_name, reasons: res.reasons })
  }
  return { manifest: null, rejected }
}

/** What the site shows when nothing may be downloaded. */
export function noReleaseManifest(reason = 'No approved release has been published yet.') {
  return { status: 'none', reason }
}

/** Replaces {{KEY}} placeholders; unknown placeholders are an error so a typo can't ship. */
export function fillTemplate(template, values) {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, key) => {
    if (!(key in values)) throw new Error(`Release notes template uses unknown {{${key}}}`)
    return String(values[key])
  })
  return out
}
