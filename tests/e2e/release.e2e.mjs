/**
 * Release acceptance: what a real user's first days with an installed beta
 * involve, driven through the real Electron app.
 *
 *   1. First launch: the welcome, About (version), privacy; not shown again.
 *   2. Unexpected shutdown: the process is killed after an edit; the edit survives.
 *   3. A damaged library index (and backup): the notebooks are rebuilt, not reset.
 *   4. A page saved by a newer version: shown as locked, never overwritten.
 *   5. Backups: the automatic snapshot, then restore it (the newer work kept as "before restore").
 *   6. Updating from older files (schema v1 library and pages): migrated, nothing lost.
 *   7. The data folder is pinned to "Inkling" (an old lowercase folder moves over once),
 *      and a second copy of Inkling doesn't start on the same notebooks.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/release.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A fresh profile: its own config home (so the pinned Inkling folder is private) and data folder. */
async function profile(name, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), `inkling-rel-${name}-`))
  return {
    home,
    dataDir: join(home, 'data'),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(home, 'config'),
      INKLING_DATA_DIR: join(home, 'data'),
      INKLING_TEST_HOOKS: '1',
      INKLING_NO_RELAUNCH: '1',
      INKLING_AUTO_BACKUP_DELAY_MS: '600000',
      ...extra
    }
  }
}

async function launch(env, { waitFor = '[data-testid="page-surface"], [data-testid="note-view"], [data-testid="welcome"], [data-testid="page-locked"]' } = {}) {
  const e = { ...env }
  delete e.NODE_OPTIONS
  delete e.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env: e })
  const win = await app.firstWindow()
  win.on('pageerror', (err) => console.error('PAGE ERROR', err))
  await win.setViewportSize({ width: 1536, height: 960 })
  if (waitFor) await win.waitForSelector(waitFor)
  await sleep(300)
  return { app, win }
}

async function stroke(win, points) {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const [first, ...rest] = points
  await win.mouse.move(box.x + first[0], box.y + first[1])
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(box.x + x, box.y + y, { steps: 5 })
  await win.mouse.up()
}
const wave = (x0, y0, w) => Array.from({ length: 12 }, (_, i) => [x0 + (i * w) / 11, y0 + Math.sin(i / 1.6) * 16])
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))
const activeIds = (win) => win.evaluate(() => ({ pageId: document.querySelector('[data-testid="page-surface"]')?.dataset.pageId }))
const pageFile = (dataDir, nb, id) => join(dataDir, 'notebooks', nb, 'pages', `${id}.json`)
const waitSaved = (win) => win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 8000 })
const libraryOf = (dataDir) => readJson(join(dataDir, 'library.json'))
const notebookOfPage = (lib, pageId) => lib.notebooks.find((n) => n.pages.some((p) => p.id === pageId))

