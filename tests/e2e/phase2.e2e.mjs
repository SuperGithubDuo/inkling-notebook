/**
 * Phase 2 acceptance test, driven through the real Electron app with real
 * pointer input: lasso + move + resize, undo/redo, shapes, images (dialog and
 * drag-and-drop), rotate/duplicate/delete, zoom/pan coordinate accuracy,
 * precise eraser, page size, thumbnails, restart persistence and external edits.
 *
 * Usage: npm run build && xvfb-run -a npm run test:e2e:phase2
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, readFile, readdir, writeFile, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e2-'))
const env = { ...process.env, INKLING_DATA_DIR: dataDir }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  win.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"]')
  await sleep(300)
  return { app, win }
}

let app, win
const lib = async () => JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
const nbId = async () => (await lib()).notebooks.find((n) => n.name === 'Math Notes').id
const pagePath = async () => {
  const l = await lib()
  const nb = l.notebooks.find((n) => n.name === 'Math Notes')
  return join(dataDir, 'notebooks', nb.id, 'pages', `${nb.pages.find((p) => p.deletedAt === null).id}.json`)
}
const readPage = async () => JSON.parse(await readFile(await pagePath(), 'utf8'))
const waitSaved = async () => {
  await sleep(150)
  await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 6000 })
}

/** Page geometry on screen: origin and pixels per page unit. */
async function surface() {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const p = await readPage().catch(() => ({ width: 1240 }))
  return { x: box.x, y: box.y, k: box.width / p.width }
}
const toScreen = (s, x, y) => [s.x + x * s.k, s.y + y * s.k]

async function drag(points, opts = {}) {
  const [first, ...rest] = points
  await win.mouse.move(first[0], first[1])
  await win.mouse.down(opts)
  for (const [x, y] of rest) await win.mouse.move(x, y, { steps: opts.steps ?? 5 })
  await win.mouse.up(opts)
}

/** Draws in page coordinates. */
async function drawPage(pts) {
  const s = await surface()
  await drag(pts.map(([x, y]) => toScreen(s, x, y)))
}

const bounds = (objs) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const o of objs) {
    if (o.type === 'stroke') for (const [x, y] of o.points) {
      x0 = Math.min(x0, x - o.size / 2); y0 = Math.min(y0, y - o.size / 2)
      x1 = Math.max(x1, x + o.size / 2); y1 = Math.max(y1, y + o.size / 2)
    }
  }
  return { x0, y0, x1, y1 }
}

// ------------------------------------------------------------------ start
;({ app, win } = await launch())
assert.equal(await win.locator('[data-testid="notebook-title"]').textContent(), 'Math Notes')

// Write a short "word": three strokes.
for (let i = 0; i < 3; i++) await drawPage([[120 + i * 70, 200], [150 + i * 70, 260], [170 + i * 70, 205], [190 + i * 70, 250]])
await waitSaved()
let pg = await readPage()
assert.equal(pg.objects.length, 3)
const original = structuredClone(pg.objects)
step('drew three strokes')

// ---- Lasso select and move
await win.click('[data-testid="tool-lasso"]')
await drawPage([[90, 170], [400, 170], [400, 290], [90, 290], [90, 172]])
await win.waitForSelector('[data-testid="selection-toolbar"]')
assert.equal((await win.locator('[data-testid="selection-toolbar"]').textContent()).trim().charAt(0), '3')
let s = await surface()
await drag([toScreen(s, 250, 230), toScreen(s, 350, 290)], { steps: 10 })
await waitSaved()
pg = await readPage()
const dx = pg.objects[0].points[0][0] - original[0].points[0][0]
const dy = pg.objects[0].points[0][1] - original[0].points[0][1]
assert.ok(Math.abs(dx - 100) < 2 && Math.abs(dy - 60) < 2, `moved by ${dx},${dy}`)
pg.objects.forEach((o, i) => {
  assert.equal(o.points.length, original[i].points.length, 'no points lost when moving')
  o.points.forEach((p, j) => assert.ok(Math.abs(p[0] - original[i].points[j][0] - dx) < 0.02))
})
step('lasso selected handwriting and moved it as vector data')

