#!/usr/bin/env node
/**
 * Captures the website's product screenshots from the real Inkling app.
 *
 * It launches the built app (npm run build) with a fresh, throwaway data folder, writes on the
 * pages with the real pen and highlighter tools (mouse strokes from a single-stroke handwriting
 * font, so the ink is ordinary Inkling ink), imports a real PDF, and saves 2x screenshots to
 * site/assets/screenshots/. Nothing here talks to an AI.
 *
 *   npm run build && xvfb-run -a node scripts/site/capture-screenshots.mjs
 *
 * Needs: the dev dependencies (playwright-core, pdf-lib, hersheytext) and a display (xvfb on Linux).
 * Output: write.webp (and write-phone.webp, its handwriting for phones), notebooks.webp (the library's
 * notebook row) and pdf.webp (the annotated worksheet), via Chromium's WebP encoder; PNG if that fails.
 * The AI Tutor screenshots (hero-tutor*, step-*) are real tutor answers and are not made here.
 */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { electronPath } from '../../tests/support/electronPath.mjs'

const require = createRequire(import.meta.url)
const hershey = require('hersheytext')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = process.env.OUT ?? join(root, 'site', 'assets', 'screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ handwriting
const fonts = {}
function parsePath(d) {
  const toks = d.replace(/([MLml])/g, ' $1 ').replace(/,/g, ' ').trim().split(/\s+/)
  const strokes = []
  let cur = null
  let cmd = 'M'
  for (let i = 0; i < toks.length; ) {
    if (/^[MLml]$/.test(toks[i])) { cmd = toks[i++].toUpperCase(); continue }
    const p = [parseFloat(toks[i]), parseFloat(toks[i + 1])]
    i += 2
    if (cmd === 'M') { cur = [p]; strokes.push(cur); cmd = 'L' } else cur.push(p)
  }
  return strokes
}
/** Pen strokes for `text`, top-left at (x, y) in page coordinates, capital height `size`. */
function hand(text, x, y, size, font = 'ems_felix') {
  const f = fonts[font] ?? (fonts[font] = hershey.getFontData(font))
  const cap = parseFloat(f.info['cap-height'] ?? 500)
  const k = size / cap
  const strokes = []
  let cx = x
  let n = 0
  for (const ch of text) {
    const g = f.getChar(ch)
    if (!g?.d) { cx += (g?.width ?? parseFloat(f.info['horiz-adv-x'])) * k; continue }
    for (const s of parsePath(g.d)) {
      // A slight, steady wobble and baseline drift, so it isn't machine-perfect.
      strokes.push(s.map(([gx, gy], i) => [cx + gx * k + Math.sin((n + i) * 1.7) * size * 0.015, y + (cap - gy) * k + Math.sin(n * 0.6) * size * 0.03]))
    }
    n++
    cx += g.width * k
  }
  return strokes
}
const arrow = (x1, y1, x2, y2, head = 14) => {
  const a = Math.atan2(y2 - y1, x2 - x1)
  return [[[x1, y1], [x2, y2]], [[x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45)], [x2, y2], [x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45)]]]
}
const ellipse = (cx, cy, rx, ry, n = 40) => [Array.from({ length: n + 3 }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI - 0.4), cy + ry * Math.sin((i / n) * 2 * Math.PI - 0.4)])]

// ------------------------------------------------------------------ app
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-shots-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-shots-config-'))
const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir, INKLING_CONFIG_DIR: configDir, INKLING_TEST_HOOKS: '1', INKLING_OLLAMA_URL: 'http://127.0.0.1:9', INKLING_BETA_URL: 'http://127.0.0.1:9' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', '--force-device-scale-factor=2', root], env })
const win = await app.firstWindow()
// Size the window itself (setViewportSize would reset the 2x pixel ratio).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
await win.waitForSelector('[data-testid="page-surface"], [data-testid="note-view"]')
await sleep(500)

