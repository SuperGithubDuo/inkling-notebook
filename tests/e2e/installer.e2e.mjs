/**
 * The real installer lifecycle on a clean Windows or macOS machine (run by
 * the Release workflow on GitHub's runners), checking that notebooks survive
 * every step:
 *
 *   1. install version A (Windows: the NSIS installer, silently; macOS: copy
 *      Inkling.app out of the DMG, as a user does)
 *   2. use it: first launch, a stroke, a PDF (tests/e2e/packaged.e2e.mjs)
 *   3. install version B over it (an update) → same notebooks, new version
 *   4. uninstall → the notebooks are still on disk
 *   5. install again → the same notebooks open
 *
 *   node tests/e2e/installer.e2e.mjs <installer-or-dmg A> <installer-or-dmg B>
 *
 * It installs and uninstalls Inkling for the current user, so it refuses to
 * run outside CI unless INKLING_INSTALLER_TEST=1 is set.
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

if (!process.env.CI && process.env.INKLING_INSTALLER_TEST !== '1') {
  console.error('This test installs and uninstalls Inkling. Run it in CI, or set INKLING_INSTALLER_TEST=1.')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '../..')
const [pkgA, pkgB] = process.argv.slice(2).map((p) => resolve(p))
if (!pkgA || !pkgB) throw new Error('usage: installer.e2e.mjs <installer A> <installer B>')
const shots = process.env.SHOTS ?? join(root, 'test-results')
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const win = process.platform === 'win32'
const mac = process.platform === 'darwin'
if (!win && !mac) throw new Error('Windows or macOS only')

// ------------------------------------------------------------ platform steps
const programsDir = win ? join(process.env.LOCALAPPDATA, 'Programs') : join(homedir(), 'Applications')

function findInstalledExe() {
  if (mac) {
    const app = join(programsDir, 'Inkling.app', 'Contents', 'MacOS', 'Inkling')
    return existsSync(app) ? app : null
  }
  for (const dir of existsSync(programsDir) ? readdirSync(programsDir) : []) {
    const exe = join(programsDir, dir, 'Inkling.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

/** Ends any running Inkling (a silent install may start it), so tests own the single-instance lock. */
function killInkling() {
  if (win) spawnSync('taskkill', ['/IM', 'Inkling.exe', '/F', '/T'], { stdio: 'ignore' })
  else spawnSync('pkill', ['-x', 'Inkling'], { stdio: 'ignore' })
}

async function install(pkg) {
  if (win) {
    const r = spawnSync(pkg, ['/S'], { stdio: 'inherit', timeout: 300_000 })
    assert.equal(r.status, 0, `installer exited with ${r.status}`)
  } else {
    const mount = await mkdtemp(join(tmpdir(), 'inkling-dmg-'))
    execFileSync('hdiutil', ['attach', pkg, '-nobrowse', '-readonly', '-mountpoint', mount])
    try {
      await rm(join(programsDir, 'Inkling.app'), { recursive: true, force: true })
      await cp(join(mount, 'Inkling.app'), join(programsDir, 'Inkling.app'), { recursive: true, verbatimSymlinks: true })
    } finally {
      execFileSync('hdiutil', ['detach', mount, '-force'])
    }
  }
  for (let i = 0; i < 60 && !findInstalledExe(); i++) await sleep(1000)
  await sleep(3000)
  killInkling()
  const exe = findInstalledExe()
  assert.ok(exe, 'Inkling is installed')
  return exe
}

async function uninstall(exe) {
  if (mac) {
    // Uninstalling a Mac app is moving it to the Bin; the app-data folder stays.
    await rm(join(programsDir, 'Inkling.app'), { recursive: true, force: true })
    return
  }
  const dir = join(exe, '..')
  const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f))
  assert.ok(uninstaller, 'an uninstaller exists')
  spawnSync(join(dir, uninstaller), ['/S'], { stdio: 'inherit', timeout: 300_000 })
  // The NSIS uninstaller re-launches itself from a temp folder and returns at once: wait for the files to go.
  for (let i = 0; i < 120 && existsSync(exe); i++) await sleep(1000)
  assert.ok(!existsSync(exe), 'the app was removed')
}