// ---- Resize with the bottom-right handle (keeps aspect ratio)
const before = bounds(pg.objects)
s = await surface()
const [hx, hy] = toScreen(s, before.x1, before.y1)
await drag([[hx + 6, hy + 6], [hx + 6 + 120, hy + 6 + 60]], { steps: 12 })
await waitSaved()
pg = await readPage()
const after = bounds(pg.objects)
const sx = (after.x1 - after.x0) / (before.x1 - before.x0)
const sy = (after.y1 - after.y0) / (before.y1 - before.y0)
assert.ok(sx > 1.15, `scaled ${sx}`)
assert.ok(Math.abs(sx - sy) < 0.03, `uniform scale ${sx} vs ${sy}`)
pg.objects.forEach((o, i) => assert.equal(o.points.length, original[i].points.length, 'no points lost when resizing'))
assert.ok(Math.abs(after.x0 - before.x0) < 1.5 && Math.abs(after.y0 - before.y0) < 1.5, 'opposite corner fixed')
step(`resized selection ×${sx.toFixed(2)} without corrupting strokes`)

// ---- Undo / redo the transform
await win.keyboard.press('Control+z')
await waitSaved()
assert.ok(Math.abs(bounds((await readPage()).objects).x1 - before.x1) < 0.5, 'undo restores size')
await win.keyboard.press('Control+Shift+z')
await waitSaved()
assert.ok(Math.abs(bounds((await readPage()).objects).x1 - after.x1) < 0.5, 'redo re-applies')
step('undo/redo of move and resize')

// ---- Copy / paste / duplicate / delete on the selection
await win.keyboard.press('Control+c')
await win.keyboard.press('Control+v')
await waitSaved()
assert.equal((await readPage()).objects.length, 6, 'paste added three')
await win.click('[data-testid="delete-selection"]')
await waitSaved()
assert.equal((await readPage()).objects.length, 3, 'delete removed the pasted copies')
step('copy, paste and delete selection')

// Click empty space to deselect.
await drawPage([[900, 1200], [901, 1201]])
assert.equal(await win.locator('[data-testid="selection-toolbar"]').count(), 0)
step('clicking outside clears the selection')

// ---- Shapes
await win.click('[data-testid="tool-shape"]') // rectangle by default
await drawPage([[100, 500], [300, 620]])
await win.click('[data-testid="tool-shape"]') // opens options
await win.click('[data-testid="shape-arrow"]')
await drawPage([[340, 560], [480, 520]])
await win.click('[data-testid="tool-shape"]')
await win.click('[data-testid="shape-circle"]')
await win.click('[data-testid="tool-shape"]')
await win.getByRole('button', { name: /Fill shapes/ }).click()
await win.keyboard.press('Escape')
await drawPage([[520, 480], [640, 600]])
await win.click('[data-testid="tool-shape"]')
await win.click('[data-testid="shape-triangle"]')
await drawPage([[680, 480], [800, 600]])
await waitSaved()
pg = await readPage()
const shapes = pg.objects.filter((o) => o.type === 'shape')
assert.deepEqual(shapes.map((o) => o.kind), ['rect', 'arrow', 'ellipse', 'triangle'])
assert.ok(Math.abs(shapes[2].width - shapes[2].height) < 0.01, 'circle tool makes equal sides')
assert.ok(shapes[2].fill, 'fill applied')
assert.ok(Math.abs(shapes[0].width - 200) < 2 && Math.abs(shapes[0].height - 120) < 2)
step('drew rectangle, arrow, filled circle, triangle')

// Select the rectangle by tapping its edge, recolour it and resize it with a side handle.
await win.click('[data-testid="tool-lasso"]')
s = await surface()
await win.mouse.click(...toScreen(s, 200, 500))
await win.waitForSelector('[data-testid="selection-toolbar"]')
await win.click('[data-testid="color-#2563eb"]')
await waitSaved()
let rect = (await readPage()).objects.find((o) => o.kind === 'rect')
assert.equal(rect.color, '#2563eb')
const [rx, ry] = toScreen(s, rect.x + rect.width, rect.y + rect.height / 2)
await drag([[rx + 6, ry], [rx + 6 + 60, ry]], { steps: 8 })
await waitSaved()
rect = (await readPage()).objects.find((o) => o.kind === 'rect')
assert.ok(rect.width > 240 && Math.abs(rect.height - 120) < 2, `rect resized to ${rect.width}x${rect.height}`)
step('selected a shape, recoloured and resized it independently')

// ---- Images: toolbar import (native dialog stubbed in the main process) …
const png = await win.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 200
  const g = c.getContext('2d')
  g.fillStyle = '#93c5fd'
  g.fillRect(0, 0, 320, 200)
  g.fillStyle = '#1f2430'
  g.font = '48px sans-serif'
  g.fillText('IMG', 100, 120)
  return c.toDataURL('image/png').split(',')[1]
})
const pngPath = join(dataDir, '..', `inkling-test-${Date.now()}.png`)
await writeFile(pngPath, Buffer.from(png, 'base64'))
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
}, pngPath)
await win.click('[data-testid="insert-image"]')
await win.waitForSelector('[data-testid="selection-toolbar"]')
await waitSaved()
pg = await readPage()
let img = pg.objects.find((o) => o.type === 'image')
assert.ok(img, 'image object created')
assert.equal(img.naturalWidth, 320)
assert.ok(Math.abs(img.width / img.height - 1.6) < 0.01, 'aspect preserved')
const assets = await readdir(join(dataDir, 'notebooks', await nbId(), 'assets'))
assert.ok(assets.includes(img.asset), 'asset copied into notebook')
step('inserted an image through the file picker; stored as a notebook asset')