async function surface() {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const width = await win.evaluate(() => document.querySelector('[data-testid="page-surface"]').dataset.pageWidth ?? null)
  return { x: box.x, y: box.y, k: box.width / Number(width ?? 1240) }
}
/** Extra points along long segments, so straight lines stay straight through the pen's smoothing. */
function densify(stroke, step = 8) {
  const outPts = [stroke[0]]
  for (let i = 1; i < stroke.length; i++) {
    const [x0, y0] = stroke[i - 1]
    const [x1, y1] = stroke[i]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step))
    for (let j = 1; j <= n; j++) outPts.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n])
  }
  return outPts
}
async function draw(strokes) {
  const s = await surface()
  const dock = await win.locator('[data-testid="ask-ai-selection"], button:has-text("Ask AI")').last().boundingBox()
  for (const stroke of strokes) {
    const pts = densify(stroke).map(([x, y]) => [s.x + x * s.k, s.y + y * s.k])
    // The floating tool dock sits over the bottom of the page: a stroke through it would press its buttons.
    if (dock && pts.some(([, y]) => y > dock.y - 12)) throw new Error(`stroke reaches the tool dock (page y ${Math.max(...stroke.map((p) => p[1]))})`)
    await win.mouse.move(pts[0][0], pts[0][1])
    await win.mouse.down()
    for (const [x, y] of pts.slice(1)) await win.mouse.move(x, y)
    await win.mouse.up()
  }
}
const tool = (t) => win.click(`[data-testid="tool-${t}"]`)
const color = (c) => win.click(`[data-testid="color-${c}"]`)
const pen = async (c = '#1f2430') => { await tool('pen'); await color(c) }
const highlight = async (c, x1, x2, y) => { await tool('highlighter'); await color(c); await draw([[[x1, y], [x2, y]]]) }
async function openNotebook(name) {
  await win.locator('[data-testid="notebook-item"]', { hasText: name }).first().click()
  await sleep(500)
  await closeTutor()
}
async function closeTutor() {
  for (let i = 0; i < 3 && (await win.getAttribute('[data-testid="toggle-tutor"]', 'aria-pressed')) === 'true'; i++) {
    await win.click('[data-testid="toggle-tutor"]')
    await sleep(400)
  }
}
async function saved() {
  await sleep(300)
  await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 8000 })
}
/**
 * Saves the window (2880 × 1800 at 2x) as one or more WebP files: [name, [x0, y0, x1, y1] | null],
 * crop boxes in device pixels. Chromium's own encoder; PNG if WebP isn't available.
 */
async function shot(...outputs) {
  await win.mouse.move(2, 450)
  await sleep(400)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  for (const [name, box] of outputs) {
    const webp = await win.evaluate(async ({ b64, box }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const [x0, y0, x1, y1] = box ?? [0, 0, img.naturalWidth, img.naturalHeight]
      const c = document.createElement('canvas')
      c.width = x1 - x0
      c.height = y1 - y0
      c.getContext('2d').drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height)
      const url = c.toDataURL('image/webp', 0.86)
      return url.startsWith('data:image/webp') ? url.split(',')[1] : null
    }, { b64: png, box })
    const file = join(out, webp ? `${name}.webp` : `${name}.png`)
    await writeFile(file, webp ? Buffer.from(webp, 'base64') : Buffer.from(png, 'base64'))
    console.log(`  ✓ ${file}`)
  }
}

