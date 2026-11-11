import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approvalName,
  checkApproval,
  checksumsName,
  evaluateRelease,
  fillTemplate,
  formatSums,
  installerNames,
  parseLatestYml,
  parseMarker,
  parseSums,
  pickRelease,
  renderApproval,
  renderMarker
} from '../../scripts/release/rules.mjs'
import { finalizeDraft } from '../../scripts/release/finalize-draft.mjs'
import { buildSite, fetchReleaseData, injectData, keepBlocks, renderPage } from '../../scripts/site/build-site.mjs'
import { checkSite } from '../../scripts/site/check-site.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const V = '0.2.0-beta.3'
const TAG = `v${V}`
const SHA = 'a'.repeat(40)
const PREFIX = `https://github.com/SuperGithubDuo/inkling-notebook/releases/download/${TAG}/`
const hex = (s: string) => createHash('sha256').update(s).digest('hex')

function goodRelease(over: Record<string, unknown> = {}) {
  const names = installerNames(V)
  const sha256 = Object.fromEntries(Object.values(names).map((n) => [n, hex(n)]))
  const asset = (name: string) => ({ name, state: 'uploaded', size: 1000, browser_download_url: PREFIX + name, ...(sha256[name] ? { digest: `sha256:${sha256[name]}` } : {}) })
  return {
    draft: false,
    prerelease: true,
    tag_name: TAG,
    name: `Inkling ${V}`,
    published_at: '2026-11-07T17:00:00Z',
    html_url: `https://github.com/SuperGithubDuo/inkling-notebook/releases/tag/${TAG}`,
    body: `Notes\n\n${renderMarker({ version: V, commit: SHA, run: 'https://example.invalid/run/1', sha256 })}`,
    assets: [
      ...Object.values(names),
      checksumsName(V),
      'latest.yml',
      'latest-mac.yml',
      `Inkling-${V}-arm64-mac.zip`,
      `Inkling-Setup-${V}-x64.exe.blockmap`
    ].map(asset),
    ...over
  }
}