// … move it, rotate it with the rotation handle, duplicate and delete.
s = await surface()
const [icx, icy] = toScreen(s, img.x + img.width / 2, img.y + img.height / 2)
await drag([[icx, icy], [icx + 40, icy]], { steps: 8 })
await waitSaved()
img = (await readPage()).objects.find((o) => o.type === 'image')
const [tx, ty] = toScreen(s, img.x + img.width / 2, img.y)
await drag([[tx, ty - 6 - 50], [tx + 120, ty - 6 - 20]], { steps: 12 })
await waitSaved()
img = (await readPage()).objects.find((o) => o.type === 'image')
assert.ok(Math.abs(img.rotation) > 10, `rotated ${img.rotation}°`)
await win.click('[data-testid="duplicate-selection"]')
await waitSaved()
assert.equal((await readPage()).objects.filter((o) => o.type === 'image').length, 2)
await win.keyboard.press('Delete')
await waitSaved()
assert.equal((await readPage()).objects.filter((o) => o.type === 'image').length, 1)
step(`moved, rotated (${img.rotation.toFixed(0)}°), duplicated and deleted images`)

// Drag-and-drop an image file onto the page.
await win.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const dt = new DataTransfer()
  dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }))
  const el = document.querySelector('[data-testid="canvas-viewport"]')
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + 300, clientY: r.top + 300, bubbles: true, cancelable: true }))
}, png)
await win.waitForFunction(() => document.querySelector('[data-testid="selection-toolbar"]'))
await waitSaved()
assert.equal((await readPage()).objects.filter((o) => o.type === 'image').length, 2)
await win.keyboard.press('Escape')
step('dropped an image file onto the canvas')

// ---- Zoom and pan keep drawing coordinates exact
await win.click('[data-testid="tool-pen"]')
s = await surface()
const vp = await win.locator('[data-testid="canvas-viewport"]').boundingBox()
await win.mouse.move(vp.x + 300, vp.y + 300)
await win.keyboard.down('Control')
for (let i = 0; i < 4; i++) await win.mouse.wheel(0, -120)
await win.keyboard.up('Control')
await sleep(200)
const zoom = parseInt(await win.locator('[data-testid="zoom-level"]').textContent())
assert.ok(zoom > 150, `zoomed to ${zoom}%`)
const zs = await surface()
assert.ok(zs.k > s.k * 1.5)
// The page point under the cursor stays put while zooming.
const pinnedBefore = [(vp.x + 300 - s.x) / s.k, (vp.y + 300 - s.y) / s.k]
const pinnedAfter = [(vp.x + 300 - zs.x) / zs.k, (vp.y + 300 - zs.y) / zs.k]
assert.ok(Math.hypot(pinnedBefore[0] - pinnedAfter[0], pinnedBefore[1] - pinnedAfter[1]) < 2, 'zoom anchored at pointer')

async function drawAndCheck(label) {
  const sf = await surface()
  const a = [vp.x + 200, vp.y + 200]
  const b = [vp.x + 260, vp.y + 240]
  const count = (await readPage()).objects.length
  await drag([a, b])
  await waitSaved()
  const objs = (await readPage()).objects
  assert.equal(objs.length, count + 1)
  const st = objs.at(-1)
  const expect0 = [(a[0] - sf.x) / sf.k, (a[1] - sf.y) / sf.k]
  const got = st.points[0]
  assert.ok(Math.hypot(got[0] - expect0[0], got[1] - expect0[1]) < 0.75, `${label}: stroke at ${got} expected ${expect0}`)
}
await drawAndCheck('zoomed')
// Pan with the hand tool.
await win.click('[data-testid="tool-hand"]')
await drag([[vp.x + 400, vp.y + 500], [vp.x + 250, vp.y + 350]], { steps: 8 })
const ps = await surface()
assert.ok(Math.abs(ps.x - zs.x) > 50, 'hand tool panned')
const marksBefore = (await readPage()).objects.length
await win.click('[data-testid="tool-pen"]')
await drawAndCheck('zoomed + panned')
assert.equal((await readPage()).objects.length, marksBefore + 1, 'panning left no marks')
// Wheel without modifier pans; Ctrl+0 resets.
await win.mouse.move(vp.x + 300, vp.y + 300)
await win.mouse.wheel(0, 200)
await sleep(150)
assert.ok((await surface()).y < ps.y - 50, 'wheel scrolls the page')
await win.keyboard.press('Control+0')
await sleep(150)
assert.equal(await win.locator('[data-testid="zoom-level"]').textContent(), '100%')
await win.screenshot({ path: join(shots, 'p2-01-content.png') })
step(`zoom ${zoom}% at pointer, pan, and drawing stays exact at every zoom`)

