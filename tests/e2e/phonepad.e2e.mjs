/**
 * PhonePad acceptance test: the real app, the real phone page, the real
 * WebSocket — with the "phone" being a phone-sized window of Electron's own
 * Chromium (mouse pointer input), plus a protocol-level client for reconnects.
 *
 * Runs over loopback (INKLING_PHONEPAD_LOOPBACK=1, test runs only), because CI
 * has no Wi-Fi. Real phones on a real network are tested by hand: see
 * docs/phonepad.md.
 *
 * Covers: pairing dialog and QR URL; phone connects and the dialog closes;
 * strokes land where the area says, undistorted; undo/redo/eraser/clear from
 * the phone; mixing with mouse ink and desktop undo; zoomed writing; the
 * phone's picture of the page; reconnect mid-stroke without duplicates or
 * loss; a wrong code and a second phone are refused; saved and in the PDF
 * export; reopens after a restart; disconnect from the computer.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/phonepad.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { pdfjsDataDir } from '../support/pdfjsData.mjs'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-phonepad-'))
const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir, INKLING_TEST_HOOKS: '1', INKLING_PHONEPAD_LOOPBACK: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (msg) => console.log(`  ✓ ${msg}`)
const errors = []
let app
let win

async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(`desktop: ${e.message}`))
  win.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`desktop console: ${m.text()}`))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('[data-testid="page-surface"]')
  await sleep(300)
}

const activePage = async () => {
  const el = win.locator('[data-testid="page-surface"]')
  const pageId = await el.getAttribute('data-page-id')
  const lib = JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
  const nb = lib.notebooks.find((n) => n.pages.some((p) => p.id === pageId))
  return { pageId, notebookId: nb.id, notebookName: nb.name }
}
const readPage = async ({ notebookId, pageId }) => JSON.parse(await readFile(join(dataDir, 'notebooks', notebookId, 'pages', `${pageId}.json`), 'utf8'))
const strokesOnDisk = async (ref) => (await readPage(ref)).objects.filter((o) => o.type === 'stroke')
async function waitStrokes(ref, n, timeout = 6000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await strokesOnDisk(ref)
      if (last.length === n) return last
    } catch {
      /* mid-write */
    }
    await sleep(100)
  }
  throw new Error(`expected ${n} strokes on disk, found ${last?.length}`)
}
const bounds = (s) => {
  const xs = s.points.map((p) => p[0])
  const ys = s.points.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
const area = () => win.evaluate(() => window.__inkling.phonepad.area())

// ===================================================================== pair
await launch()
const ref = await activePage()
await win.click('[data-testid="phonepad-button"]')
await win.waitForSelector('[data-testid="phonepad-pairing"]')
const url = await win.locator('[data-testid="phonepad-pairing"]').getAttribute('data-url')
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43}$/)
const code = await win.locator('[data-testid="phonepad-code"]').textContent()
assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
await win.screenshot({ path: join(shots, 'phonepad-01-pairing.png') })
step('Connect phone opens the pairing dialog with a QR URL (secret in the fragment) and a short code')

// A phone that types a wrong code is refused (protocol level).
const origin = url.split('/#')[0]
async function rawClient(token, client) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin } })
  const inbox = []
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)))
  ws.send(JSON.stringify({ type: 'hello', v: 2, token, client, device: 'Script' }))
  const until = async (pred, ms = 4000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const m = inbox.find(pred)
      if (m) return m
      await sleep(20)
    }
    throw new Error('message never came')
  }
  return { ws, inbox, until, send: (m) => ws.send(JSON.stringify(m)) }
}
const wrong = await rawClient('ZZZZ-ZZZZ', 'wrong-client-1')
assert.equal((await wrong.until((m) => m.type === 'error')).code, 'bad-token')
step('a wrong pairing code is refused')