describe('which releases the download site may offer', () => {
  it('offers a published, verified release with direct links to the three installers', () => {
    const r = evaluateRelease(goodRelease(), { tagCommit: SHA })
    expect(r.ok).toBe(true)
    expect(r.manifest.downloads.windows).toMatchObject({ file: `Inkling-Setup-${V}-x64.exe`, url: `${PREFIX}Inkling-Setup-${V}-x64.exe` })
    expect(r.manifest.downloads.macArm.file).toBe(`Inkling-${V}-arm64.dmg`)
    expect(r.manifest.downloads.macIntel.file).toBe(`Inkling-${V}-x64.dmg`)
    expect(r.manifest.commit).toBe(SHA)
  })

  const refusals: [string, Record<string, unknown>, Record<string, unknown>, RegExp][] = [
    ['a draft (not yet approved)', { draft: true }, {}, /draft/],
    ['notes saying DO NOT PUBLISH', { body: `**DO NOT PUBLISH.** failed\n${goodRelease().body}` }, {}, /DO NOT PUBLISH/],
    ['a withdrawn title', { name: 'Inkling (WITHDRAWN)' }, {}, /WITHDRAWN/],
    ['no verified-build marker (published by hand)', { body: 'Notes only' }, {}, /verified-build marker/],
    ['a tag pointing at another commit', {}, { tagCommit: 'b'.repeat(40) }, /tag points at/],
    ['an unresolvable tag', {}, { tagCommit: undefined }, /could not confirm/],
    ['a tag listed as withdrawn', {}, { withdrawn: [TAG] }, /withdrawn/],
    ['a bad tag', { tag_name: 'beta' }, {}, /not v<version>/]
  ]
  for (const [what, over, opts, re] of refusals) {
    it(`refuses ${what}`, () => {
      const r = evaluateRelease(goodRelease(over), { tagCommit: SHA, ...opts })
      expect(r.ok).toBe(false)
      expect(r.reasons!.join('\n')).toMatch(re)
    })
  }

  it('refuses a release whose installer was replaced after verification', () => {
    const rel = goodRelease()
    rel.assets[0]!.digest = `sha256:${'0'.repeat(64)}`
    expect(evaluateRelease(rel, { tagCommit: SHA }).reasons!.join()).toMatch(/changed after it was verified/)
  })

  it('refuses missing files, incomplete uploads, missing digests and odd links', () => {
    const rel = goodRelease()
    rel.assets = rel.assets.filter((a) => a.name !== `Inkling-${V}-x64.dmg`)
    rel.assets[0] = { ...rel.assets[0]!, state: 'starter' }
    delete (rel.assets[1] as { digest?: string }).digest
    rel.assets[2] = { ...rel.assets[2]!, browser_download_url: 'https://example.com/x' }
    const reasons = evaluateRelease(rel, { tagCommit: SHA }).reasons!.join('\n')
    expect(reasons).toMatch(/missing Inkling-0\.2\.0-beta\.3-x64\.dmg/)
    expect(reasons).toMatch(/not completely uploaded/)
    expect(reasons).toMatch(/no digest/)
  })

  it('refuses a marker for another version', () => {
    const rel = goodRelease({ body: renderMarker({ version: '0.2.0-beta.2', commit: SHA, run: 'x', sha256: {} }) })
    expect(evaluateRelease(rel, { tagCommit: SHA }).reasons!.join()).toMatch(/marker is for version 0\.2\.0-beta\.2/)
  })

  it('today: the only release is the failed DO NOT PUBLISH draft, so nothing is offered', () => {
    // Shape of the real v0.2.0-beta.2 draft on 31 Oct 2026.
    const draft = {
      draft: true,
      prerelease: true,
      tag_name: 'v0.2.0-beta.2',
      published_at: null,
      body: '**DO NOT PUBLISH.** A build or test failed in https://github.com/SuperGithubDuo/inkling-notebook/actions/runs/41149694675.',
      assets: ['Inkling-Setup-0.2.0-beta.2-x64.exe', 'Inkling-0.2.0-beta.2-arm64.dmg', 'Inkling-0.2.0-beta.2-x64.dmg'].map((name) => ({ name, state: 'uploaded', size: 1, browser_download_url: `https://github.com/SuperGithubDuo/inkling-notebook/releases/download/untagged-0fa5bf6150053251849f/${name}` }))
    }
    const { manifest, rejected } = pickRelease([draft])
    expect(manifest).toBeNull()
    expect(rejected[0]!.reasons.join()).toMatch(/draft/)
    // Even if someone pressed Publish on it as it is, it would still be refused.
    const asPublished = evaluateRelease({ ...draft, draft: false }, { tagCommit: SHA })
    expect(asPublished.ok).toBe(false)
    expect(asPublished.reasons!.join('\n')).toMatch(/DO NOT PUBLISH/)
  })

  it('falls back to the newest good release when a newer one is refused', () => {
    const older = goodRelease({ published_at: '2026-11-01T00:00:00Z' })
    const newer = goodRelease({ tag_name: 'v0.2.0-beta.4', published_at: '2026-11-08T00:00:00Z', body: 'no marker' })
    const { manifest, rejected } = pickRelease([newer, older], { tagCommits: { [TAG]: SHA, 'v0.2.0-beta.4': SHA } })
    expect(manifest.version).toBe(V)
    expect(rejected.map((r) => r.tag)).toEqual(['v0.2.0-beta.4'])
  })
})

describe('release file helpers', () => {
  it('reads electron-builder update metadata', () => {
    const yml = `version: ${V}\nfiles:\n  - url: Inkling-Setup-${V}-x64.exe\n    sha512: abc==\n    size: 128636974\npath: Inkling-Setup-${V}-x64.exe\nsha512: abc==\nreleaseDate: '2026-10-31T00:21:19.000Z'\n`
    expect(parseLatestYml(yml)).toEqual({ version: V, files: [{ url: `Inkling-Setup-${V}-x64.exe`, sha512: 'abc==', size: 128636974 }] })
  })
  it('round-trips checksum files and markers', () => {
    const m = new Map([['b.dmg', 'f'.repeat(64)], ['a.exe', 'e'.repeat(64)]])
    expect(parseSums(formatSums(m))).toEqual(new Map([['a.exe', 'e'.repeat(64)], ['b.dmg', 'f'.repeat(64)]]))
    expect(parseMarker(`x ${renderMarker({ version: V, commit: SHA, run: 'r', sha256: { a: 'b' } })} y`)).toEqual({ version: V, commit: SHA, run: 'r', sha256: { a: 'b' } })
    expect(parseMarker('<!-- inkling-verified-build {broken -->')).toBeNull()
  })
  it('refuses unknown template placeholders', () => {
    expect(() => fillTemplate('{{VERSION}} {{TYPO}}', { VERSION: V })).toThrow(/TYPO/)
  })
})

