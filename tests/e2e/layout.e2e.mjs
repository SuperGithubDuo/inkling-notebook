/**
 * Layout acceptance test at the supported window sizes (minimum 960×600):
 * with the library, page list and AI Tutor all open, the top toolbar must not
 * overlap the notebook title or the save status, the save status must stay
 * visible, and the floating dock must stay inside the canvas, clear of the
 * tutor's question box. Checked for a handwriting page and a rich-text note.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/layout.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const env = {
  ...process.env,
  INKLING_DATA_DIR: await mkdtemp(join(tmpdir(), 'inkling-layout-')),
  INKLING_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'inkling-layout-config-')),
  INKLING_TEST_HOOKS: '1',
  INKLING_OLLAMA_URL: 'http://127.0.0.1:9'
}
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const SIZES = [
  [960, 600],
  [1024, 700],
  [1100, 700],
  [1180, 760],
  [1200, 760],
  [1280, 800],
  [1536, 960]
]

let app
try {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="page-surface"]')
  if (!(await win.locator('[data-testid="tutor-panel"]').count())) await win.click('[data-testid="toggle-tutor"]')
  await win.waitForSelector('[data-testid="tutor-panel"]')

  const measure = (toolbarLabel) =>
    win.evaluate((label) => {
      const box = (el) => (el ? el.getBoundingClientRect() : null)
      const visible = (el) => {
        const b = box(el)
        return !!b && b.width > 0 && b.height > 0
      }
      const tools = [...document.querySelectorAll(`[role="toolbar"][aria-label="${label}"] > *`)].filter(visible).map(box)
      const title = box(document.querySelector('[data-testid="notebook-title"]'))
      const save = document.querySelector('[data-testid="save-status"]')
      const more = [...document.querySelectorAll('header [data-testid^="more-menu"]')].filter(visible).map(box)
      const right = [...document.querySelectorAll('header [data-testid="toggle-tutor"]')].map(box)[0]
      const dock = box([...document.querySelectorAll('main button')].find((b) => /Ask AI/.test(b.getAttribute('aria-label') ?? b.textContent ?? '')))
      return {
        titleRight: title.right,
        toolsLeft: Math.min(...tools.map((b) => b.left)),
        toolsRight: Math.max(...tools.map((b) => b.right), ...more.map((b) => b.right)),
        saveLeft: box(save).left,
        saveText: save.textContent,
        saveVisible: visible(save),
        tutorLeft: right.left,
        dockLeft: dock?.left ?? null,
        dockRight: dock?.right ?? null,
        mainLeft: box(document.querySelector('main')).left,
        mainRight: box(document.querySelector('main')).right,
        composerLeft: box(document.querySelector('[data-testid="tutor-input"]'))?.left ?? null
      }
    }, toolbarLabel)

  const check = async (kind, label) => {
    for (const [w, h] of SIZES) {
      await win.setViewportSize({ width: w, height: h })
      await win.waitForTimeout(350)
      const m = await measure(label)
      const at = `${kind} at ${w}×${h}: ${JSON.stringify(m)}`
      assert.ok(m.titleRight <= m.toolsLeft + 0.5, `toolbar overlaps the notebook title — ${at}`)
      assert.ok(m.toolsRight <= m.saveLeft + 0.5, `toolbar overlaps the save status — ${at}`)
      assert.ok(m.saveVisible && /Saved|Saving|Save failed|Conflict/.test(m.saveText), `save status hidden — ${at}`)
      assert.ok(m.saveLeft < m.tutorLeft, `save status overlaps the tutor button — ${at}`)
      if (m.dockRight !== null) {
        assert.ok(m.dockLeft >= m.mainLeft - 0.5 && m.dockRight <= m.mainRight + 0.5, `the dock spills out of the canvas — ${at}`)
        if (m.composerLeft !== null) assert.ok(m.dockRight <= m.composerLeft, `the dock covers the tutor's question box — ${at}`)
      }
      if (w === 960) await win.screenshot({ path: join(shots, `layout-${kind}-${w}.png`) })
    }
    step(`${kind}: no overlaps at ${SIZES.map(([w, h]) => `${w}×${h}`).join(', ')}`)
  }

  await check('page', 'Drawing tools')
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.click('[data-testid="add-note"]')
  await win.waitForSelector('[data-testid="note-view"]')
  await check('note', 'Formatting')
  console.log('\nLayout acceptance: all checks passed')
} catch (err) {
  console.error('\nLayout acceptance FAILED:', err)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