// ---- Precise eraser splits a stroke
await drawPage([[100, 900], [700, 900]])
await waitSaved()
const nBefore = (await readPage()).objects.length
await win.click('[data-testid="tool-eraser"]')
await win.click('[data-testid="size-picker"]')
await win.click('[data-testid="eraser-precise"]')
await win.keyboard.press('Escape')
await drawPage([[400, 860], [400, 940]])
await waitSaved()
pg = await readPage()
assert.equal(pg.objects.length, nBefore + 1, 'one stroke became two')
const halves = pg.objects.slice(-2)
assert.ok(halves.every((o) => o.type === 'stroke' && o.points.length > 3))
await win.keyboard.press('Control+z')
await waitSaved()
assert.equal((await readPage()).objects.length, nBefore, 'undo re-joins the stroke')
step('precise eraser splits strokes; undo restores')

// ---- Thumbnail reflects content
const thumb = win.locator('[data-testid="page-thumb"][aria-current="page"] svg')
assert.ok((await thumb.locator('image').count()) >= 2, 'thumbnail shows images')
assert.ok((await thumb.locator('path').count()) >= (await readPage()).objects.filter((o) => o.type !== 'image').length)
step('active page thumbnail renders strokes, shapes and images')

// ---- Page size
const contentBefore = (await readPage()).objects.length
await win.getByRole('button', { name: 'Paper and size for this page' }).click()
await win.click('[data-testid="page-size-a4-landscape"]')
await waitSaved()
pg = await readPage()
assert.equal(pg.width, 1754)
assert.equal(pg.objects.length, contentBefore, 'page size change keeps content')
step('changed page size to A4 landscape')

// ---- Export the page as PNG (save dialog stubbed)
const exportPath = join(dataDir, '..', `inkling-export-${Date.now()}.png`)
await app.evaluate(({ dialog }, p) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
}, exportPath)
await win.getByRole('button', { name: 'Export page as PNG' }).click()
await win.waitForSelector('[role="status"]:has-text("Exported")')
const exported = await readFile(exportPath)
assert.equal(exported.subarray(1, 4).toString(), 'PNG')
assert.equal(exported.readUInt32BE(16), 1754 * 2, 'full page width at 2x')
assert.equal(exported.readUInt32BE(20), 1240 * 2)
step('exported the whole page (with images) as a 2x PNG')

const finalPage = await readPage()
await app.close()

// ------------------------------------------------------------------ restart
;({ app, win } = await launch())
const reopened = await readPage()
assert.deepEqual(reopened.objects, finalPage.objects, 'identical after restart')
await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="page-thumb"] svg image')].length >= 2)
await sleep(400)
await win.screenshot({ path: join(shots, 'p2-02-after-restart.png') })
step('shapes, images and transformed handwriting survive a restart')

// ------------------------------------------------------------------ external change
const file = await pagePath()
const external = { ...reopened, objects: reopened.objects.slice(0, 2), updatedAt: Date.now() }
await writeFile(file, JSON.stringify(external))
const future = new Date(Date.now() + 5000)
await utimes(file, future, future)
await drawPage([[100, 300], [200, 330]])
await win.waitForSelector('[role="alert"]:has-text("changed by another program")', { timeout: 6000 })
assert.equal(JSON.parse(await readFile(file, 'utf8')).objects.length, 2, 'external file not overwritten')
const pagesDir = join(file, '..')
const conflicts = (await readdir(pagesDir)).filter((f) => f.includes('.conflict-'))
assert.equal(conflicts.length, 1)
const conflictCopy = JSON.parse(await readFile(join(pagesDir, conflicts[0]), 'utf8'))
assert.equal(conflictCopy.objects.length, reopened.objects.length + 1, "the app's version is kept in full")
await win.getByRole('button', { name: 'Load the other version' }).click()
await sleep(300)
await drawPage([[100, 400], [200, 430]])
await waitSaved()
assert.equal((await readPage()).objects.length, 3, 'editing continues on the external version')
step('external edit detected: nothing overwritten, both versions kept')

await app.close()
console.log(`\nPhase 2 acceptance: PASS  (data: ${dataDir})`)
