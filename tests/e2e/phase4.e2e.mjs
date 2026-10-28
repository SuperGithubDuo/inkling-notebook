/**
 * Phase 4 acceptance test: the AI Tutor on Gemini, driven through the real
 * Electron app and the official SDK, against a local fake of the Gemini API
 * (tests/support/fakeGemini.mjs). Sections share one data folder:
 *   settings  – key, consent, model choice, connection test, key storage
 *   chat      – streaming, multi-turn, selection image, quick actions, errors (added with that milestone)
 *   practice  – generated problems, hints, answer checking                 (added with that milestone)
 *   page      – "Show this on my page": preview, approve, undo               (added with that milestone)
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/phase4.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { BAD_KEY, VALID_KEY, startFakeGemini } from '../support/fakeGemini.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e4-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-e2e4-config-'))
const fake = await startFakeGemini()
const env = { ...process.env, INKLING_DATA_DIR: dataDir, INKLING_CONFIG_DIR: configDir, INKLING_TEST_HOOKS: '1', INKLING_GEMINI_BASE_URL: fake.url }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app, win
const cspViolations = []
async function launch() {
  app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  win.on('console', (m) => {
    if (m.type() !== 'error') return
    console.error('CONSOLE', m.text())
    if (/Content Security Policy/.test(m.text())) cspViolations.push(m.text())
  })
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"], [data-testid="note-view"]')
  await sleep(300)
}
const openSettings = async () => {
  await win.getByRole('button', { name: 'AI settings', exact: true }).click()
  await win.waitForSelector('[data-testid="ai-settings"]')
}
const closeSettings = () => win.getByRole('button', { name: 'Close settings' }).click()
const testResult = () => win.locator('[data-testid="ai-test-result"]')

try {
  // ================================================================ settings
  console.log('settings')
  await launch()
  assert.equal(await win.getAttribute('[data-testid="ai-status"]', 'data-state'), 'setup')
  await openSettings()

  // A malformed key is rejected before anything is sent.
  await win.fill('[data-testid="ai-key-input"]', 'not a key')
  await win.click('[data-testid="ai-key-save"]')
  await win.getByText('That does not look like a Gemini API key.').waitFor()
  assert.equal(fake.requests.length, 0)
  step('malformed key refused locally')

  // A key Google rejects: saved, but the connection test says why.
  await win.fill('[data-testid="ai-key-input"]', BAD_KEY)
  await win.click('[data-testid="ai-key-save"]')
  await testResult().getByText(/Google rejected this API key/).waitFor()
  await win.click('[data-testid="ai-key-remove"]')
  await win.waitForSelector('[data-testid="ai-key-input"]')
  step('rejected key explained by the connection test, and removable')

  fake.requests.length = 0
  await win.fill('[data-testid="ai-key-input"]', VALID_KEY)
  await win.click('[data-testid="ai-key-save"]')
  await testResult().getByText(/Connected \(\d+ ms\)\. No notebook content was sent\./).waitFor()
  await win.getByText(`Key ending in …${VALID_KEY.slice(-4)}`).waitFor()
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.path}`),
    ['GET /v1beta/models', 'POST /v1beta/models/gemini-3.8-flash:streamGenerateContent']
  )
  assert.ok(fake.requests[1].body.generationConfig.maxOutputTokens <= 64)
  await win.locator('[data-testid="ai-model-gemini-3.8-flash"]').getByText('available').waitFor()
  await win.locator('[data-testid="ai-model-gemini-3.5-flash-lite"]').getByText('available').waitFor()
  step('valid key: connection test lists models and sends one tiny request')

  // The key never appears in plain text on disk, and never in the notebook folder.
  const configFiles = await readdir(configDir)
  assert.ok(configFiles.includes('gemini-key.bin'), configFiles.join())
  for (const f of configFiles) {
    const s = await readFile(join(configDir, f)).catch(() => Buffer.alloc(0))
    assert.ok(!s.includes(VALID_KEY), `${f} contains the key in plain text`)
  }
  const grepDir = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await grepDir(p)
      else assert.ok(!(await readFile(p)).includes(VALID_KEY), `${p} contains the key`)
    }
  }
  await grepDir(dataDir)
  // The renderer can only see the last four characters.
  const status = await win.evaluate(() => window.inkling.ai.status())
  assert.ok(!JSON.stringify(status).includes(VALID_KEY))
  assert.equal(status.keyHint, VALID_KEY.slice(-4))
  step(`key stored encrypted (${status.keyProtection}) outside the notebooks; renderer sees only the hint`)

  // Model choice, with the model the key lacks flagged.
  fake.setModels([{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }])
  await win.click('[data-testid="ai-test"]')
  await testResult().getByText(/is not offered to it/).waitFor()
  await win.locator('[data-testid="ai-model-gemini-3.8-flash"]').getByText('not offered to this key').waitFor()
  await win.click('[data-testid="ai-model-gemini-3.5-flash-lite"]')
  await win.click('[data-testid="ai-test"]')
  await testResult().getByText(/Connected/).waitFor()
  fake.setModels([
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
  ])
  step('unavailable model flagged; switching to Flash-Lite is the user’s choice')

  // Consent is off until given, and remembered.
  assert.equal(await win.isChecked('[data-testid="ai-consent-toggle"]'), false)
  await win.check('[data-testid="ai-consent-toggle"]')
  await sleep(100)
  await closeSettings()
  assert.equal(await win.getAttribute('[data-testid="ai-status"]', 'data-state'), 'ready')
  await win.getByText('Connected · Gemini 3.5 Flash-Lite').waitFor()
  await win.screenshot({ path: join(shots, 'p4-settings-connected.png') })

  await app.close()
  await launch()
  await win.getByText('Connected · Gemini 3.5 Flash-Lite').waitFor()
  await openSettings()
  assert.equal(await win.isChecked('[data-testid="ai-consent-toggle"]'), true)
  await win.click('[data-testid="ai-model-gemini-3.8-flash"]')
  await win.screenshot({ path: join(shots, 'p4-settings.png') })
  await closeSettings()
  step('key, model and consent survive a restart')

  assert.deepEqual(cspViolations, [])
  step('no Content-Security-Policy violations')
  console.log('\nPhase 4 acceptance: all checks passed')
} finally {
  await app?.close().catch(() => {})
  await fake.close()
}
