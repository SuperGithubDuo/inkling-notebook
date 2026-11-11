/**
 * In-app updates, end to end, through the real updater (electron-updater) of an INSTALLED build:
 *
 *   1. install version A and write a notebook (a handwritten stroke), so there is data to lose
 *   2. an update whose release has no valid approval is never downloaded
 *   3. a download that doesn't match its SHA-512 is discarded; A keeps running, nothing changes
 *   4. interrupted downloads fail cleanly, and the next check downloads it (differentially when
 *      A's .blockmap is served, as it is on GitHub Releases)
 *   5. "Later" restarts nothing, installs nothing on quit, and the next start offers the update
 *      again from the already downloaded file
 *   6. "Restart & Update" installs B in place: B runs, every notebook file is byte-identical,
 *      settings are kept, and the update is recorded as installed
 *
 * The feed is a local HTTP server standing in for GitHub Releases (same files: latest*.yml, the
 * installer, .blockmap, and Inkling-<version>-update-approval.json). The app is pointed at it with
 * INKLING_TEST_HOOKS=1 + INKLING_TEST_UPDATE_FEED; nothing else differs from a user's install.
 *
 *   node tests/e2e/update.e2e.mjs <A: installer or AppImage> <directory with B's release files> [directory with A's release files]
 *
 * Windows: A is Inkling-Setup-*.exe (installed silently for the current user, like the installer
 * test). Linux: A is an AppImage (run with APPIMAGE_EXTRACT_AND_RUN=1, under xvfb-run); Linux is
 * not distributed but runs the same updater code, so the flow can be tested on any machine.
 * macOS without a Developer ID can't install updates in-app (Squirrel.Mac): there the test checks
 * that the update is announced with a download link, and stops.
 *
 * It installs Inkling for the current user on Windows, so it refuses to run outside CI unless
 * INKLING_INSTALLER_TEST=1 is set.
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { approvalName, parseLatestYml, renderApproval } from '../../scripts/release/rules.mjs'

const win = process.platform === 'win32'
const linux = process.platform === 'linux'
const mac = process.platform === 'darwin'
if (win && !process.env.CI && process.env.INKLING_INSTALLER_TEST !== '1') {
  console.error('This test installs Inkling. Run it in CI, or set INKLING_INSTALLER_TEST=1.')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '../..')
const [pkgA, dirB, dirA] = process.argv.slice(2).map((p) => (p ? resolve(p) : p))
if (!pkgA || !dirB) throw new Error('usage: update.e2e.mjs <A installer|AppImage> <B release dir> [A release dir]')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ the feed (GitHub Releases stand-in)
const channelFile = win ? 'latest.yml' : mac ? 'latest-mac.yml' : 'latest-linux.yml'
const metaB = parseLatestYml(readFileSync(join(dirB, channelFile), 'utf8'))
const versionB = metaB.version
assert.ok(versionB && metaB.files.length, `${channelFile} in ${dirB} names a version and files`)
const updateFile = metaB.files[0].url
const goodApproval = renderApproval({ version: versionB, commit: '0'.repeat(40), run: 'local', metadata: [metaB] })
// The same release, but its files were rebuilt after verification: the approval no longer matches them.
const wrongApproval = JSON.stringify({ ...JSON.parse(goodApproval), files: { [updateFile]: 'rebuiltAfterVerification==' } })

const feed = {
  approval: 'good', // good | wrong | missing
  installer: 'ok', // ok | corrupt | interrupt
  serveOldBlockmaps: false,
  log: [] // { path, range }
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  feed.log.push({ path, range: req.headers.range ?? null })
  if (path === approvalName(versionB)) {
    if (feed.approval === 'missing') return void res.writeHead(404).end()
    const body = feed.approval === 'wrong' ? wrongApproval : goodApproval
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  }
  let file = existsSync(join(dirB, path)) ? join(dirB, path) : null
  if (!file && feed.serveOldBlockmaps && dirA && path.endsWith('.blockmap') && existsSync(join(dirA, path))) file = join(dirA, path)
  if (!file || !statSync(file).isFile()) return void res.writeHead(404).end()
  let data = readFileSync(file)
  // Corrupt: every byte range served is damaged, so neither a differential nor a full download can succeed.
  const corrupt = path === updateFile && feed.installer === 'corrupt'
  const slice = (start, end) => {
    const part = Buffer.from(data.subarray(start, end + 1))
    if (corrupt && part.length) part[part.length >> 1] ^= 0xff
    return part
  }
  let status = 200
  const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }
  const spec = /^bytes=(.+)$/.exec(req.headers.range ?? '')?.[1]
  if (spec) {
    // Range requests, single or multiple (multipart/byteranges), as differential downloads make them.
    const total = data.length
    const parts = spec.split(',').map((r) => {
      const [s, e] = r.trim().split('-')
      return [Number(s), e ? Number(e) : total - 1]
    })
    status = 206
    if (parts.length === 1) {
      const [start, end] = parts[0]
      headers['content-range'] = `bytes ${start}-${end}/${total}`
      data = slice(start, end)
    } else {
      const boundary = 'inklingtestboundary'
      headers['content-type'] = `multipart/byteranges; boundary=${boundary}`
      const chunks = []
      for (const [start, end] of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${total}\r\n\r\n`), slice(start, end), Buffer.from('\r\n'))
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`))
      data = Buffer.concat(chunks)
    }
  } else data = slice(0, data.length - 1)
  headers['content-length'] = String(data.length)
  if (path === updateFile) feed.log.at(-1).bytes = data.length
  if (path === updateFile && feed.installer === 'interrupt') {
    // A connection that drops part-way through.
    res.writeHead(status, headers)
    res.write(data.subarray(0, Math.min(data.length >> 2, 256 * 1024)))
    setTimeout(() => req.socket.destroy(), 50)
    return
  }
  res.writeHead(status, headers).end(data)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const feedUrl = `http://127.0.0.1:${server.address().port}`
const installerRequests = () => feed.log.filter((l) => l.path === updateFile).length

// ------------------------------------------------------------ install A
const scratch = await mkdtemp(join(tmpdir(), 'inkling-update-'))
const home = join(scratch, 'home')
let exe
function killInkling() {
  if (win) spawnSync('taskkill', ['/IM', 'Inkling.exe', '/F', '/T'], { stdio: 'ignore' })
  else spawnSync('pkill', ['-f', linux ? join(scratch, 'Inkling.AppImage') : 'Inkling.app/Contents/MacOS/Inkling'], { stdio: 'ignore' })
}
async function installA() {
  if (linux) {
    // No version in the file name: the AppImage updater replaces this file in place.
    const dest = join(scratch, 'Inkling.AppImage')
    copyFileSync(pkgA, dest)
    chmodSync(dest, 0o755)
    return dest
  }
  if (win) {
    const r = spawnSync(pkgA, ['/S'], { stdio: 'inherit', timeout: 300_000 })
    assert.equal(r.status, 0, `installer exited with ${r.status}`)
    const programs = join(process.env.LOCALAPPDATA, 'Programs')
    for (let i = 0; i < 60; i++) {
      for (const d of existsSync(programs) ? readdirSync(programs) : []) if (existsSync(join(programs, d, 'Inkling.exe'))) return join(programs, d, 'Inkling.exe')
      await sleep(1000)
    }
    throw new Error('Inkling.exe not found after installing')
  }
  return pkgA // macOS: an Inkling.app's executable, already in place
}

// One profile for every start, as for a real user. The update's own restart inherits it too.
const env = {
  ...process.env,
  INKLING_TEST_HOOKS: '1',
  INKLING_TEST_UPDATE_FEED: feedUrl,
  INKLING_UPDATE_CHECK_DELAY_MS: '1500',
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'), // Linux: the updater's download cache
  ...(win ? { APPDATA: join(home, 'AppData', 'Roaming') } : {}),
  ...(linux ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {})
}
for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'INKLING_DATA_DIR', 'INKLING_CONFIG_DIR', 'INKLING_DISABLE_UPDATES', 'INKLING_SKIP_WELCOME', 'ELECTRON_RENDERER_URL']) delete env[k]

let app, w
async function launch(label) {
  app = await electron.launch({ executablePath: exe, args: linux ? ['--no-sandbox'] : [], env, timeout: 120_000 })
  // The main process's log (the updater's warnings) goes into the test output.
  for (const s of [app.process().stdout, app.process().stderr]) s?.on('data', (d) => { for (const line of String(d).split('\n')) if (/update|approval|error/i.test(line)) console.log(`    [app] ${line.trim()}`) })
  w = await app.firstWindow()
  w.on('pageerror', (e) => console.error('PAGE ERROR', e))
  await w.setViewportSize({ width: 1280, height: 800 })
  await w.waitForSelector('[data-testid="page-surface"], [data-testid="welcome"]', { timeout: 60_000 })
  const facts = await app.evaluate(({ app: a }) => ({ version: a.getVersion(), userData: a.getPath('userData') }))
  console.log(`  · ${label}: Inkling ${facts.version}`)
  return facts
}
async function close() {
  if (!app) return
  await app.close().catch(() => {})
  app = null
  await sleep(1500)
}
const state = () => w.evaluate(() => window.inkling.updates.state())
async function waitState(pred, what, timeout = 180_000) {
  const until = Date.now() + timeout
  let s
  while (Date.now() < until) {
    s = await state()
    if (pred(s)) return s
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(s)}`)
}

/** Every notebook file (pages, notes, assets, library.json) by its SHA-256. */
function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!e.name.endsWith('.bak') && !e.name.includes('.tmp')) out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}
const readPrefs = async (userData) => JSON.parse(await readFile(join(userData, 'update-settings.json'), 'utf8'))