// ===================================================================== the phone
await app.evaluate(({ BrowserWindow }, u) => {
  const w = new BrowserWindow({ width: 844, height: 390, title: 'phone', webPreferences: { sandbox: true, contextIsolation: true } })
  void w.loadURL(u)
}, url)
const phone = await app.waitForEvent('window', { predicate: (p) => p.url().startsWith(origin) })
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`))
phone.on('console', (m) => m.type() === 'error' && errors.push(`phone console: ${m.text()}`))
await phone.setViewportSize({ width: 844, height: 390 }) // iPhone 14, landscape
await phone.waitForSelector('#app[data-conn="live"]')
await phone.waitForSelector('#card', { state: 'hidden' })
assert.equal(await phone.evaluate(() => location.hash), '', 'secret removed from the address bar')
await win.waitForSelector('[data-testid="phonepad-button"][data-state="connected"]')
await win.waitForSelector('[data-testid="phonepad-dialog"]', { state: 'detached' })
step('the phone page opens from the QR URL, connects, and the dialog gets out of the way')

// A second phone is refused while the first is paired.
const token = url.split('#t=')[1]
const intruder = await rawClient(token, 'intruder-phone-1')
assert.equal((await intruder.until((m) => m.type === 'error')).code, 'already-paired')
step('a second phone with the same QR is refused')

// ===================================================================== writing
const surfaceSize = { w: 844, h: 390 }
async function phoneStroke(points, steps = 4) {
  const [first, ...rest] = points
  await phone.mouse.move(first[0], first[1])
  await phone.mouse.down()
  for (const [x, y] of rest) await phone.mouse.move(x, y, { steps })
  await phone.mouse.up()
}
const circle = (cx, cy, r, n = 40) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)])

await sleep(400) // the phone's first picture
const a1 = await area()
assert.ok(a1, 'writing area exists')
assert.ok(Math.abs(a1.width / a1.height - surfaceSize.w / surfaceSize.h) < 0.01, `area has the phone's aspect (${a1.width / a1.height})`)
await phoneStroke(circle(450, 195, 120))
let strokes = await waitStrokes(ref, 1)
{
  const b = bounds(strokes[0])
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const expectedD = (240 / surfaceSize.w) * a1.width
  assert.ok(Math.abs(w - h) / w < 0.03, `circle stays round: ${w.toFixed(1)} × ${h.toFixed(1)}`)
  assert.ok(Math.abs(w - expectedD) / expectedD < 0.03, `size maps exactly: ${w.toFixed(1)} vs ${expectedD.toFixed(1)}`)
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  assert.ok(Math.abs(cx - (a1.x + (450 / surfaceSize.w) * a1.width)) < 2, 'centre x lands where the area says')
  assert.ok(Math.abs(cy - (a1.y + (195 / surfaceSize.h) * a1.height)) < 2, 'centre y lands where the area says')
  assert.equal(strokes[0].tool, 'pen')
  assert.equal(strokes[0].author, 'user')
  assert.equal(strokes[0].hasPressure, false, 'no pressure claimed for a non-stylus pointer')
}
step('a circle drawn on the phone is saved as a normal stroke, round and exactly where the area maps it')

await sleep(500)
await phone.screenshot({ path: join(shots, 'phonepad-02-phone-landscape.png') })
await win.screenshot({ path: join(shots, 'phonepad-03-desktop-frame.png') })
// The phone shows the page: its canvas has the paper and the committed ink from the computer's picture.
const inkPixels = await phone.evaluate(() => {
  const c = document.getElementById('ink')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let dark = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 120 && d[i + 3] > 200) dark++
  return dark
})
assert.ok(inkPixels > 500, `phone shows the ink from the computer's picture (${inkPixels} dark pixels)`)
step('the phone shows a live picture of its area, including the ink')

// Undo/redo from the phone are the notebook's.
await phone.click('#undo')
await waitStrokes(ref, 0)
await phone.click('#redo')
strokes = await waitStrokes(ref, 1)
step('undo and redo on the phone undo and redo in the notebook')

// The phone's eraser.
await phone.click('#tool-eraser')
await phoneStroke([[300, 195], [600, 195]], 10)
await waitStrokes(ref, 0)
await phone.click('#undo')
await waitStrokes(ref, 1)
await phone.click('#tool-pen')
step('the phone eraser erases (one undo step brings it back)')