describe('in-app update approval', () => {
  const file = { url: `Inkling-Setup-${V}-x64.exe`, sha512: 'abc==' }
  const approval = JSON.parse(renderApproval({ version: V, commit: SHA, run: 'r', metadata: [{ files: [file] }] }))
  it('approves exactly the verified file and version', () => {
    expect(checkApproval(approval, { version: V, files: [file] })).toEqual({ ok: true })
  })
  it('refuses anything else', () => {
    const no = (a: unknown, u: { version: string; files: { url: string; sha512: string }[] }) => checkApproval(a, u).ok
    expect(no(null, { version: V, files: [file] })).toBe(false)
    expect(no({ ...approval, format: 2 }, { version: V, files: [file] })).toBe(false)
    expect(no(approval, { version: '0.2.0-beta.9', files: [file] })).toBe(false)
    expect(no(approval, { version: V, files: [] })).toBe(false)
    expect(no(approval, { version: V, files: [{ ...file, sha512: 'rebuilt==' }] })).toBe(false)
    expect(no(approval, { version: V, files: [{ url: 'other.exe', sha512: 'abc==' }] })).toBe(false)
    expect(no(approval, { version: V, files: [{ url: '__proto__', sha512: 'abc==' }] })).toBe(false)
  })
})

describe('draft finalization (Release workflow)', () => {
  function setup(opts: { tamper?: 'perOs' | 'yml' | 'target'; staleApproval?: boolean } = {}) {
    const remoteDir = mkdtempSync(join(tmpdir(), 'remote-'))
    const names = installerNames(V)
    const write = (n: string, c: string) => writeFileSync(join(remoteDir, n), c)
    for (const n of Object.values(names)) write(n, `binary of ${n}`)
    write(`Inkling-${V}-arm64-mac.zip`, 'zip')
    const sha512 = (n: string) => createHash('sha512').update(readFileSync(join(remoteDir, n))).digest('base64')
    write('latest.yml', `version: ${V}\nfiles:\n  - url: ${names.windows}\n    sha512: ${opts.tamper === 'yml' ? 'wrong==' : sha512(names.windows)}\n    size: ${readFileSync(join(remoteDir, names.windows)).length}\n`)
    write('latest-mac.yml', `version: ${V}\nfiles:\n  - url: Inkling-${V}-arm64-mac.zip\n    sha512: ${sha512(`Inkling-${V}-arm64-mac.zip`)}\n    size: 3\n`)
    const h = (n: string) => createHash('sha256').update(readFileSync(join(remoteDir, n))).digest('hex')
    write(`Inkling-${V}-SHA256SUMS-Windows.txt`, `${opts.tamper === 'perOs' ? '0'.repeat(64) : h(names.windows)}  ${names.windows}\n`)
    write(`Inkling-${V}-SHA256SUMS-macOS.txt`, `${h(names.macArm)}  ${names.macArm}\n${h(names.macIntel)}  ${names.macIntel}\n`)
    if (opts.staleApproval) write(approvalName(V), '{"format":1}')
    const calls: string[] = []
    const api = {
      async getDraft() {
        return { draft: true, target_commitish: opts.tamper === 'target' ? 'c'.repeat(40) : SHA, assets: readdirSync(remoteDir).map((name) => ({ name, ...(Object.values(names).includes(name) ? { digest: `sha256:${h(name)}` } : {}) })) }
      },
      async downloadAll(_t: string, dir: string) { for (const f of readdirSync(remoteDir)) copyFileSync(join(remoteDir, f), join(dir, f)) },
      async upload(_t: string, p: string) { calls.push(`upload ${p.split(/[\\/]/).pop()}`) },
      async deleteAsset(_t: string, n: string) { calls.push(`delete ${n}`) }
    }
    return { api, calls, workDir: mkdtempSync(join(tmpdir(), 'work-')) }
  }
  const template = readFileSync(join(root, '.github', 'release-notes.md'), 'utf8')
  const run = (s: ReturnType<typeof setup>) =>
    finalizeDraft({ api: s.api, version: V, sha: SHA, runUrl: 'https://github.com/x/actions/runs/1', feedback: 'https://forms.example/f', downloadPage: 'https://supergithubduo.github.io/inkling-notebook/', template, workDir: s.workDir })

  it('verifies the files, merges the checksums and writes notes the site accepts', async () => {
    const s = setup()
    const notes = await run(s)
    expect(s.calls).toEqual([`upload ${checksumsName(V)}`, `delete Inkling-${V}-SHA256SUMS-Windows.txt`, `delete Inkling-${V}-SHA256SUMS-macOS.txt`, `upload ${approvalName(V)}`])
    // The in-app update approval lists exactly the files the update metadata points at.
    const approval = JSON.parse(readFileSync(join(s.workDir, approvalName(V)), 'utf8'))
    expect(approval).toMatchObject({ format: 1, version: V, commit: SHA })
    expect(Object.keys(approval.files).sort()).toEqual([`Inkling-${V}-arm64-mac.zip`, `Inkling-Setup-${V}-x64.exe`])
    const win = readFileSync(join(s.workDir, 'latest.yml'), 'utf8')
    expect(checkApproval(approval, { version: V, files: parseLatestYml(win).files as { url: string; sha512: string }[] })).toEqual({ ok: true })
    expect(notes).toContain(`Inkling-Setup-${V}-x64.exe`)
    expect(notes).toContain('https://supergithubduo.github.io/inkling-notebook/')
    expect(notes).not.toMatch(/\{\{/)
    const marker = parseMarker(notes)
    expect(marker).toMatchObject({ version: V, commit: SHA })
    expect(Object.keys(marker.sha256).sort()).toEqual(Object.values(installerNames(V)).sort())
    const combined = parseSums(readFileSync(join(s.workDir, checksumsName(V)), 'utf8'))
    expect([...combined.keys()].sort()).toEqual(Object.values(installerNames(V)).sort())
  })
  it('refuses when an installer differs from the build machine\'s checksum', async () => {
    const s = setup({ tamper: 'perOs' })
    await expect(run(s)).rejects.toThrow(/differs from the one computed when it was built/)
    expect(s.calls).toEqual([])
  })
  it('refuses broken update metadata, and approves no update', async () => {
    const s = setup({ tamper: 'yml' })
    await expect(run(s)).rejects.toThrow(/latest\.yml: SHA-512/)
    expect(s.calls.some((c) => c.includes('update-approval'))).toBe(false)
  })
  it('removes an approval left from an earlier run before verifying again', async () => {
    const s = setup({ tamper: 'perOs', staleApproval: true })
    await expect(run(s)).rejects.toThrow()
    expect(s.calls).toEqual([`delete ${approvalName(V)}`])
  })
  it('refuses to approve an unsigned stable release (unsigned builds are beta/testing only)', async () => {
    const s = setup()
    const stable = '0.2.0'
    await expect(finalizeDraft({ api: s.api, version: stable, sha: SHA, runUrl: 'r', feedback: '', downloadPage: 'd', template, workDir: s.workDir, signed: { windows: false, mac: true } })).rejects.toThrow(/stable version, but the Windows build is unsigned/)
    expect(s.calls.some((c) => c.includes('update-approval'))).toBe(false)
  })
  it('refuses a draft that targets another commit', async () => {
    await expect(run(setup({ tamper: 'target' }))).rejects.toThrow(/targets c{7}/)
  })
})

describe('download site build', () => {
  const build = (releases: unknown[], tagCommits: Record<string, string> = {}, config: Record<string, unknown> = { withdrawn: [] }, feedbackUrl = 'javascript:alert(1)') => {
    const outDir = mkdtempSync(join(tmpdir(), 'site-'))
    const res = buildSite({ siteDir: join(root, 'site'), outDir, releases: releases as never[], tagCommits, config, feedbackUrl, generatedAt: '2026-11-07T00:00:00Z' })
    return { outDir, ...res }
  }
  const page = (outDir: string, p = 'download/index.html') => readFileSync(join(outDir, p), 'utf8')
  const downloadLinks = (html: string) => [...html.replace(/<script id="inkling-release"[\s\S]*?<\/script>/, '').matchAll(/href="([^"]*\/releases\/download\/[^"]*)"/g)].map((m) => m[1])

  it('builds the "no release yet" pages, which pass the deploy check', () => {
    const { outDir, release } = build([])
    expect(release.status).toBe('none')
    expect(checkSite(outDir)).toEqual([])
    const html = page(outDir)
    expect(html).toContain('No version is ready to download right now.')
    expect(downloadLinks(html)).toEqual([])
    expect(html).not.toContain('javascript:')
    expect(html).not.toMatch(/\{\{|<!-- (if|end):/)
  })
  it('writes the verified release into the download page as plain links, so it works without JavaScript', () => {
    const { outDir, release } = build([goodRelease()], { [TAG]: SHA })
    expect(release.version).toBe(V)
    expect(checkSite(outDir)).toEqual([])
    const html = page(outDir)
    const names = installerNames(V)
    for (const n of Object.values(names)) expect(downloadLinks(html)).toContain(PREFIX + n)
    expect(new Set(downloadLinks(html))).toEqual(new Set([...Object.values(names).map((n) => PREFIX + n), PREFIX + checksumsName(V)]))
    expect(html).toContain(`version <span class="num">${V}</span>, released 7 November 2026`)
    expect(html).not.toContain('No version is ready')
    expect(html).not.toMatch(/\{\{|<!-- (if|end):/)
  })
  it('the homepage never links release files: it sends visitors to the download page', () => {
    const { outDir } = build([goodRelease()], { [TAG]: SHA })
    const home = page(outDir, 'index.html')
    expect(home).not.toMatch(/\/releases\/download\//)
    expect(home).toContain('href="download/"')
  })
  it('shows the feedback form only for a safe link', () => {
    let { outDir } = build([], {}, { withdrawn: [] }, 'https://forms.example/f')
    expect(page(outDir)).toContain('href="https://forms.example/f"')
    expect(page(outDir)).not.toContain('feedback-fallback')
    ;({ outDir } = build([], {}, { withdrawn: [] }, 'javascript:alert(1)'))
    expect(page(outDir)).not.toContain('feedback-btn')
    expect(page(outDir)).toContain('feedback-fallback')
  })
  it('the homepage shows no unfinished demo video', () => {
    const { outDir } = build([])
    expect(page(outDir, 'index.html')).not.toMatch(/<video|demo/i)
  })
  it('escapes release values written into the page', () => {
    const r = goodRelease({ html_url: 'https://github.com/x?a=1&b="2"<script>' })
    const { outDir } = build([r], { [TAG]: SHA })
    expect(page(outDir)).toContain('https://github.com/x?a=1&amp;b=&quot;2&quot;&lt;script&gt;')
  })
  it('refuses unbalanced or unknown template parts instead of shipping them', () => {
    expect(() => keepBlocks('<!-- if:available -->x', ['available'])).toThrow(/unbalanced/)
    expect(() => renderPage('<p>{{NOPE}}</p>', { status: 'none' }, { feedbackUrl: '' })).toThrow(/unknown/)
  })
  it('the deploy check catches a link to anything but a verified installer, on any page', () => {
    const { outDir } = build([goodRelease()], { [TAG]: SHA })
    const p = join(outDir, 'download/index.html')
    const html = readFileSync(p, 'utf8')
    writeFileSync(p, html.replace('</main>', '<a href="https://github.com/SuperGithubDuo/inkling-notebook/actions/runs/1/artifacts/2">x</a></main>'))
    expect(checkSite(outDir).join()).toMatch(/workflow runs or artifacts/)
    writeFileSync(p, html.replace('</main>', `<a href="${PREFIX}Inkling-${V}-arm64-mac.zip">x</a></main>`))
    expect(checkSite(outDir).join()).toMatch(/other than a verified installer/)
    writeFileSync(p, html)
    const home = join(outDir, 'index.html')
    writeFileSync(home, readFileSync(home, 'utf8').replace('</main>', `<a href="${PREFIX}${installerNames(V).windows}">x</a></main>`))
    expect(checkSite(outDir).join()).toMatch(/only linked from the download page/)
  })
  it('the deploy check catches release data that was changed after the build', () => {
    const { outDir } = build([goodRelease()], { [TAG]: SHA })
    const p = join(outDir, 'download/index.html')
    const html = readFileSync(p, 'utf8')
    const rel = JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8'))
    delete rel.generatedAt
    rel.downloads.windows.url = `https://github.com/SuperGithubDuo/inkling-notebook/releases/download/untagged-0fa5bf6150053251849f/Inkling-Setup-${V}-x64.exe`
    writeFileSync(p, injectData(html, 'inkling-release', rel))
    expect(checkSite(outDir).join('\n')).toMatch(/unexpected link|draft release/)
  })
  it('the deploy check catches a missing page or asset', () => {
    const { outDir } = build([])
    const home = join(outDir, 'index.html')
    writeFileSync(home, readFileSync(home, 'utf8').replace('assets/site.css', 'assets/nope.css'))
    expect(checkSite(outDir).join()).toMatch(/missing file assets\/nope\.css/)
  })
})

describe('reading releases from GitHub (the "Coming soon" fix)', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const fake = (routes: (url: string) => Response | Promise<Response>) => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => { calls.push(url); return routes(url) }) as unknown as typeof fetch
    return { calls, opts: { fetchImpl, retries: 2, delayMs: 0, sleep: async () => {} } }
  }
  const published = goodRelease()

  it('a GitHub outage while checking a tag fails the build instead of offering an older release or nothing', async () => {
    const { opts } = fake((url) => (url.includes('/releases') ? json(200, [published]) : json(502, { message: 'Bad gateway' })))
    await expect(fetchReleaseData('SuperGithubDuo/inkling-notebook', opts)).rejects.toThrow(/502/)
  })
  it('a network error or rate limit also fails the build, after retrying', async () => {
    let n = 0
    const net = fake(() => { n++; throw new Error('socket hang up') })
    await expect(fetchReleaseData('SuperGithubDuo/inkling-notebook', net.opts)).rejects.toThrow(/socket hang up/)
    expect(n).toBe(3)
    const limited = fake((url) => (url.includes('/releases') ? json(200, [published]) : json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })))
    await expect(fetchReleaseData('SuperGithubDuo/inkling-notebook', limited.opts)).rejects.toThrow(/403/)
  })
  it('recovers from a brief hiccup and offers the newest verified release', async () => {
    let first = true
    const { opts } = fake((url) => {
      if (url.includes('/releases')) return json(200, [published])
      if (first) { first = false; return json(503, {}) }
      return json(200, { sha: SHA })
    })
    const data = await fetchReleaseData('SuperGithubDuo/inkling-notebook', opts)
    expect(data.tagCommits).toEqual({ [TAG]: SHA })
    expect(pickRelease(data.releases, { tagCommits: data.tagCommits }).manifest?.version).toBe(V)
  })
  it('a tag GitHub says does not exist is refused, not retried, and never offered', async () => {
    const { opts, calls } = fake((url) => (url.includes('/releases') ? json(200, [published]) : json(404, { message: 'No commit found' })))
    const data = await fetchReleaseData('SuperGithubDuo/inkling-notebook', opts)
    expect(data.tagCommits).toEqual({})
    expect(calls.filter((c) => c.includes('/commits/'))).toHaveLength(1)
    const { manifest, rejected } = pickRelease(data.releases, { tagCommits: data.tagCommits })
    expect(manifest).toBeNull()
    expect(rejected[0]?.reasons.join()).toMatch(/could not confirm which commit/)
  })
  it('reads every page of releases and skips tag lookups for drafts', async () => {
    const older = goodRelease({ tag_name: 'v0.1.0', published_at: '2026-10-01T00:00:00Z' })
    const draft = goodRelease({ draft: true, tag_name: 'v0.3.0' })
    const { opts, calls } = fake((url) => {
      if (url.endsWith('per_page=100')) return json(200, [draft, published], { link: '<https://api.github.com/repos/x/releases?per_page=100&page=2>; rel="next"' })
      if (url.includes('page=2')) return json(200, [older])
      return json(200, { sha: SHA })
    })
    const data = await fetchReleaseData('SuperGithubDuo/inkling-notebook', opts)
    expect(data.releases).toHaveLength(3)
    expect(calls.some((c) => c.includes('v0.3.0'))).toBe(false)
    expect(Object.keys(data.tagCommits).sort()).toEqual([TAG, 'v0.1.0'].sort())
  })
})
