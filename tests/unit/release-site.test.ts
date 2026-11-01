import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checksumsName,
  evaluateRelease,
  fillTemplate,
  formatSums,
  installerNames,
  parseLatestYml,
  parseMarker,
  parseSums,
  pickRelease,
  renderMarker
} from '../../scripts/release/rules.mjs'
import { finalizeDraft } from '../../scripts/release/finalize-draft.mjs'
import { buildSite, injectData } from '../../scripts/site/build-site.mjs'
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

describe('draft finalization (Release workflow)', () => {
  function setup(opts: { tamper?: 'perOs' | 'yml' | 'target' } = {}) {
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
    expect(s.calls).toEqual([`upload ${checksumsName(V)}`, `delete Inkling-${V}-SHA256SUMS-Windows.txt`, `delete Inkling-${V}-SHA256SUMS-macOS.txt`])
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
  it('refuses broken update metadata', async () => {
    await expect(run(setup({ tamper: 'yml' }))).rejects.toThrow(/latest\.yml: SHA-512/)
  })
  it('refuses a draft that targets another commit', async () => {
    await expect(run(setup({ tamper: 'target' }))).rejects.toThrow(/targets c{7}/)
  })
})

describe('download site build', () => {
  const build = (releases: unknown[], tagCommits: Record<string, string> = {}) => {
    const outDir = mkdtempSync(join(tmpdir(), 'site-'))
    const res = buildSite({ siteDir: join(root, 'site'), outDir, releases: releases as never[], tagCommits, config: { withdrawn: [] }, feedbackUrl: 'javascript:alert(1)', generatedAt: '2026-11-07T00:00:00Z' })
    return { outDir, ...res }
  }
  it('builds the "no release yet" page, which passes the deploy check', () => {
    const { outDir, release } = build([])
    expect(release.status).toBe('none')
    expect(checkSite(outDir)).toEqual([])
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('"allowPreview":false')
    expect(html).not.toContain('javascript:')
  })
  it('builds the page for a verified release, which passes the deploy check', () => {
    const { outDir, release } = build([goodRelease()], { [TAG]: SHA })
    expect(release.version).toBe(V)
    expect(checkSite(outDir)).toEqual([])
  })
  it('the deploy check catches a link to anything but a verified installer', () => {
    const { outDir } = build([goodRelease()], { [TAG]: SHA })
    const p = join(outDir, 'index.html')
    const html = readFileSync(p, 'utf8')
    writeFileSync(p, html.replace('</main>', '<a href="https://github.com/SuperGithubDuo/inkling-notebook/actions/runs/1/artifacts/2">x</a></main>'))
    expect(checkSite(outDir).join()).toMatch(/workflow runs or artifacts/)
    const rel = JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8'))
    delete rel.generatedAt
    rel.downloads.windows.url = `https://github.com/SuperGithubDuo/inkling-notebook/releases/download/untagged-0fa5bf6150053251849f/Inkling-Setup-${V}-x64.exe`
    writeFileSync(p, injectData(html, 'inkling-release', rel))
    expect(checkSite(outDir).join('\n')).toMatch(/unexpected link|draft release/)
  })
})
