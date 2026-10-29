/**
 * Smoke test of the INSTALLED app: the packaged build electron-builder
 * produces (asar archive, production paths, bundled pdf.js resources),
 * launched the way a user's double-click does, with a fresh profile.
 *
 *   npm run dist:linux && xvfb-run -a npm run test:packaged
 *   INKLING_PACKAGED_APP="C:\…\Inkling.exe" npm run test:packaged     (Windows, after installing)
 *   INKLING_PACKAGED_APP=/Applications/Inkling.app/Contents/MacOS/Inkling npm run test:packaged
 *
 * Checks: it starts packaged, with the welcome, its data in the pinned
 * "Inkling" folder and no developer menu; handwriting saves; a PDF imports
 * and renders (pdf.js from inside the app); a PDF exports; and everything is
 * there after quitting and starting again.
 */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const defaultApp = { linux: 'release/linux-unpacked/inkling', win32: 'release/win-unpacked/Inkling.exe', darwin: 'release/mac-arm64/Inkling.app/Contents/MacOS/Inkling' }[process.platform]
const executablePath = resolve(root, process.env.INKLING_PACKAGED_APP ?? defaultApp)
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'inkling-packaged-'))
const home = await mkdtemp(join(tmpdir(), 'inkling-packaged-home-'))
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A fresh profile. On Linux the config home is redirected; on Windows APPDATA; on macOS the runner is fresh.
const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData', 'Roaming'), INKLING_DISABLE_UPDATES: '1' }
for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'INKLING_DATA_DIR', 'INKLING_TEST_HOOKS', 'INKLING_SKIP_WELCOME', 'ELECTRON_RENDERER_URL']) delete env[k]

let app, win
async function launch() {
  app = await electron.launch({ executablePath, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('[data-testid="page-surface"], [data-testid="welcome"]', { timeout: 30000 })
  await sleep(400)
}
const stroke = async (points) => {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const [first, ...rest] = points
  await win.mouse.move(box.x + first[0], box.y + first[1])
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(box.x + x, box.y + y, { steps: 5 })
  await win.mouse.up()
}
const waitSaved = () => win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 8000 })

try {
  console.log(`packaged app: ${executablePath}`)
  await launch()
  const facts = await app.evaluate(({ app: a, Menu }) => {
    const labels = (items) => items.flatMap((i) => [i.label, ...(i.submenu ? labels(i.submenu.items) : [])])
    return { packaged: a.isPackaged, version: a.getVersion(), name: a.getName(), userData: a.getPath('userData'), menu: labels(Menu.getApplicationMenu().items) }
  })
  assert.equal(facts.packaged, true)
  assert.equal(facts.version, version)
  assert.equal(facts.name, 'Inkling')
  assert.match(facts.userData, /[\\/]Inkling$/)
  for (const devItem of ['Reload', 'Force Reload', 'Toggle Developer Tools']) assert.ok(!facts.menu.includes(devItem), `no “${devItem}” in an installed build`)
  await win.waitForSelector('[data-testid="welcome"]')
  await win.screenshot({ path: join(shots, 'packaged-first-launch.png') })
  await win.getByRole('button', { name: 'Skip' }).click()
  step(`starts as installed Inkling ${facts.version}, data in ${facts.userData}, welcome shown, no developer menu`)

  // Handwriting.
  await win.click('[data-testid="tool-pen"]')
  await stroke(Array.from({ length: 12 }, (_, i) => [140 + i * 22, 180 + Math.sin(i / 1.5) * 15]))
  await waitSaved()
  const pageId = await win.evaluate(() => document.querySelector('[data-testid="page-surface"]').dataset.pageId)
  const libPath = join(facts.userData, 'Library', 'library.json')
  const lib = JSON.parse(await readFile(libPath, 'utf8'))
  const nb = lib.notebooks.find((n) => n.pages.some((p) => p.id === pageId))
  const pagePath = join(facts.userData, 'Library', 'notebooks', nb.id, 'pages', `${pageId}.json`)
  assert.equal(JSON.parse(await readFile(pagePath, 'utf8')).objects.length, 1)
  step('a stroke is saved to the library folder')

  // PDF import: pdf.js and its resources come from inside the packaged app.
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595.28, 841.89]).drawText('Packaged PDF test: F = ma', { x: 72, y: 760, size: 22, font })
  const pdfPath = join(scratch, 'Handout.pdf')
  await writeFile(pdfPath, await doc.save())
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, pdfPath)
  await win.click('[data-testid="import-menu"]')
  await win.getByRole('menuitem', { name: 'PDF…' }).click()
  await win.waitForSelector('[data-testid="pdf-layer"][data-render-scale]', { timeout: 20000 })
  const dark = await win.evaluate(() => {
    const c = document.querySelector('[data-testid="pdf-layer"]')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 160) n++
    return n
  })
  assert.ok(dark > 200, `the PDF is drawn (${dark} dark pixels)`)
  await waitSaved()
  await win.screenshot({ path: join(shots, 'packaged-pdf.png') })
  step('a PDF imports and renders in the packaged app')

  // PDF export.
  const outPath = join(scratch, 'Exported.pdf')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, outPath)
  await win.locator('[data-testid="more-menu-canvas"]:visible, [data-testid="more-menu"]:visible').first().click()
  await win.getByRole('menuitem', { name: 'Export notebook as PDF…' }).click()
  for (let i = 0; i < 60; i++) {
    const ok = await readFile(outPath).then((b) => b.subarray(0, 5).toString() === '%PDF-', () => false)
    if (ok) break
    await sleep(250)
  }
  assert.equal((await readFile(outPath)).subarray(0, 5).toString(), '%PDF-')
  step('the notebook exports as a PDF')

  // Quit and start again.
  await app.close()
  await launch()
  assert.equal(await win.locator('[data-testid="welcome"]').count(), 0)
  assert.equal(JSON.parse(await readFile(pagePath, 'utf8')).objects.length, 1)
  const after = JSON.parse(await readFile(libPath, 'utf8'))
  assert.ok(after.notebooks.some((n) => n.pages.some((p) => p.title === 'Handout')), 'the PDF page is in the library')
  await win.waitForSelector('[data-testid="page-surface"]')
  step('after quitting and reopening, the handwriting and the PDF page are there')
  console.log('\nPackaged app smoke test: all checks passed')
} catch (err) {
  console.error('\nPackaged app smoke test FAILED:', err)
  await win?.screenshot({ path: join(shots, 'packaged-failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
