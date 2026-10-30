/**
 * Phase 1 acceptance test, driven through the real Electron app:
 * create a notebook, draw, change colour, type text, erase + undo, add a page,
 * save, quit, relaunch, and confirm everything came back from disk.
 *
 * Usage: npm run build && xvfb-run -a npm run test:e2e   (screenshots → $SHOTS or ./test-results)
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e-'))

const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', root],
    env
  })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  win.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"]')
  return { app, win }
}

async function stroke(win, points) {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const [first, ...rest] = points
  await win.mouse.move(box.x + first[0], box.y + first[1])
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(box.x + x, box.y + y, { steps: 6 })
  await win.mouse.up()
}

const wave = (x0, y0, w) => Array.from({ length: 14 }, (_, i) => [x0 + (i * w) / 13, y0 + Math.sin(i / 1.6) * 18])

async function readPage(notebookId, pageId) {
  return JSON.parse(await readFile(join(dataDir, 'notebooks', notebookId, 'pages', `${pageId}.json`), 'utf8'))
}
const readLibrary = async () => JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
const waitSaved = (win) => win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 5000 })
const step = (msg) => console.log(`  ✓ ${msg}`)

// ---------------------------------------------------------------- session 1
let { app, win } = await launch()
assert.equal(await win.locator('[data-testid="notebook-item"]').count(), 5)
await win.screenshot({ path: join(shots, '01-first-launch.png') })
step('first launch shows starter notebooks')

await win.click('[data-testid="new-notebook"]')
await win.keyboard.type('Calculus')
await win.keyboard.press('Enter')
await win.waitForFunction(() => document.querySelector('[data-testid="notebook-title"]')?.textContent === 'Calculus')
step('created and renamed a notebook')

await stroke(win, wave(80, 90, 300))
await win.click('[data-testid="color-#2563eb"]')
await stroke(win, wave(80, 190, 360))
step('drew strokes in black and blue')

await win.click('[data-testid="tool-text"]')
const box = await win.locator('[data-testid="page-surface"]').boundingBox()
await win.mouse.click(box.x + 90, box.y + 300)
await win.waitForSelector('[data-testid="text-editor"]')
await win.keyboard.type('Quadratic formula: x = (-b ± √(b²-4ac)) / 2a')
await win.keyboard.press('Escape')
await win.waitForSelector('[data-testid="text-editor"]', { state: 'detached' })
step('typed a text box')

// Erase-then-undo: draw a red scribble, erase it, undo the erase, undo the scribble.
await win.click('[data-testid="tool-pen"]')
await win.click('[data-testid="color-#e5484d"]')
await stroke(win, wave(420, 420, 200))
await win.click('[data-testid="tool-eraser"]')
await stroke(win, [[520, 380], [520, 460]])
await waitSaved(win)
let lib = await readLibrary()
const nb = lib.notebooks.find((n) => n.name === 'Calculus')
const page1 = nb.pages[0].id
assert.equal((await readPage(nb.id, page1)).objects.length, 3, 'scribble erased')
await win.click('[data-testid="undo"]')
await waitSaved(win)
assert.equal((await readPage(nb.id, page1)).objects.length, 4, 'undo restores erased stroke')
await win.keyboard.press('ControlOrMeta+z')
await waitSaved(win)
assert.equal((await readPage(nb.id, page1)).objects.length, 3, 'undo removes the scribble')
await win.keyboard.press('ControlOrMeta+Shift+z')
await win.keyboard.press('ControlOrMeta+z')
await waitSaved(win)
assert.equal((await readPage(nb.id, page1)).objects.length, 3, 'redo + undo round-trips')
step('eraser removes strokes; undo/redo restore them')

await win.click('[data-testid="tool-pen"]')
await win.click('[data-testid="color-#1f2430"]')
await win.screenshot({ path: join(shots, '02-page-one.png') })

await win.click('[data-testid="add-page"]')
await win.waitForFunction(() => document.querySelectorAll('[data-testid="page-thumb"]').length === 2)
await stroke(win, wave(100, 120, 420))
step('added a second page and drew on it')

await win.keyboard.press('ControlOrMeta+s')
await waitSaved(win)
await app.close()
step('saved and quit')

// ---------------------------------------------------------------- on disk
lib = await readLibrary()
const saved = lib.notebooks.find((n) => n.name === 'Calculus')
assert.equal(saved.pages.length, 2)
const p1 = await readPage(saved.id, saved.pages[0].id)
const p2 = await readPage(saved.id, saved.pages[1].id)
const strokes = p1.objects.filter((o) => o.type === 'stroke')
assert.deepEqual(strokes.map((s) => s.color), ['#1f2430', '#2563eb'])
assert.ok(strokes.every((s) => s.points.length > 10), 'full point data kept')
const text = p1.objects.find((o) => o.type === 'text')
assert.match(text.text, /^Quadratic formula/)
assert.equal(p2.objects.length, 1)
const files = await readdir(join(dataDir, 'notebooks', saved.id, 'pages'))
assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no temp files left')
step('files on disk hold editable strokes, colours and text')

// ---------------------------------------------------------------- session 2
;({ app, win } = await launch())
await win.waitForFunction(() => document.querySelector('[data-testid="notebook-title"]')?.textContent === 'Calculus')
assert.equal(await win.locator('[data-testid="page-thumb"]').count(), 2)
assert.equal(await win.locator('[data-testid="page-thumb"][aria-current="page"]').getAttribute('aria-label'), 'Page 2')
await win.click('[data-testid="page-thumb"] >> nth=0')
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '03-after-restart.png') })
step('relaunch reopens the notebook on the last page with both pages')

// Delete page 2 from its context menu, then restore it from Trash.
await win.click('[data-testid="page-thumb"] >> nth=1', { button: 'right' })
await win.getByRole('menuitem', { name: 'Delete page' }).click()
await win.waitForFunction(() => document.querySelectorAll('[data-testid="page-thumb"]').length === 1)
await win.getByRole('button', { name: 'All Notes', exact: true }).click()
await win.waitForSelector('[data-testid="library-all"]')
await win.getByRole('button', { name: /^Trash/ }).click()
await win.waitForSelector('[data-testid="trash-row"]')
await win.screenshot({ path: join(shots, '04-trash.png') })
await win.getByRole('button', { name: 'Restore' }).click()
await win.getByRole('button', { name: 'Notebooks', exact: true }).click()
await win.waitForTimeout(400)
await win.screenshot({ path: join(shots, '05-library.png') })
await win.locator('[data-testid="notebook-item"]', { hasText: 'Calculus' }).locator('button').first().click()
await win.waitForFunction(() => document.querySelectorAll('[data-testid="page-thumb"]').length === 2)
step('page trash and restore work; library sections render')

// Highlight over the text, then quit immediately — no Ctrl+S, no waiting.
await win.click('[data-testid="page-thumb"] >> nth=0')
await win.click('[data-testid="tool-highlighter"]')
const box2 = await win.locator('[data-testid="page-surface"]').boundingBox()
const textY = 302
await win.mouse.move(box2.x + 85, box2.y + textY)
await win.mouse.down()
await win.mouse.move(box2.x + 330, box2.y + textY, { steps: 12 })
await win.mouse.up()
await win.screenshot({ path: join(shots, '06-highlight.png') })
await app.close()
lib = await readLibrary()
const after = await readPage(saved.id, lib.notebooks.find((n) => n.id === saved.id).pages[0].id)
assert.equal(after.objects.filter((o) => o.tool === 'highlighter').length, 1, 'close flushes unsaved edits')
step('closing the window flushes pending edits to disk')
console.log(`\nPhase 1 acceptance: PASS  (data: ${dataDir})`)