// Mouse ink and phone ink mix; desktop undo still works.
const surf = await win.locator('[data-testid="page-surface"]').boundingBox()
await win.mouse.move(surf.x + 120, surf.y + 640)
await win.mouse.down()
await win.mouse.move(surf.x + 360, surf.y + 660, { steps: 8 })
await win.mouse.up()
await waitStrokes(ref, 2)
await phoneStroke([[200, 300], [700, 300]])
await waitStrokes(ref, 3)
await win.keyboard.press('ControlOrMeta+z')
await waitStrokes(ref, 2)
await win.keyboard.press('ControlOrMeta+Shift+z')
await waitStrokes(ref, 3)
step('phone and mouse ink mix on one page with one undo history')

// Clear from the phone (asks first), then undo it.
await phone.click('#clear')
await phone.waitForSelector('#clear.arm')
await phone.click('#clear')
// The phone strokes are inside the area; the mouse stroke near the bottom of the page isn't.
const after = await waitStrokes(ref, 1)
assert.ok(after.every((s) => bounds(s).y0 > a1.y + a1.height - 1 || bounds(s).x0 < a1.x), 'only ink inside the area was cleared')
await phone.click('#undo')
await waitStrokes(ref, 3)
step('clear (confirmed) removes the ink inside the area as one undoable step')

// ===================================================================== infinite paper
const count = async () => (await strokesOnDisk(ref)).length
const pageNow = () => readPage(ref)
// Two fingers on the phone (Chromium's mouse has one pointer, so dispatch touch pointers to the page's own handlers).
async function twoFingers(from, to, steps = 10) {
  await phone.evaluate(
    ({ from, to, steps }) => {
      const s = document.getElementById('surface')
      const ev = (type, id, x, y) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 11, bubbles: true }))
      ev('pointerdown', 11, ...from[0])
      ev('pointerdown', 12, ...from[1])
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const lerp = (k) => [from[k][0] + (to[k][0] - from[k][0]) * t, from[k][1] + (to[k][1] - from[k][1]) * t]
        ev('pointermove', 11, ...lerp(0))
        ev('pointermove', 12, ...lerp(1))
      }
      ev('pointerup', 11, ...to[0])
      ev('pointerup', 12, ...to[1])
    },
    { from, to, steps }
  )
  await sleep(450) // the phone tells the computer where it looks (throttled)
}

let n = await count()
// Pinch to zoom in on the phone: only the phone's view changes, instantly, and no ink is left.
await twoFingers([[400, 195], [440, 195]], [[320, 195], [520, 195]])
const a2 = await area()
assert.ok(a2.width < a1.width * 0.3, `pinch zooms the phone's paper in (${a1.width.toFixed(0)} → ${a2.width.toFixed(0)} page units across)`)
assert.ok(Math.abs(a2.width / a2.height - surfaceSize.w / surfaceSize.h) < 0.01, 'still the phone’s shape')
assert.equal(await count(), n, 'a two-finger gesture leaves no ink')
await phoneStroke(circle(450, 195, 120))
strokes = await waitStrokes(ref, ++n)
{
  const b = bounds(strokes.at(-1))
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  assert.ok(Math.abs(w - (240 / surfaceSize.w) * a2.width) / w < 0.03, `zoomed ink maps exactly (${w.toFixed(1)})`)
  assert.ok(Math.abs(w - h) / w < 0.03, 'zoomed ink stays round')
  assert.ok(Math.abs((b.x0 + b.x1) / 2 - (a2.x + (450 / surfaceSize.w) * a2.width)) < 1, 'zoomed ink lands where the phone shows it')
}
step('pinching on the phone zooms its own paper (no ink left behind); writing zoomed in is smaller, exact and undistorted')

// The computer's zoom no longer moves the phone: each has its own view.
await win.keyboard.press('ControlOrMeta+=')
await sleep(300)
assert.deepEqual(await area(), a2, 'zooming the computer leaves the phone where it is')
await win.keyboard.press('ControlOrMeta+0')
await sleep(300)
await twoFingers([[320, 195], [520, 195]], [[400, 195], [440, 195]])
const a3 = await area()
assert.ok(Math.abs(a3.width - a1.width) / a1.width < 0.05, 'pinching back out restores the view')
step('the computer and the phone zoom independently')

