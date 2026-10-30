/**
 * Regression tests for issues found in code review, driven through the real app:
 *  1. A page recovered from its backup can be edited and saved without a false
 *     "changed by another program" conflict.
 *  2. Copying an image into another notebook copies its asset, and the pasted
 *     image still loads after saving and restarting.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/regressions.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-reg-'))
const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app, win
async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"]')
  await sleep(300)
}
const lib = async () => JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
const nb = async (name) => (await lib()).notebooks.find((n) => n.name === name)
const pageFile = async (name) => {
  const n = await nb(name)
  return join(dataDir, 'notebooks', n.id, 'pages', `${n.pages[0].id}.json`)
}
const readPage = async (name) => JSON.parse(await readFile(await pageFile(name), 'utf8'))
const waitSaved = async () => {
  await sleep(150)
  await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 6000 })
}
async function draw(pts) {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const k = box.width / 1240
  const [first, ...rest] = pts
  await win.mouse.move(box.x + first[0] * k, box.y + first[1] * k)
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(box.x + x * k, box.y + y * k, { steps: 5 })
  await win.mouse.up()
}
const openNotebook = (name) => win.locator('[data-testid="notebook-item"]', { hasText: name }).locator('button').first().click()

// ------------------------------------------------------------ 1. recovery
await launch()
await draw([[100, 100], [300, 140]])
await waitSaved()
await draw([[100, 200], [300, 240]])
await waitSaved()
await app.close()
// Corrupt the page file; the .bak holds the previous good version.
await writeFile(await pageFile('Math Notes'), '{"schemaVersion": 2, "objects": [ trunc')
await launch()
await win.waitForSelector('[role="status"]:has-text("from its backup")')
assert.equal((await readPage('Math Notes')).objects.length, 1, 'restored the backup')
await draw([[100, 300], [300, 340]])
await waitSaved()
assert.equal(await win.locator('[role="alert"]:has-text("changed by another program")').count(), 0, 'no false conflict')
assert.equal((await readPage('Math Notes')).objects.length, 2, 'edit after recovery saved')
const files = await readdir(join(await pageFile('Math Notes'), '..'))
assert.equal(files.filter((f) => f.includes('.conflict-')).length, 0)
step('recovered page edits and saves normally (no conflict copy)')

// ------------------------------------------------------------ 2. cross-notebook image paste
const png = await win.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 120
  const g = c.getContext('2d')
  g.fillStyle = '#86efac'
  g.fillRect(0, 0, 200, 120)
  return c.toDataURL('image/png').split(',')[1]
})
const pngPath = join(dataDir, '..', `inkling-reg-${Date.now()}.png`)
await writeFile(pngPath, Buffer.from(png, 'base64'))
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
}, pngPath)
await win.click('[data-testid="insert-image"]')
await win.waitForSelector('[data-testid="selection-toolbar"]')
await waitSaved()
const source = (await readPage('Math Notes')).objects.find((o) => o.type === 'image')
await win.keyboard.press('ControlOrMeta+c')

await openNotebook('Physics')
await win.waitForFunction(() => document.querySelector('[data-testid="notebook-title"]')?.textContent === 'Physics')
await sleep(300)
await win.keyboard.press('ControlOrMeta+v')
await win.waitForSelector('[data-testid="selection-toolbar"]')
await waitSaved()
const physics = await nb('Physics')
const pasted = (await readPage('Physics')).objects.find((o) => o.type === 'image')
assert.ok(pasted, 'image pasted into Physics')
assert.notEqual(pasted.id, source.id)
const physicsAssets = await readdir(join(dataDir, 'notebooks', physics.id, 'assets'))
assert.ok(physicsAssets.includes(pasted.asset), 'asset copied into the target notebook')
assert.deepEqual(
  await readFile(join(dataDir, 'notebooks', physics.id, 'assets', pasted.asset)),
  await readFile(join(dataDir, 'notebooks', (await nb('Math Notes')).id, 'assets', source.asset))
)
step('pasting into another notebook copies the image asset')

await app.close()
await launch()
await openNotebook('Physics')
await win.waitForFunction(() => document.querySelector('[data-testid="notebook-title"]')?.textContent === 'Physics')
// The image must actually load from the Physics notebook's folder.
const loaded = await win.evaluate(async (url) => {
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    return [img.naturalWidth, img.naturalHeight]
  } catch {
    return null
  }
}, `inkling-asset://asset/${physics.id}/${pasted.asset}`)
assert.deepEqual(loaded, [200, 120])
assert.ok(await win.locator('[data-testid="page-thumb"][aria-current="page"] svg image').count(), 'thumbnail shows it')
await win.screenshot({ path: join(shots, 'reg-cross-notebook.png') })
step('pasted image loads after save and restart')

await app.close()
console.log(`\nRegression tests: PASS  (data: ${dataDir})`)