const versionOf = async (exe) => {
  const app = await electron.launch({ executablePath: exe, env: cleanEnv() })
  const v = await app.evaluate(({ app: a }) => a.getVersion())
  return { app, v }
}
function cleanEnv() {
  const env = { ...process.env, INKLING_DISABLE_UPDATES: '1' }
  for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'INKLING_DATA_DIR', 'INKLING_TEST_HOOKS', 'INKLING_SKIP_WELCOME']) delete env[k]
  return env
}

/** Opens the installed app and checks the notebooks written in step 2 are all there, unchanged. */
async function checkLibrary(exe, state, expectVersion, label) {
  const lib = JSON.parse(await readFile(state.libPath, 'utf8'))
  const page = JSON.parse(await readFile(state.pagePath, 'utf8'))
  assert.ok(page.objects.length >= 1, `${label}: the handwritten stroke is on disk`)
  assert.ok(lib.notebooks.some((n) => n.pages.some((p) => p.title === 'Handout')), `${label}: the imported PDF page is listed`)
  const { app, v } = await versionOf(exe)
  try {
    if (expectVersion) assert.equal(v, expectVersion, `${label}: runs version ${expectVersion}`)
    const w = await app.firstWindow()
    await w.waitForSelector('[data-testid="page-surface"], [data-testid="welcome"]', { timeout: 30000 })
    await sleep(800)
    assert.equal(await w.locator('[data-testid="welcome"]').count(), 0, `${label}: no first-run welcome (it is a returning user)`)
    assert.equal(await w.locator('[data-testid="recovered-notice"]').count(), 0, `${label}: nothing needed repairing`)
    await w.screenshot({ path: join(shots, `installer-${label.replace(/\W+/g, '-')}.png`) })
    const after = JSON.parse(await readFile(state.pagePath, 'utf8'))
    assert.deepEqual(after.objects.map((o) => o.id), page.objects.map((o) => o.id), `${label}: the page is unchanged`)
  } finally {
    await app.close()
  }
  return v
}

try {
  console.log(`installers: ${pkgA}\n            ${pkgB}`)
  killInkling()
  // 1–2. Install A and use it.
  let exe = await install(pkgA)
  step(`installed ${exe}`)
  const smoke = spawnSync(process.execPath, [join(root, 'tests/e2e/packaged.e2e.mjs')], { stdio: 'inherit', env: { ...process.env, INKLING_PACKAGED_APP: exe } })
  assert.equal(smoke.status, 0, 'the packaged-app smoke test passed on the installed app')
  const state = JSON.parse(await readFile(join(shots, 'packaged-state.json'), 'utf8'))
  step(`the installed app works (first launch, handwriting, PDF import/export), data in ${state.userData}`)

  // 3. Update: install B over A.
  exe = await install(pkgB)
  const vB = await checkLibrary(exe, state, null, 'after update')
  assert.notEqual(vB, state.version, 'the update installed a different version')
  step(`installing ${vB} over ${state.version} kept every notebook`)

  // 4. Uninstall.
  await uninstall(exe)
  assert.ok(existsSync(state.libPath) && existsSync(state.pagePath), 'notebooks are still on disk after uninstalling')
  step('uninstalling removed the app and kept the notebooks')

  // 5. Install again.
  exe = await install(pkgB)
  await checkLibrary(exe, state, vB, 'after reinstall')
  step('reinstalling opened the same notebooks')
  console.log('\nInstaller lifecycle: all checks passed')
} catch (err) {
  console.error('\nInstaller lifecycle FAILED:', err)
  process.exitCode = 1
} finally {
  killInkling()
}