// Pan past the page's top-left corner with two fingers, then write there: the page grows to fit.
const before = await pageNow()
const firstCircle = bounds(before.objects.find((o) => o.type === 'stroke'))
await twoFingers([[300, 100], [500, 100]], [[600, 300], [800, 300]])
await twoFingers([[300, 100], [500, 100]], [[600, 300], [800, 300]])
const a4 = await area()
assert.ok(a4.x < -200 && a4.y < -100, `panned past the page's top-left (${a4.x.toFixed(0)}, ${a4.y.toFixed(0)})`)
await phone.screenshot({ path: join(shots, 'phonepad-07-past-the-edge.png') })
// A stroke at the top-left of the phone's screen: well left of and above the page.
const at = [[120, 60], [180, 90], [240, 60]]
const expectStart = [a4.x + (at[0][0] / surfaceSize.w) * a4.width, a4.y + (at[0][1] / surfaceSize.h) * a4.height]
await phoneStroke(at)
strokes = await waitStrokes(ref, ++n)
const grown = await pageNow()
const dx = grown.width - before.width
const dy = grown.height - before.height
assert.ok(dx > 0 && dy > 0, `the page grew left and up (${dx} × ${dy})`)
assert.equal(dx % before.paper.spacing, 0, 'by whole paper squares, so the paper stays aligned with the ink')
assert.equal(dy % before.paper.spacing, 0)
const movedCircle = bounds(grown.objects.find((o) => o.type === 'stroke'))
assert.ok(Math.abs(movedCircle.x0 - firstCircle.x0 - dx) < 0.02 && Math.abs(movedCircle.y0 - firstCircle.y0 - dy) < 0.02, 'existing ink moved with the page corner')
const newStart = strokes.at(-1).points[0]
assert.ok(Math.abs(newStart[0] - dx - expectStart[0]) < 1.5 && Math.abs(newStart[1] - dy - expectStart[1]) < 1.5, 'the new ink sits exactly where it was drawn, relative to the old ink')
assert.ok(newStart[0] >= 0 && newStart[1] >= 0, 'and on the page')
const a5 = await area()
assert.ok(Math.abs(a5.x - (a4.x + dx)) < 0.5 && Math.abs(a5.y - (a4.y + dy)) < 0.5, 'the phone kept its place through the move')
await sleep(500)
await phone.screenshot({ path: join(shots, 'phonepad-08-grown.png') })
await win.screenshot({ path: join(shots, 'phonepad-09-desktop-grown.png') })
step('infinite paper: writing past the top-left grows the page there; old ink, new ink and both views stay aligned')

// One undo step takes back both the ink and the growth.
await phone.click('#undo')
await waitStrokes(ref, --n)
assert.deepEqual([(await pageNow()).width, (await pageNow()).height], [before.width, before.height], 'undo shrinks the page back')
await phone.click('#redo')
await waitStrokes(ref, ++n)
assert.equal((await pageNow()).width, grown.width)
step('undo removes the stroke and the growth together; redo brings both back')

// Back to the page for the pen tests.
await twoFingers([[600, 300], [800, 300]], [[300, 100], [500, 100]])
await twoFingers([[600, 300], [800, 300]], [[300, 100], [500, 100]])

// ===================================================================== pen colour and size
await phone.click('#swatch')
await phone.waitForSelector('#pen-card', { state: 'visible' })
await phone.screenshot({ path: join(shots, 'phonepad-10-pen-card.png') })
await phone.click('#colors button[aria-label="Green"]')
await phone.waitForSelector('#pen-card', { state: 'hidden' })
await phoneStroke([[300, 250], [500, 250]])
strokes = await waitStrokes(ref, ++n)
assert.equal(strokes.at(-1).color, '#16a34a', 'phone ink in the colour picked on the phone')
// It is the computer's pen now too: the mouse draws green.
{
  // Window coordinates inside the visible canvas (the page itself now extends off-screen up and left).
  await win.mouse.move(480, 640)
  await win.mouse.down()
  await win.mouse.move(640, 660, { steps: 6 })
  await win.mouse.up()
  strokes = await waitStrokes(ref, ++n)
  assert.equal(strokes.at(-1).color, '#16a34a', 'the computer’s pen follows the phone')
}
step('one tap opens the pen card; picking a colour applies it (on the computer too) and closes the card')

