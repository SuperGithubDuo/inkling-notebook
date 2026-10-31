#!/usr/bin/env node
/**
 * Last step of a draft build (Release workflow, job "Draft release notes").
 * Runs only after every build and test job passed. It never publishes.
 *
 * 1. Finds the DRAFT release v<version> and checks it targets the commit that was built.
 * 2. Downloads every file and checks:
 *    - every file carries the version (latest*.yml excepted) and the three installers are there;
 *    - each installer's SHA-256 matches what the installer job computed, and GitHub's own digest;
 *    - latest.yml / latest-mac.yml (in-app update metadata) name this version, and the files they
 *      point at exist with the SHA-512 and size they claim.
 * 3. Replaces the two per-OS checksum files with one Inkling-<version>-SHA256SUMS.txt.
 * 4. Writes user-friendly notes from .github/release-notes.md, ending with the hidden
 *    verified-build marker the download site requires.
 * If anything fails, the notes become DO NOT PUBLISH and the job fails.
 *
 * Usage (in the workflow): node scripts/release/finalize-draft.mjs
 * Env: GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_SERVER_URL, FEEDBACK_URL, DOWNLOAD_PAGE_URL
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  UPDATE_METADATA,
  checksumsName,
  fillTemplate,
  formatSums,
  installerNames,
  parseLatestYml,
  parseSums,
  perOsChecksumsNames,
  renderMarker
} from './rules.mjs'

export async function hashFile(path, algorithm, encoding = 'hex') {
  const h = createHash(algorithm)
  await new Promise((resolve, reject) => createReadStream(path).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject))
  return h.digest(encoding)
}

/**
 * api: { getDraft(tag) -> release (REST shape, incl. assets with digest) | null,
 *        downloadAll(tag, dir), upload(tag, path), deleteAsset(tag, name) }
 * Returns the notes text. Throws with a readable message on any problem.
 */
export async function finalizeDraft({ api, version, sha, runUrl, feedback, downloadPage, template, workDir }) {
  const tag = `v${version}`
  const problems = []
  const draft = await api.getDraft(tag)
  if (!draft) throw new Error(`No draft release ${tag} found`)
  if (draft.draft !== true) throw new Error(`${tag} is already published; refusing to change it`)
  if (draft.target_commitish !== sha) problems.push(`the draft targets ${draft.target_commitish}, but this run built ${sha}`)

  await api.downloadAll(tag, workDir)
  const names = readdirSync(workDir).sort()
  const remote = new Map((draft.assets ?? []).map((a) => [a.name, a]))
  for (const n of names) if (!remote.has(n)) problems.push(`downloaded ${n}, which the release doesn't list`)
  for (const n of remote.keys()) if (!names.includes(n)) problems.push(`could not download ${n}`)

  const bad = names.filter((n) => !UPDATE_METADATA.includes(n) && !n.includes(`-${version}-`) && !n.includes(`-${version}.`))
  if (bad.length) problems.push(`files without version ${version}: ${bad.join(', ')}`)

  // Checksums the installer jobs computed on the build machines.
  const perOs = new Map()
  for (const f of perOsChecksumsNames(version)) {
    if (!names.includes(f)) problems.push(`${f} is missing`)
    else for (const [k, v] of parseSums(readFileSync(join(workDir, f), 'utf8'))) perOs.set(k, v)
  }

  const sha256 = {}
  for (const name of Object.values(installerNames(version))) {
    if (!names.includes(name)) { problems.push(`${name} is missing`); continue }
    const hex = await hashFile(join(workDir, name), 'sha256')
    sha256[name] = hex
    if (perOs.get(name) !== hex) problems.push(`${name}: SHA-256 differs from the one computed when it was built`)
    const digest = remote.get(name)?.digest
    if (digest && digest !== `sha256:${hex}`) problems.push(`${name}: GitHub's digest ${digest} differs from the downloaded file`)
  }

  for (const yml of UPDATE_METADATA) {
    if (!names.includes(yml)) { problems.push(`${yml} (update metadata) is missing`); continue }
    const meta = parseLatestYml(readFileSync(join(workDir, yml), 'utf8'))
    if (meta.version !== version) problems.push(`${yml} says version ${meta.version}, expected ${version}`)
    if (!meta.files.length) problems.push(`${yml} lists no files`)
    for (const f of meta.files) {
      if (!names.includes(f.url)) { problems.push(`${yml} points at ${f.url}, which isn't in the release`); continue }
      const p = join(workDir, f.url)
      if ((await hashFile(p, 'sha512', 'base64')) !== f.sha512) problems.push(`${yml}: SHA-512 of ${f.url} doesn't match`)
      if (f.size !== undefined && readFileSync(p).length !== f.size) problems.push(`${yml}: size of ${f.url} doesn't match`)
    }
  }

  if (problems.length) throw new Error(problems.map((p) => `- ${p}`).join('\n'))

  // One checksum file for users instead of two.
  const sumsText = formatSums(new Map(Object.entries(sha256)))
  const sumsPath = join(workDir, checksumsName(version))
  writeFileSync(sumsPath, sumsText)
  await api.upload(tag, sumsPath)
  for (const f of perOsChecksumsNames(version)) await api.deleteAsset(tag, f)

  const notes = fillTemplate(template, {
    VERSION: version,
    SHA256SUMS: sumsText.trim(),
    FEEDBACK: feedback || '*(feedback form link to be added)*',
    COMMIT: sha,
    RUN: runUrl,
    DOWNLOAD_PAGE: downloadPage
  })
  return `${notes.trimEnd()}\n\n${renderMarker({ version, commit: sha, run: runUrl, sha256 })}\n`
}

function gh(args, opts = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

export function ghApi(repo) {
  return {
    async getDraft(tag) {
      // Drafts have no git tag yet, so they can't be fetched by tag; list and match.
      const all = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]))
      return all.find((r) => r.tag_name === tag && r.draft) ?? all.find((r) => r.tag_name === tag) ?? null
    },
    async downloadAll(tag, dir) { gh(['release', 'download', tag, '-R', repo, '-D', dir, '--clobber']) },
    async upload(tag, path) { gh(['release', 'upload', tag, path, '--clobber', '-R', repo]) },
    async deleteAsset(tag, name) { gh(['release', 'delete-asset', tag, name, '--yes', '-R', repo]) },
    async editNotes(tag, text) {
      const f = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.md')
      writeFileSync(f, text)
      gh(['release', 'edit', tag, '-R', repo, '--notes-file', f])
    }
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  const api = ghApi(repo)
  const workDir = mkdtempSync(join(tmpdir(), 'inkling-release-'))
  try {
    const notes = await finalizeDraft({
      api,
      version,
      sha: process.env.GITHUB_SHA,
      runUrl,
      feedback: process.env.FEEDBACK_URL,
      downloadPage: process.env.DOWNLOAD_PAGE_URL || `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/`,
      template: readFileSync('.github/release-notes.md', 'utf8'),
      workDir
    })
    await api.editNotes(`v${version}`, notes)
    console.log(`::notice title=Draft release ready for review::v${version}: files, checksums and update metadata verified. Still a draft: nothing is public until someone presses Publish.`)
  } catch (err) {
    const msg = String(err?.message ?? err)
    console.log(`::error title=Draft release verification failed::${msg.replace(/\n/g, '%0A')}`)
    if (existsSync('package.json')) {
      try { await api.editNotes(`v${version}`, `**DO NOT PUBLISH.** The files of this draft failed verification in ${runUrl}:\n\n${msg}\n\nFix it and push build/draft-release again.`) } catch {}
    }
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