try {
  killInkling()
  // Start without a previously downloaded update (Windows/macOS keep it per user, outside the profile).
  if (win) await rm(join(process.env.LOCALAPPDATA, 'inkling-updater'), { recursive: true, force: true })
  if (mac) await rm(join(homedir(), 'Library', 'Caches', 'inkling-updater'), { recursive: true, force: true })
  exe = await installA()
  step(`installed A: ${exe}`)

  // 1. Use A: a handwritten stroke, saved.
  feed.approval = 'missing'
  let facts = await launch('first start')
  const versionA = facts.version
  assert.notEqual(versionA, versionB, 'A and B are different versions')
  const userData = facts.userData
  const library = join(userData, 'Library')
  if (await w.locator('[data-testid="welcome"]').count()) await w.getByRole('button', { name: 'Skip' }).click()
  await w.waitForSelector('[data-testid="page-surface"]')
  const box = await w.locator('[data-testid="page-surface"]').boundingBox()
  await w.mouse.move(box.x + 200, box.y + 200)
  await w.mouse.down()
  for (const [x, y] of [[260, 230], [330, 210], [400, 260]]) await w.mouse.move(box.x + x, box.y + y, { steps: 6 })
  await w.mouse.up()
  await w.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 10_000 })
  const aiBefore = await readFile(join(userData, 'ai-settings.json'), 'utf8').catch(() => null)
  const prefsA = await readPrefs(userData)
  assert.equal(prefsA.channel, versionA.includes('-') ? 'beta' : 'stable', 'the channel was saved on first start')
  step(`A ${versionA} works; a stroke is saved; channel ${prefsA.channel} saved`)

  // macOS without a Developer ID: the update is only announced.
  if (mac) {
    feed.approval = 'good'
    await w.evaluate(() => window.inkling.updates.check())
    const s = await waitState((x) => x.status === 'available' || x.status === 'ready' || x.status === 'downloading', 'the update to be found')
    if (s.status === 'available') {
      assert.match(s.manualDownloadUrl ?? '', /releases\/tag\/v/, 'a link to the release page')
      step('macOS (ad-hoc signed): the update is announced with a download link; in-app installation needs a Developer ID')
      await close()
      console.log('\nIn-app updates: all checks passed (macOS notify mode)')
      process.exit(0)
    }
    console.log('  · this macOS build installs updates itself (Developer ID): running the full flow')
  }

  // 2. Not approved: never downloaded.
  await w.evaluate(() => window.inkling.updates.check())
  await waitState((s) => s.status === 'none', 'no update (approval missing)')
  feed.approval = 'wrong'
  await w.evaluate(() => window.inkling.updates.check())
  await waitState((s) => s.status === 'none', 'no update (approval for other files)')
  assert.equal(installerRequests(), 0, 'nothing was downloaded without a matching approval')
  step('a release without a matching update approval is not offered or downloaded')

  // 3. Corrupt download: discarded.
  feed.approval = 'good'
  feed.installer = 'corrupt'
  await w.evaluate(() => window.inkling.updates.check())
  let s = await waitState((x) => x.status === 'error', 'the corrupt download to be refused')
  assert.match(s.message, /integrity/, s.message)
  assert.equal(await app.evaluate(({ app: a }) => a.getVersion()), versionA, 'A keeps running')
  step(`a download that fails its SHA-512 check is discarded (“${s.message}”)`)

  // 4. Interrupted, then completed (differentially when A's blockmap is on the server).
  feed.installer = 'interrupt'
  await w.evaluate(() => window.inkling.updates.check())
  s = await waitState((x) => x.status === 'error', 'the interrupted download to fail')
  step(`an interrupted download fails cleanly (“${s.message}”)`)
  feed.installer = 'ok'
  feed.serveOldBlockmaps = true
  const before = feed.log.length
  await w.evaluate(() => window.inkling.updates.check())
  await waitState((x) => x.status === 'ready', 'the update to be downloaded')
  const got = feed.log.slice(before).filter((l) => l.path === updateFile)
  const bytes = got.reduce((n, l) => n + (l.bytes ?? 0), 0)
  const size = metaB.files[0].size
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
  const differential = got.length > 0 && got.every((l) => l.range)
  step(`the next check downloaded it: ${differential ? `differentially, ${mb(bytes)} of ${mb(size)}` : `in full, ${mb(bytes)}`}`)
  if (process.env.INKLING_EXPECT_DIFFERENTIAL === '1') assert.ok(differential && bytes < size / 2, 'the update was downloaded differentially')

  // 5. Later: nothing restarts, nothing installs on quit, offered again next start without downloading again.
  await sleep(4500) // the notice waits until there has been no input for a few seconds
  await w.waitForSelector('[data-testid="update-notice"][data-status="ready"]', { timeout: 15_000 })
  await w.screenshot({ path: join(shots, 'update-ready.png') })
  await w.click('[data-testid="update-later"]')
  assert.equal(await w.locator('[data-testid="update-notice"]').count(), 0, 'Later hides the notice')
  await close()
  await sleep(5000)
  const requestsBefore = installerRequests()
  facts = await launch('after Later')
  assert.equal(facts.version, versionA, 'quitting after Later did not install the update')
  await waitState((x) => x.status === 'ready', 'the downloaded update to be offered again')
  assert.equal(installerRequests(), requestsBefore, 'the update was not downloaded a second time')
  step('Later installs nothing on quit; the next start offers the downloaded update again')

  // 6. Restart & Update.
  const data = snapshot(library)
  await sleep(4500)
  await w.waitForSelector('[data-testid="update-restart"]', { timeout: 15_000 })
  const exited = new Promise((r) => app.process().once('exit', r))
  await w.click('[data-testid="update-restart"]')
  await Promise.race([exited, sleep(60_000).then(() => { throw new Error('A did not quit to install the update') })])
  app = null
  // The installer runs, then starts B (with the same environment). Wait for B to record the update.
  let recorded = null
  for (let i = 0; i < 240 && !recorded; i++) {
    await sleep(1000)
    const p = await readPrefs(userData).catch(() => null)
    if (p?.lastInstall?.to === versionB) recorded = p.lastInstall
    if (linux && i === 20 && !recorded) break // root containers can't relaunch Electron without --no-sandbox: start it below
  }
  killInkling()
  await sleep(3000)
  facts = await launch('after Restart & Update')
  assert.equal(facts.version, versionB, `B ${versionB} is installed and running`)
  const prefsB = await readPrefs(userData)
  assert.deepEqual({ ok: prefsB.lastInstall?.ok, from: prefsB.lastInstall?.from, to: prefsB.lastInstall?.to }, { ok: true, from: versionA, to: versionB }, 'the update is recorded as installed')
  assert.equal(prefsB.channel, prefsA.channel, 'the channel did not change')
  assert.equal(await w.locator('[data-testid="welcome"]').count(), 0, 'no first-run welcome: same user, same library')
  assert.equal(await w.locator('[data-testid="recovered-notice"]').count(), 0, 'nothing needed repairing')
  const after = snapshot(library)
  for (const [file, hash] of Object.entries(data)) assert.equal(after[file], hash, `${file} is unchanged by the update`)
  if (aiBefore) assert.equal(JSON.parse(await readFile(join(userData, 'ai-settings.json'), 'utf8')).installId, JSON.parse(aiBefore).installId, 'settings are kept')
  const backups = existsSync(join(userData, 'Backups')) ? readdirSync(join(userData, 'Backups')) : []
  step(`Restart & Update installed ${versionB} over ${versionA}; ${Object.keys(data).length} notebook files byte-identical; settings kept; ${backups.length} backup snapshot(s) on disk`)
  await waitState((x) => x.status === 'none', 'B to find nothing newer')
  // Settings → Updates: version, status, Check for Updates, channel.
  await w.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await w.waitForSelector('[data-testid="update-settings"]')
  assert.equal(await w.locator('[data-testid="update-version"]').textContent(), versionB)
  assert.match(await w.locator('[data-testid="update-status"]').textContent(), /up to date/)
  assert.equal(await w.locator(`[data-testid="update-channel-${prefsA.channel}"]`).getAttribute('aria-checked'), 'true')
  await w.click('[data-testid="update-check"]')
  await waitState((x) => x.status === 'none', 'Check for Updates to finish')
  await w.locator('[data-testid="update-settings"]').scrollIntoViewIfNeeded()
  await w.screenshot({ path: join(shots, 'update-settings.png') })
  step('Settings → Updates shows the new version, “up to date”, the channel, and Check for Updates works')
  await close()
  console.log(`\nIn-app updates: all checks passed (${basename(pkgA)} → ${versionB})`)
} catch (err) {
  console.error('\nIn-app updates FAILED:', err)
  if (w) await w.screenshot({ path: join(shots, 'update-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await close()
  killInkling()
  server.close()
  if (!process.env.KEEP_SCRATCH) await rm(scratch, { recursive: true, force: true }).catch(() => {})
}