await phone.click('#swatch')
await phone.click('#sizes button[aria-label="Bold"]')
await phoneStroke([[300, 280], [500, 280]])
strokes = await waitStrokes(ref, ++n)
assert.equal(strokes.at(-1).size, 6.5, 'Bold preset')
await phone.click('#swatch')
await phone.evaluate(() => {
  const r = document.getElementById('size')
  r.value = '10'
  r.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(300)
// The card stays open while adjusting; a tap on the paper only closes it.
await phone.mouse.click(600, 200)
await phone.waitForSelector('#pen-card', { state: 'hidden' })
await sleep(300)
assert.equal(await count(), n, 'tapping the paper to close the card leaves no mark')
await phoneStroke([[300, 310], [500, 310]])
strokes = await waitStrokes(ref, ++n)
assert.equal(strokes.at(-1).size, 10, 'slider size')
step('size presets and the slider set the pen; closing the card by tapping the paper draws nothing')

// The computer's pen choice shows on the phone.
await win.click('[data-testid="color-#2563eb"]')
await phone.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--nib').trim() === '#2563eb')
step('changing the pen on the computer updates the phone')

// Portrait: the area takes the phone's new shape.
await phone.setViewportSize({ width: 390, height: 844 })
await sleep(700)
const ap = await area()
assert.ok(Math.abs(ap.width / ap.height - 390 / 844) < 0.02, `portrait area (${(ap.width / ap.height).toFixed(3)})`)
await phone.screenshot({ path: join(shots, 'phonepad-04-phone-portrait.png') })
await phoneStroke(circle(195, 400, 100))
strokes = await waitStrokes(ref, ++n)
{
  const b = bounds(strokes.at(-1))
  assert.ok(Math.abs(b.x1 - b.x0 - (b.y1 - b.y0)) / (b.x1 - b.x0) < 0.03, 'round in portrait too')
}
await phone.setViewportSize({ width: 844, height: 390 })
await sleep(500)
step('rotating the phone reshapes its view; ink stays undistorted')

// Opening the bare address (no QR) asks for the short code.
await app.evaluate(({ BrowserWindow }, u) => {
  const w = new BrowserWindow({ width: 390, height: 844, title: 'phone-2', webPreferences: { sandbox: true, contextIsolation: true } })
  void w.loadURL(u)
}, origin + '/')
const bare = await app.waitForEvent('window', { predicate: (p) => p.url() === origin + '/' })
await bare.setViewportSize({ width: 390, height: 844 })
await bare.waitForSelector('#code-form', { state: 'visible' })
await bare.screenshot({ path: join(shots, 'phonepad-04b-code-entry.png') })
await bare.close()
step('the bare address asks for the short code')

// ===================================================================== reconnect
// Take the phone's identity, close its window (Wi-Fi gone), and continue as a script.
const creds = await phone.evaluate(() => ({ token: sessionStorage.getItem('inkling.pp.token'), client: sessionStorage.getItem('inkling.pp.client') }))
await phone.close()
await win.waitForSelector('[data-testid="phonepad-button"][data-state="reconnecting"]')
step('closing the phone shows Reconnecting on the computer')

const s1 = await rawClient(creds.token, creds.client)
await s1.until((m) => m.type === 'welcome')
const replayed = await s1.until((m) => m.type === 'status')
const resumeView = await area()
await win.waitForSelector('[data-testid="phonepad-button"][data-state="connected"]')
const sid = 'resumeStroke01'
const pts = Array.from({ length: 30 }, (_, i) => [0.2 + i * 0.01, 0.5, i * 8])
const msgs = [
  { type: 'ink', stroke: sid, seq: 0, phase: 'down', points: [pts[0]], tool: 'pen', pointer: 'touch', view: [resumeView.x, resumeView.y, resumeView.width, resumeView.height], epoch: replayed.page.epoch },
  { type: 'ink', stroke: sid, seq: 1, phase: 'move', points: pts.slice(1, 10) },
  { type: 'ink', stroke: sid, seq: 2, phase: 'move', points: pts.slice(10, 20) },
  { type: 'ink', stroke: sid, seq: 3, phase: 'up', points: pts.slice(20) }
]
s1.send(msgs[0])
s1.send(msgs[1])
await s1.until((m) => m.type === 'ack' && m.id === sid && m.seq >= 1)
s1.ws.terminate() // Wi-Fi drops mid-stroke
await sleep(200)
const s2 = await rawClient(creds.token, creds.client)
await s2.until((m) => m.type === 'welcome')
// The phone resends everything unacknowledged — and here, deliberately, everything.
for (const m of msgs) s2.send(m)
strokes = await waitStrokes(ref, ++n)
assert.equal(strokes.at(-1).points.length >= 20, true, 'the whole stroke arrived')
await sleep(300)
assert.equal(await count(), n, 'and only once')
step('reconnecting mid-stroke finishes the stroke once, with nothing lost or duplicated')

// ===================================================================== persistence and export
await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 6000 })
const { PDFDocument } = await import('pdf-lib')
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
async function exportOps(name) {
  const out = join(dataDir, `${name}.pdf`)
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, out)
  await win.click('[data-testid="more-menu-canvas"]')
  await win.getByRole('menuitem', { name: /Export notebook as PDF/ }).click()
  await win.waitForSelector('[role="alert"]:has-text("Exported to")', { timeout: 20000 })
  const bytes = await readFile(out)
  await PDFDocument.load(bytes)
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: pdfjsDataDir('standard_fonts') }).promise
  const lib = JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
  const nb = lib.notebooks.find((n) => n.id === ref.notebookId)
  const idx = nb.pages.filter((p) => !p.deletedAt && p.kind === 'canvas').findIndex((p) => p.id === ref.pageId)
  const ops = await (await doc.getPage(idx + 1)).getOperatorList()
  await sleep(400)
  return ops.fnArray.length
}
const withInk = await exportOps('with-phone-ink')
// Remove the last three phone strokes and export again: the difference is the phone's ink.
for (let i = 0; i < 3; i++) await win.keyboard.press('ControlOrMeta+z')
await waitStrokes(ref, n - 3)
const withLess = await exportOps('with-less-ink')
assert.ok(withInk > withLess + 6, `phone strokes are in the PDF as drawing operations (${withInk} vs ${withLess})`)
for (let i = 0; i < 3; i++) await win.keyboard.press('ControlOrMeta+Shift+z')
await waitStrokes(ref, n)
step('phone handwriting is saved and included in the exported PDF')

