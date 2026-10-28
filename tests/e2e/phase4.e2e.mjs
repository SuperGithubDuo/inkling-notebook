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
import { BAD_KEY, VALID_KEY, errors, startFakeGemini } from '../support/fakeGemini.mjs'
import { strokesFor } from '../support/handwriting.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e4-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-e2e4-config-'))
const fake = await startFakeGemini()
const env = {
  ...process.env,
  INKLING_DATA_DIR: dataDir,
  INKLING_CONFIG_DIR: configDir,
  INKLING_TEST_HOOKS: '1',
  INKLING_GEMINI_BASE_URL: fake.url,
  // Pacing is unit-tested; here requests follow each other within milliseconds.
  INKLING_AI_LIMITS: JSON.stringify({ minIntervalMs: 0, perMinute: 1000 })
}
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

const lib = async () => JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
async function surface() {
  const box = await win.locator('[data-testid="page-surface"]').boundingBox()
  const width = await win.evaluate(() => document.querySelector('[data-testid="page-surface"]').dataset.pageWidth ?? null)
  return { x: box.x, y: box.y, k: box.width / Number(width ?? 1240) }
}
async function drawPage(points) {
  const s = await surface()
  const [first, ...rest] = points.map(([x, y]) => [s.x + x * s.k, s.y + y * s.k])
  await win.mouse.move(first[0], first[1])
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(x, y, { steps: 4 })
  await win.mouse.up()
}
const write = async (text, x, y, h) => {
  for (const stroke of strokesFor(text, x, y, h)) await drawPage(stroke)
}
const messages = () => win.locator('[data-testid="tutor-message"]')
const lastAnswer = () => win.locator('[data-testid="tutor-message"][data-role="model"]').last()
const waitAnswer = async (status = 'done') => {
  await win.waitForFunction(
    (st) => {
      const all = document.querySelectorAll('[data-testid="tutor-message"][data-role="model"]')
      return all[all.length - 1]?.getAttribute('data-status') === st
    },
    status,
    { timeout: 15000 }
  )
}
const ask = async (text) => {
  await win.fill('[data-testid="tutor-input"]', text)
  await win.press('[data-testid="tutor-input"]', 'Enter')
}
const lastGenerate = () => fake.generated().at(-1)
const imagesIn = (req) => req.body.contents.flatMap((c) => c.parts).filter((p) => p.inlineData)
const textIn = (req) => req.body.contents.flatMap((c) => c.parts).map((p) => p.text ?? '').join('\n')
/** Pixel size of a base64 JPEG, decoded by the browser. */
const imageSize = (b64) =>
  win.evaluate(async (d) => {
    const img = new Image()
    img.src = `data:image/jpeg;base64,${d}`
    await img.decode()
    return { w: img.naturalWidth, h: img.naturalHeight }
  }, b64)

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
  await win.getByText(/Connected · Gemini 3.5 Flash-Lite/).waitFor()
  await win.screenshot({ path: join(shots, 'p4-settings-connected.png') })

  await app.close()
  await launch()
  await win.getByText(/Connected · Gemini 3.5 Flash-Lite/).waitFor()
  await openSettings()
  assert.equal(await win.isChecked('[data-testid="ai-consent-toggle"]'), true)
  await win.click('[data-testid="ai-model-gemini-3.8-flash"]')
  await win.screenshot({ path: join(shots, 'p4-settings.png') })
  await closeSettings()
  step('key, model and consent survive a restart')

  // ==================================================================== chat
  console.log('chat')
  // Handwrite a worked problem with a mistake (11 − 3 = 7).
  await win.click('[data-testid="tool-pen"]').catch(() => {})
  await write('2x+3=11', 140, 180, 46)
  await write('2x=7', 140, 260, 46)
  await write('x=3.5', 140, 340, 46)
  await sleep(300)
  const mathPageId = (await lib()).notebooks.find((n) => n.name === 'Math Notes').pages.find((p) => !p.deletedAt).id
  const strokes = await win.evaluate((id) => window.__inkling.notebookContext.page(id).then((p) => p.objects.length), mathPageId)
  assert.ok(strokes >= 20, `wrote ${strokes} strokes`)
  await win.click('[data-testid="tool-lasso"]')
  await drawPage([[110, 150], [520, 150], [520, 420], [110, 420], [110, 152]])
  await win.waitForSelector('[data-testid="selection-toolbar"]')
  await win.click('[data-testid="ask-ai-selection"]')
  await win.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'tutor-input', null, { timeout: 2000 })
  await win.locator('[data-testid="tutor-context-chip"]').getByText(/Selection · \d+ items/).waitFor()
  step('lasso selection → Ask AI focuses the tutor with the selection as context')

  fake.requests.length = 0
  fake.reply({ chunks: ['I can read your work: $2x + 3 = 11$.\n\n', 'Subtract $3$ from both sides:\n\n$$2x = 8$$\n\n', 'So $x = 4$, not $3.5$.'], chunkDelayMs: 250 })
  await ask('Is my work right?')
  await waitAnswer('streaming')
  const partial = await lastAnswer().textContent()
  await waitAnswer('done')
  const full = await lastAnswer().textContent()
  assert.ok(partial.length < full.length, 'answer streamed in pieces')
  assert.ok((await lastAnswer().locator('.katex').count()) >= 4, 'math rendered with KaTeX')
  assert.equal(await lastAnswer().locator('.katex-display').count(), 1)
  let sent = lastGenerate()
  assert.equal(sent.model, 'gemini-3.8-flash')
  assert.equal(sent.task, 'chat')
  assert.equal(sent.body.contents.length, 1)
  const [img] = imagesIn(sent)
  assert.equal(img.inlineData.mimeType, 'image/jpeg')
  const size = await imageSize(img.inlineData.data)
  assert.ok(Math.max(size.w, size.h) <= 1024 && size.w > 200, `image ${size.w}×${size.h}`)
  assert.ok(img.inlineData.data.length < 400_000, `image is ${img.inlineData.data.length} base64 chars`)
  assert.match(textIn(sent), /<selection>[\s\S]*Is my work right\?/)
  step(`streamed a Markdown + KaTeX answer about a ${size.w}×${size.h} JPEG crop of the selection`)
  await win.screenshot({ path: join(shots, 'p4-chat.png') })

  // Follow-up: multi-turn, and the earlier image is reused rather than re-rendered.
  await ask('Why is it 8?')
  await waitAnswer()
  sent = lastGenerate()
  assert.deepEqual(sent.body.contents.map((c) => c.role), ['user', 'model', 'user'])
  assert.match(sent.body.contents[1].parts[0].text, /x = 4/)
  assert.equal(imagesIn(sent).length, 1)
  step('multi-turn follow-up carries the conversation')

  await win.locator('button', { hasText: 'Give me a hint' }).first().click()
  await waitAnswer()
  assert.match(textIn(lastGenerate()), /Give me a hint for the next step\. Do not give the final answer\./)
  step('quick action sends its prompt with the selection')

  // Stop a streaming answer.
  fake.reply({ chunks: ['Let me think about this carefully'], hang: true })
  await ask('Explain everything in detail')
  await waitAnswer('streaming')
  await win.click('[data-testid="tutor-stop"]')
  await waitAnswer('canceled')
  await lastAnswer().getByText('Stopped.').waitFor()
  await win.waitForSelector('[data-testid="tutor-send"]')
  step('a streaming answer can be stopped')

  // Free-tier errors are explained and handled without hammering the API.
  fake.reply({ error: errors.perMinute('3s') })
  await ask('One more question')
  await waitAnswer('error')
  await win.locator('[data-testid="tutor-error"][data-code="rate_limited"]').getByText(/Try again in 3 seconds/).waitFor()
  const before = fake.generated().length
  await win.click('[data-testid="tutor-retry"]')
  await win.locator('[data-testid="tutor-error"]').getByText(/needs a short pause/).waitFor()
  assert.equal(fake.generated().length, before, 'no API call during the cooldown')
  await sleep(3200)
  await win.click('[data-testid="tutor-retry"]')
  await waitAnswer()
  step('per-minute limit: friendly message, local cooldown, retry succeeds')

  fake.reply({ error: errors.perDay() })
  await ask('And another')
  await waitAnswer('error')
  const quota = win.locator('[data-testid="tutor-error"][data-code="daily_quota"]')
  await quota.getByText(/used today's free Gemini requests/).waitFor()
  assert.equal((await win.evaluate(() => window.inkling.ai.status())).model, 'gemini-3.8-flash', 'model not switched automatically')
  await win.screenshot({ path: join(shots, 'p4-chat-quota.png') })
  await quota.locator('[data-testid="tutor-switch-model"]').click()
  await waitAnswer()
  assert.equal(lastGenerate().model, 'gemini-3.5-flash-lite')
  step('daily quota: explained; switching to Flash-Lite only when the user clicks')

  // Page context without a selection, and no context at all.
  await win.keyboard.press('Escape')
  await win.click('[data-testid="tool-pen"]').catch(() => {})
  await win.locator('[data-testid="tutor-context-chip"]').getByText('This page').waitFor()
  await ask('What topic is this page about?')
  await waitAnswer()
  sent = lastGenerate()
  assert.match(textIn(sent), /<page title="[^"]*">[\s\S]*handwritten part of the page/)
  assert.equal(imagesIn(sent).length, 1, 'page context: one image of the handwritten area')
  await win.click('[aria-label="Don\'t include the page"]')
  await ask('What is a quadratic?')
  await waitAnswer()
  sent = lastGenerate()
  assert.doesNotMatch(textIn(sent).split('What is a quadratic?')[0].split('\n').slice(-3).join(''), /<page|<selection/)
  assert.ok(!/<page|<selection/.test(sent.body.contents.at(-1).parts.map((p) => p.text ?? '').join('')))
  await win.click('[data-testid="tutor-context-add"]')
  step('page context sends page text + a cropped image; context can be left out')

  // Withdrawing consent: nothing is sent until the user agrees again.
  await openSettings()
  await win.uncheck('[data-testid="ai-consent-toggle"]')
  await sleep(100)
  await closeSettings()
  const count = fake.generated().length
  await ask('Are you still there?')
  await win.waitForSelector('[data-testid="ai-consent"]')
  await win.screenshot({ path: join(shots, 'p4-consent.png') })
  await win.getByRole('button', { name: 'Not now' }).click()
  await win.locator('[data-testid="tutor-error"][data-code="consent_required"]').waitFor()
  assert.equal(fake.generated().length, count)
  await ask('Are you still there?')
  await win.click('[data-testid="ai-consent-allow"]')
  await waitAnswer()
  assert.equal(fake.generated().length, count + 1)
  step('consent is asked before sending; declining sends nothing')

  // New chat clears the thread.
  await win.click('[data-testid="tutor-clear"]')
  assert.equal(await messages().count(), 0)
  await win.waitForSelector('[data-testid="quick-hint"]')
  step('new chat')

  assert.deepEqual(cspViolations, [])
  step('no Content-Security-Policy violations')
  console.log('\nPhase 4 acceptance: all checks passed')
} finally {
  await app?.close().catch(() => {})
  await fake.close()
}