let current = null
try {
  // ======================================================== 1. first launch
  console.log('first launch')
  const a = await profile('first')
  delete a.env.INKLING_SKIP_WELCOME
  current = await launch(a.env)
  let { app, win } = current
  await win.waitForSelector('[data-testid="welcome"]')
  await win.getByText('Welcome to Inkling').waitFor()
  await win.screenshot({ path: join(shots, 'release-welcome.png') })
  await win.click('[data-testid="welcome-next"]')
  await win.getByText('Keep everything together').waitFor()
  await win.click('[data-testid="welcome-next"]')
  await win.getByText('Ask the AI Tutor (beta)').waitFor()
  await win.click('[data-testid="welcome-next"]')
  await win.waitForSelector('[data-testid="welcome"]', { state: 'detached' })
  assert.equal(await win.locator('[data-testid="notebook-item"]').count(), 5, 'the starter shelf is there')
  step('a first launch shows a three-step welcome, then the starter notebooks')

  // About, from the app menu (as a user would).
  await app.evaluate(({ Menu }) => {
    const find = (items) => items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu.items) : [])])
    find(Menu.getApplicationMenu().items).find((i) => i.label === 'About Inkling').click()
  })
  await win.waitForSelector('[data-testid="about"]')
  assert.match(await win.textContent('[data-testid="about-version"]'), new RegExp(`Version ${version.replace(/\./g, '\\.')}`))
  await win.screenshot({ path: join(shots, 'release-about.png') })
  await win.getByRole('button', { name: 'Privacy' }).click()
  await win.waitForSelector('[data-testid="privacy-dialog"]')
  await win.getByText('Your notebooks stay on this computer.').waitFor()
  await win.keyboard.press('Escape')
  const menuLabels = await app.evaluate(({ Menu }) => {
    const find = (items) => items.flatMap((i) => [i.label, ...(i.submenu ? find(i.submenu.items) : [])])
    return find(Menu.getApplicationMenu().items)
  })
  for (const label of ['Back Up Library…', 'Restore from Backup…', 'Send Feedback or Report a Problem…', 'Getting Started']) assert.ok(menuLabels.includes(label), `menu has ${label}`)
  step(`About shows version ${version}; privacy explains data handling; the menu has backup, restore, feedback and help`)

  await app.close()
  current = await launch(a.env)
  ;({ app, win } = current)
  await sleep(800)
  assert.equal(await win.locator('[data-testid="welcome"]').count(), 0, 'the welcome is shown once')
  step('the welcome is not shown again')

  // ===================================================== 2. hard shutdown
  console.log('unexpected shutdown')
  await win.click('[data-testid="tool-pen"]')
  await stroke(win, wave(120, 160, 260))
  await stroke(win, wave(120, 240, 260))
  await waitSaved(win)
  await sleep(200)
  const { pageId } = await activeIds(win)
  // No chance to save on exit: the whole process tree is killed.
  app.process().kill('SIGKILL')
  await sleep(500)
  current = await launch(a.env)
  ;({ app, win } = current)
  const lib = await libraryOf(a.dataDir)
  const nbId = notebookOfPage(lib, pageId).id
  const afterCrash = await readJson(pageFile(a.dataDir, nbId, pageId))
  assert.equal(afterCrash.objects.length, 2, 'both strokes survived the kill')
  const onScreen = await win.evaluate((id) => window.__inkling.notebookContext.page(id).then((p) => p.objects.length), pageId)
  assert.equal(onScreen, 2, 'and back in the app')
  step('after the process is killed mid-session, the strokes drawn before it are on disk and back on screen')

  // ========================================== 3. damaged library index
  console.log('damaged library')
  await app.close()
  await writeFile(join(a.dataDir, 'library.json'), '{"schemaVersion":2,"notebooks":[{"id":')
  await writeFile(join(a.dataDir, 'library.json.bak'), 'not json either')
  current = await launch(a.env)
  ;({ app, win } = current)
  await win.waitForSelector('[data-testid="recovered-notice"]')
  assert.match(await win.textContent('[data-testid="recovered-notice"]'), /rebuilt from the notebook folders/)
  const rebuilt = await libraryOf(a.dataDir)
  assert.ok(notebookOfPage(rebuilt, pageId), 'the page with the strokes is listed again')
  assert.ok((await readdir(a.dataDir)).some((f) => f.startsWith('library.json.corrupt-')), 'the damaged index was kept for inspection')
  await win.screenshot({ path: join(shots, 'release-recovered.png') })
  // Open the recovered page: the strokes are there.
  const recoveredNb = notebookOfPage(rebuilt, pageId)
  assert.equal((await readJson(pageFile(a.dataDir, recoveredNb.id, pageId))).objects.length, 2)
  step('with library.json and its backup both damaged, the notebook list is rebuilt from the folders; no page is lost')
  await app.close()

  // ============================================ 4. newer-version page
  console.log('newer page')
  const libNow = await libraryOf(a.dataDir)
  const target = notebookOfPage(libNow, pageId)
  const file = pageFile(a.dataDir, target.id, pageId)
  const future = JSON.stringify({ ...(await readJson(file)), schemaVersion: 42, futureField: 'kept' })
  await writeFile(file, future)
  // Open straight on that page.
  current = await launch(a.env)
  ;({ app, win } = current)
  await win.evaluate(async ([nb, pg]) => {
    localStorage.setItem('inkling:last-opened', JSON.stringify({ notebookId: nb, pageId: pg }))
  }, [target.id, pageId])
  await app.close()
  current = await launch(a.env)
  ;({ app, win } = current)
  const opened = await activeIds(win)
  if (opened.pageId !== pageId) {
    // Fall back to opening it by its thumbnail position.
    await win.locator(`[data-testid="notebook-item"]`).filter({ hasText: target.name }).first().click()
    await sleep(500)
  }
  await win.waitForSelector('[data-testid="page-locked"]', { timeout: 10000 })
  await win.click('[data-testid="tool-pen"]')
  await stroke(win, wave(140, 400, 200)).catch(() => undefined)
  await sleep(1500)
  assert.equal(await readFile(file, 'utf8'), future, 'the newer file is byte-for-byte unchanged')
  await win.screenshot({ path: join(shots, 'release-newer-page.png') })
  step('a page saved by a newer Inkling is shown as locked; drawing on it never overwrites the file')
  await app.close()
  await writeFile(file, JSON.stringify(afterCrash))

  // ======================================================= 5. backups
  console.log('backups')
  const b = await profile('backup', { INKLING_SKIP_WELCOME: '1', INKLING_AUTO_BACKUP_DELAY_MS: '6000' })
  current = await launch(b.env)
  ;({ app, win } = current)
  await win.click('[data-testid="tool-pen"]')
  await stroke(win, wave(120, 160, 260))
  await waitSaved(win)
  const backupsDir = `${b.dataDir}-backups`
  for (let i = 0; i < 80 && !(await readdir(backupsDir).catch(() => [])).some((n) => n.endsWith(' auto')); i++) await sleep(250)
  const autoName = (await readdir(backupsDir)).find((n) => n.endsWith(' auto'))
  assert.ok(autoName, 'the automatic snapshot was taken')
  const pg = (await activeIds(win)).pageId
  const nbB = notebookOfPage(await libraryOf(b.dataDir), pg).id
  assert.equal((await readJson(pageFile(join(backupsDir, autoName), nbB, pg))).objects.length, 1, 'the snapshot has the first stroke')
  // Work after the snapshot.
  await stroke(win, wave(120, 300, 260))
  await waitSaved(win)
  assert.equal((await readJson(pageFile(b.dataDir, nbB, pg))).objects.length, 2)
  // Restore the snapshot from Settings → Storage, confirming the system dialog.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await win.waitForSelector('[data-testid="backup-list"]')
  await win.screenshot({ path: join(shots, 'release-backups.png') })
  const exited = new Promise((r) => app.process().once('exit', r))
  await win.locator('[data-testid="backup-list"] li').first().getByRole('button', { name: 'Restore' }).click()
  await exited
  assert.equal((await readJson(pageFile(b.dataDir, nbB, pg))).objects.length, 1, 'the library is back to the snapshot')
  const before = (await readdir(backupsDir)).find((n) => n.endsWith(' before-restore'))
  assert.ok(before, 'the replaced library was kept')
  assert.equal((await readJson(pageFile(join(backupsDir, before), nbB, pg))).objects.length, 2, 'the work after the snapshot is in the “before restore” backup')
  current = await launch(b.env)
  ;({ app, win } = current)
  await app.close()
  step('the daily snapshot is taken automatically; restoring it brings the library back and keeps the newer work as a “before restore” backup')

  // ===================================================== 6. old files
  console.log('older files')
  const c = await profile('upgrade', { INKLING_SKIP_WELCOME: '1' })
  const nbId1 = 'nb-old-0001'
  const pageId1 = 'pg-old-0001'
  await mkdir(join(c.dataDir, 'notebooks', nbId1, 'pages'), { recursive: true })
  await writeFile(
    join(c.dataDir, 'library.json'),
    JSON.stringify({ schemaVersion: 1, folders: [], notebooks: [{ id: nbId1, name: 'From version 0.0.1', color: '#3b6fe0', icon: 'book', favorite: false, folderId: null, createdAt: 1, updatedAt: 1, deletedAt: null, pages: [{ id: pageId1, title: 'Old page', createdAt: 1, updatedAt: 1, deletedAt: null }] }] })
  )
  const v1Page = { schemaVersion: 1, id: pageId1, notebookId: nbId1, width: 1240, height: 1754, paper: { type: 'grid', spacing: 31, color: '#e4e7ec' }, objects: [{ id: 'old-stroke', createdAt: 1, author: 'user', type: 'stroke', tool: 'pen', color: '#1f2430', size: 3, opacity: 1, hasPressure: false, points: [[100, 100], [300, 140], [500, 120]] }], updatedAt: 1 }
  await writeFile(pageFile(c.dataDir, nbId1, pageId1), JSON.stringify(v1Page))
  current = await launch(c.env)
  ;({ app, win } = current)
  await win.getByText('From version 0.0.1').first().waitFor()
  assert.equal((await activeIds(win)).pageId, pageId1)
  const objs = await win.evaluate(() => window.__inkling.notebookContext.page(document.querySelector('[data-testid="page-surface"]').dataset.pageId).then((p) => p.objects.map((o) => o.id)))
  assert.deepEqual(objs, ['old-stroke'])
  await win.click('[data-testid="tool-pen"]')
  await stroke(win, wave(120, 400, 200))
  await waitSaved(win)
  const upgraded = await readJson(pageFile(c.dataDir, nbId1, pageId1))
  assert.equal(upgraded.schemaVersion, 3)
  assert.equal(upgraded.objects.length, 2)
  assert.equal((await readJson(`${pageFile(c.dataDir, nbId1, pageId1)}.bak`)).schemaVersion, 1, 'the old file is kept as the backup copy')
  assert.equal((await libraryOf(c.dataDir)).schemaVersion, 2)
  await app.close()
  step('a library and page from the oldest file format open, are upgraded on save, and the original stays as .bak')

  // ==================================== 7. pinned data folder, one instance
  console.log('data folder and single instance')
  const d = await profile('folder', { INKLING_SKIP_WELCOME: '1' })
  delete d.env.INKLING_DATA_DIR
  // A data folder from an older development build, under the lowercase name.
  const legacy = join(d.home, 'config', 'inkling')
  await mkdir(join(legacy, 'Library'), { recursive: true })
  await writeFile(join(legacy, 'Library', 'library.json'), JSON.stringify({ schemaVersion: 2, folders: [], notebooks: [{ id: 'nb-legacy-01', name: 'Legacy notebook', color: '#3b6fe0', icon: 'book', favorite: false, folderId: null, createdAt: 1, updatedAt: 1, deletedAt: null, pages: [{ id: 'pg-legacy-01', kind: 'canvas', title: '', tags: [], createdAt: 1, updatedAt: 1, deletedAt: null }] }] }))
  current = await launch(d.env)
  ;({ app, win } = current)
  await win.getByText('Legacy notebook').first().waitFor()
  assert.ok(await stat(join(d.home, 'config', 'Inkling', 'Library', 'library.json')))
  assert.equal(await stat(legacy).then(() => true, () => false), false, 'the old folder was moved, not copied')
  step('the data folder is pinned to “Inkling”; an older lowercase folder is moved over with its notebooks')

  // A second copy exits at once and leaves the first one running.
  const env2 = { ...d.env }
  delete env2.NODE_OPTIONS
  delete env2.ELECTRON_RUN_AS_NODE
  const second = spawn(electronPath, ['--no-sandbox', root], { env: env2, stdio: 'ignore' })
  const code = await Promise.race([new Promise((r) => second.once('exit', r)), sleep(15000).then(() => 'still running')])
  assert.notEqual(code, 'still running', 'the second copy quit')
  assert.ok(!win.isClosed(), 'the first copy is still running')
  await win.getByText('Legacy notebook').first().waitFor()
  await app.close()
  step('a second copy of Inkling on the same notebooks quits immediately; the first keeps running')

  console.log('\nRelease acceptance: all checks passed')
} catch (err) {
  console.error('\nRelease acceptance FAILED:', err)
  await current?.win?.screenshot({ path: join(shots, 'release-failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await current?.app?.close().catch(() => undefined)
}
