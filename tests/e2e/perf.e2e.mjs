/**
 * Large-notebook check: a notebook with 300 pages, one of them holding 3,000
 * handwritten strokes (150,000 points), plus 30 notes. Measures what a
 * student would feel and fails only on clearly unusable numbers:
 * start-up, opening the heavy page, the delay before a new stroke is
 * drawn, saving the heavy page, search, and switching pages.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/perf.e2e.mjs
 * Numbers go to test-results/perf.json. They come from a virtual display on
 * a CI-class machine and are only indicative of real hardware.
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-perf-'))
const step = (msg) => console.log(`  ✓ ${msg}`)
const now = Date.now()

// ------------------------------------------------------------ the notebook
const nbId = 'nb-perf-000001'
const pages = []
for (let i = 0; i < 300; i++) pages.push({ id: `pg-perf-${String(i).padStart(4, '0')}`, kind: 'canvas', title: `Lecture ${i + 1}`, tags: [], createdAt: now, updatedAt: now, deletedAt: null })
for (let i = 0; i < 30; i++) pages.push({ id: `nt-perf-${String(i).padStart(4, '0')}`, kind: 'note', title: `Summary ${i + 1}`, tags: ['revision'], createdAt: now, updatedAt: now, deletedAt: null })
const heavyId = pages[0].id
const library = { schemaVersion: 2, folders: [], notebooks: [{ id: nbId, name: 'Year notebook', color: '#3b6fe0', icon: 'sigma', favorite: false, folderId: null, createdAt: now, updatedAt: now, deletedAt: null, pages }] }
const dir = join(dataDir, 'notebooks', nbId)
await mkdir(join(dir, 'pages'), { recursive: true })
await mkdir(join(dir, 'notes'), { recursive: true })
await writeFile(join(dataDir, 'library.json'), JSON.stringify(library))
const strokes = []
for (let s = 0; s < 3000; s++) {
  const x0 = 60 + (s % 30) * 38
  const y0 = 60 + Math.floor(s / 30) * 16
  strokes.push({ id: `s${s}`, createdAt: now, author: 'user', type: 'stroke', tool: 'pen', color: '#1f2430', size: 2.5, opacity: 1, hasPressure: false, points: Array.from({ length: 50 }, (_, i) => [x0 + i * 0.6, y0 + Math.sin(i / 3 + s) * 4]) })
}
const page = (id, objects) => ({ schemaVersion: 3, id, notebookId: nbId, width: 1240, height: 1754, paper: { type: 'lined', spacing: 40, color: '#dbe3ef' }, objects, background: null, updatedAt: now })
await writeFile(join(dir, 'pages', `${heavyId}.json`), JSON.stringify(page(heavyId, strokes)))
for (const p of pages.slice(1, 300)) await writeFile(join(dir, 'pages', `${p.id}.json`), JSON.stringify(page(p.id, strokes.slice(0, 40))))
for (const p of pages.slice(300)) {
  const doc = { type: 'doc', content: Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${i} about kinematics, momentum and energy conservation in ${p.title}.` }] })) }
  await writeFile(join(dir, 'notes', `${p.id}.json`), JSON.stringify({ schemaVersion: 1, id: p.id, notebookId: nbId, doc, updatedAt: now }))
}
step(`wrote a notebook of ${pages.length} pages; the first has ${strokes.length} strokes (${strokes.length * 50} points)`)

const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir, INKLING_TEST_HOOKS: '1', INKLING_AUTO_BACKUP_DELAY_MS: '600000' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const m = {}
let app
try {
  const t0 = Date.now()
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector(`[data-testid="page-surface"][data-page-id="${heavyId}"]`, { timeout: 60000 })
  m.startToHeavyPageMs = Date.now() - t0
  step(`start-up to the heavy page on screen: ${m.startToHeavyPageMs} ms`)

  // Input latency: time from pointer-down to the stroke appearing in the page model, then on disk.
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  await win.click('[data-testid="tool-pen"]')
  const before = await win.evaluate((id) => window.__inkling.notebookContext.page(id).then((p) => p.objects.length), heavyId)
  const ts = Date.now()
  await win.mouse.move(box.x + 300, box.y + 700)
  await win.mouse.down()
  for (let i = 1; i <= 20; i++) await win.mouse.move(box.x + 300 + i * 8, box.y + 700 + Math.sin(i) * 10)
  await win.mouse.up()
  await win.waitForFunction(([id, n]) => window.__inkling.notebookContext.page(id).then((p) => p.objects.length === n + 1), [heavyId, before])
  m.strokeCommitMs = Date.now() - ts
  await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 20000 })
  m.strokeToSavedMs = Date.now() - ts
  step(`drawing a stroke (20 moves) on the heavy page and committing it: ${m.strokeCommitMs} ms; saved to disk after ${m.strokeToSavedMs} ms`)

  // Per-frame cost while drawing: average time between pointer moves being handled.
  m.frameMs = await win.evaluate(async () => {
    const times = []
    let last = performance.now()
    await new Promise((resolve) => {
      let n = 0
      const tick = () => {
        const t = performance.now()
        times.push(t - last)
        last = t
        if (++n < 60) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    times.sort((a, b) => a - b)
    return { median: Math.round(times[30]), p95: Math.round(times[57]) }
  })
  step(`frame time on the heavy page: median ${m.frameMs.median} ms, 95th percentile ${m.frameMs.p95} ms`)

  const tsSearch = Date.now()
  await win.keyboard.press('ControlOrMeta+f')
  await win.keyboard.type('momentum')
  await win.waitForSelector('[data-testid="search-result"]', { timeout: 20000 })
  m.searchMs = Date.now() - tsSearch
  await win.keyboard.press('Escape')
  step(`search across 30 notes: first results after ${m.searchMs} ms (including typing)`)

  const tsSwitch = Date.now()
  await win.keyboard.press('PageDown')
  await win.waitForSelector(`[data-testid="page-surface"][data-page-id="${pages[1].id}"]`)
  await win.keyboard.press('PageUp')
  await win.waitForSelector(`[data-testid="page-surface"][data-page-id="${heavyId}"]`)
  m.switchBackAndForthMs = Date.now() - tsSwitch
  step(`switching to the next page and back to the heavy one: ${m.switchBackAndForthMs} ms`)
  await win.screenshot({ path: join(shots, 'perf-heavy-page.png') })

  await writeFile(join(shots, 'perf.json'), JSON.stringify({ at: new Date().toISOString(), pages: pages.length, heavyStrokes: strokes.length, metrics: m }, null, 2))
  // Only clearly unusable numbers fail.
  assert.ok(m.startToHeavyPageMs < 30000, 'opens in under 30 s')
  assert.ok(m.strokeCommitMs < 5000, 'a stroke lands in under 5 s')
  assert.ok(m.strokeToSavedMs < 15000, 'saves in under 15 s')
  console.log('\nLarge-notebook check: done')
} catch (err) {
  console.error('\nLarge-notebook check FAILED:', err)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