try {
  await closeTutor()

  // ---------------------------------------------------------------- Physics: a page of working
  await openNotebook('Physics')
  await pen()
  await draw(hand('Forces on a ramp', 110, 80, 40))
  await draw([[[110, 140], [500, 138]]])
  // The ramp (30°), the block and its forces, top right.
  const u = [Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)]
  const nrm = [-Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)]
  const at = (p, a, b) => [p[0] + a * u[0] + b * nrm[0], p[1] + a * u[1] + b * nrm[1]]
  const foot = [660, 400]
  await draw([[foot, [1150, 400], at(foot, 566, 0), foot]])
  const b0 = at(foot, 250, 0)
  await draw([[b0, at(b0, 76, 0), at(b0, 76, 76), at(b0, 0, 76), b0]])
  await draw([Array.from({ length: 12 }, (_, i) => [foot[0] + 52 * Math.cos((-i / 11) * (Math.PI / 6)), foot[1] + 52 * Math.sin((-i / 11) * (Math.PI / 6))])])
  await draw(hand('30°', 724, 362, 16))
  const c = at(b0, 38, 38)
  await pen('#2563eb')
  await draw([...arrow(c[0], c[1], c[0], 382), ...arrow(c[0], c[1], ...at(c, 0, 112)), ...arrow(c[0], c[1], ...at(c, 104, 0))])
  await draw([...hand('W = mg', c[0] + 14, 352, 19), ...hand('N', at(c, 0, 112)[0] - 38, at(c, 0, 112)[1] - 26, 19), ...hand('f', at(c, 104, 0)[0] + 10, at(c, 104, 0)[1] - 34, 19)])
  // The working, below.
  await pen()
  const lines = ['m = 2 kg,  g = 9.8 N/kg', 'W = mg = 2 × 9.8 = 19.6 N', 'Along the ramp:  mg sin 30° = 9.8 N', 'Into the ramp:  mg cos 30° = 17 N', 'So  N = 17 N']
  const width = (strokes) => Math.max(...strokes.flat().map((p) => p[0]))
  let y = 470
  const ends = []
  for (const l of lines) { const st = hand(l, 112, y, 25); ends.push(width(st)); await draw(st); y += 64 }
  await highlight('#fde047', 108, ends[2] + 6, 616)
  await pen('#e5484d')
  await draw(ellipse(112 + (ends[4] - 112) / 2, 738, (ends[4] - 112) / 2 + 26, 30))
  await draw(hand('check: why does it not slide?', ends[4] + 60, 728, 21))
  await saved()
  await shot(['write', null], ['write-phone', [800, 170, 2740, 1560]])

  // ---------------------------------------------------------------- the other notebooks get a page each
  await openNotebook('Math Notes')
  await pen()
  await draw(hand('Quadratics', 110, 92, 40))
  await draw(hand('x² + 5x + 6 = 0', 130, 190, 30))
  await draw(hand('(x + 2)(x + 3) = 0', 130, 260, 30))
  await draw(hand('x = -2  or  x = -3', 130, 330, 30))
  await highlight('#86efac', 128, 470, 348)
  await saved()

  await openNotebook('Chemistry')
  await pen()
  await draw(hand('Moles', 110, 92, 40))
  await draw(hand('n = m / M', 130, 190, 30))
  await draw(hand('M(H₂O) = 18 g/mol', 130, 260, 30))
  await pen('#2563eb')
  await draw(hand('36 g of water = 2 mol', 130, 330, 30))
  await saved()

  await openNotebook('Biology')
  await pen()
  await draw(hand('The cell', 110, 92, 40))
  await draw(ellipse(330, 330, 200, 130))
  await pen('#2563eb')
  await draw(ellipse(360, 330, 60, 44))
  await draw(hand('nucleus', 440, 470, 24))
  await saved()

  // ---------------------------------------------------------------- the library
  await win.getByRole('button', { name: /^Notebooks$/ }).first().click()
  await sleep(800)
  await shot(['notebooks', [420, 140, 2460, 900]])

  // ---------------------------------------------------------------- a PDF worksheet, annotated
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([595, 842])
  const ink = rgb(0.12, 0.13, 0.16)
  page.drawText('Kinematics: worksheet 3', { x: 56, y: 770, size: 20, font: bold, color: ink })
  page.drawText('Show your working. Take g = 9.8 m/s².', { x: 56, y: 744, size: 11, font, color: rgb(0.35, 0.37, 0.42) })
  const qs = [
    '1.  A ball is dropped from rest from a height of 20 m.',
    '     How long does it take to reach the ground?',
    '',
    '',
    '',
    '',
    '2.  A car accelerates uniformly from 5 m/s to 25 m/s in 4 s.',
    '     Find its acceleration and the distance it travels.'
  ]
  qs.forEach((q, i) => page.drawText(q, { x: 56, y: 700 - i * 22, size: 12, font, color: ink }))
  const pdfPath = join(dataDir, '..', `Kinematics-worksheet-${Date.now()}.pdf`)
  await writeFile(pdfPath, await doc.save())
  await openNotebook('Physics')
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, pdfPath)
  await win.click('[data-testid="import-menu"]')
  await win.getByRole('menuitem', { name: 'PDF…' }).click()
  await win.waitForSelector('[data-testid="pdf-layer"][data-render-scale]')
  await sleep(800)
  // A PDF page is 1240 units wide like any page (here 1 PDF point = 2.08 units); about the top 840 are on screen.
  await highlight('#fde047', 516, 690, 290)
  await pen('#2563eb')
  const q1 = [hand('s = ½ g t²', 152, 382, 24), hand('20 = 4.9 t²', 152, 430, 24), hand('t = 2.0 s', 152, 478, 24)]
  for (const st of q1) await draw(st)
  await pen('#e5484d')
  const tEnd = Math.max(...q1[2].flat().map((p) => p[0]))
  await draw(ellipse((152 + tEnd) / 2, 492, (tEnd - 152) / 2 + 22, 24))
  await pen('#2563eb')
  await draw(hand('a = (25 - 5) / 4 = 5 m/s²', 152, 650, 24))
  await draw(hand('s = ½ (5 + 25) × 4 = 60 m', 152, 700, 24))
  await saved()
  await shot(['pdf', [400, 0, 2880, 1600]])
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