// Disconnect from the computer: the phone is told.
await win.click('[data-testid="phonepad-button"]')
await win.waitForSelector('[data-testid="phonepad-connected"]')
await win.screenshot({ path: join(shots, 'phonepad-05-connected-dialog.png') })
await win.click('[data-testid="phonepad-disconnect"]')
await s2.until((m) => m.type === 'bye')
await win.waitForSelector('[data-testid="phonepad-button"][data-state="off"]')
await assert.rejects(fetch(origin + '/'), 'server is gone')
step('Disconnect tells the phone and stops listening on the network')

await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 6000 })
await app.close()
await launch()
const reopened = await win.evaluate((id) => window.__inkling?.notebookContext?.page(id), ref.pageId)
const reopenedStrokes = (await strokesOnDisk(ref)).length
assert.equal(reopenedStrokes, n)
assert.ok(!reopened || reopened.kind === 'canvas')
assert.equal(await win.locator('[data-testid="phonepad-button"]').getAttribute('data-state'), 'off', 'PhonePad is off after a restart (pairing is always explicit)')
await win.screenshot({ path: join(shots, 'phonepad-06-after-restart.png') })
step('after a restart the phone’s handwriting is still there, and PhonePad starts off')
await app.close()

if (errors.length) {
  console.error(errors.join('\n'))
  throw new Error(`${errors.length} page error(s)`)
}
console.log('PhonePad: all acceptance checks passed')
