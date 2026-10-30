/**
 * Cloud AI acceptance test: the AI Tutor on Inkling's free AI server, driven
 * through the real Electron app. The server is the real beta-server code
 * (handler + ledger) on a local port, in front of a fake Workers AI model
 * (tests/support/fakeBeta.mjs). Covers: a fresh install ready on the cloud
 * AI with no code or account, consent before the first upload, streaming
 * chat about a handwritten selection, practice, approved on-page marks, the
 * daily allowance shown and enforced, and switching to the local tutor.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/cloud.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { startBetaServer } from '../support/fakeBeta.mjs'
import { startFakeOllama } from '../support/fakeOllama.mjs'
import { strokesFor } from '../support/handwriting.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-cloud-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-cloud-config-'))
const server = await startBetaServer({ installDailyNeurons: 800 })
const ollama = await startFakeOllama()
let installId = ''
const env = {
  ...process.env,
  INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir,
  INKLING_CONFIG_DIR: configDir,
  INKLING_TEST_HOOKS: '1',
  // What a release build has built in (MAIN_VITE_INKLING_BETA_URL).
  INKLING_BETA_URL: server.url,
  INKLING_OLLAMA_URL: ollama.url,
  INKLING_GEMINI_BASE_URL: 'http://127.0.0.1:9',
  INKLING_AI_LIMITS: JSON.stringify({ minIntervalMs: 0, duplicateWindowMs: 0 })
}
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app, win
async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  win.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"], [data-testid="note-view"]')
  await sleep(300)
}
const openSettings = async () => {
  await win.getByRole('button', { name: 'AI settings', exact: true }).click()
  await win.waitForSelector('[data-testid="ai-settings"]')
}
const closeSettings = () => win.getByRole('button', { name: 'Close settings' }).click()
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
const lasso = async ([x0, y0, x1, y1]) => {
  await win.click('[data-testid="tool-lasso"]')
  await drawPage([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]])
  await win.waitForSelector('[data-testid="selection-toolbar"]')
}
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
const activePageObjects = () => win.evaluate(() => window.__inkling.notebookContext.page(document.querySelector('[data-testid="page-surface"]').dataset.pageId).then((p) => p.objects))
const lastCall = () => server.ai.calls.at(-1)
const serverQuota = async () => (await (await fetch(`${server.url}/v1/status`, { headers: { 'x-inkling-install': installId } })).json()).quota
const quotaUsed = async () => (await serverQuota()).installUsed
/**
 * The count of answers left shown under the tutor matches the server's own
 * figure, without restarting (Hermes QA, Beta 1: it stayed at ~10 until a
 * restart). Reading the server's status here costs no model usage.
 */
async function shownMatchesServer(label) {
  const expected = (await serverQuota()).approxAnswersLeft
  try {
    await win.waitForFunction((n) => document.querySelector('[data-testid="ai-answers-left"]')?.getAttribute('data-left') === String(n), expected, { timeout: 5000 })
  } catch {
    const shown = await win.getAttribute('[data-testid="ai-answers-left"]', 'data-left').catch(() => null)
    assert.fail(`${label}: the panel shows ${shown} answers left, the server says ${expected}`)
  }
  return expected
}

try {
  // ================================================================ setup
  console.log('setup')
  await launch()
  // A fresh install of a build with the server built in: ready, no code, key or account.
  await win.getByText(/Inkling AI · Qwen/).first().waitFor()
  assert.equal(await win.getByText(/access code|beta code/i).count(), 0, 'nothing asks for a code')
  await openSettings()
  assert.equal(await win.getAttribute('[data-testid="ai-settings"]', 'data-provider'), 'cloud', 'a fresh install starts on the cloud AI')
  assert.equal(await win.locator('[data-testid="ai-beta-url"], [data-testid="ai-beta-token"]').count(), 0, 'no address or code to enter')
  await win.locator('[data-testid="ai-cloud-quota"]').getByText(/About \d+ free answers? left today on this computer/).waitFor()
  await win.click('[data-testid="ai-test"]')
  await win.locator('[data-testid="ai-test-result"]').getByText(/uses none of your answers/).waitFor()
  assert.equal(server.ai.calls.length, 0, 'the status check calls no model')
  const settings = JSON.parse(await readFile(join(configDir, 'ai-settings.json'), 'utf8'))
  assert.match(settings.installId, /^inst_[A-Za-z0-9_-]{22,64}$/, 'a random installation ID was created')
  installId = settings.installId
  assert.equal((await readdir(configDir)).includes('beta-access.bin'), false)
  await win.screenshot({ path: join(shots, 'cloud-settings.png') })
  await closeSettings()
  const leftAtStart = await shownMatchesServer('before any question')
  step('a fresh install is ready on the cloud AI: no code, key, account or download; today’s allowance shown; no model call')

  // ================================================================ chat
  console.log('chat')
  await win.click('[data-testid="tool-pen"]')
  const strokes = [...strokesFor('x²+5x+6=0', 140, 160, 46), ...strokesFor('(x+2)(x+3)=0', 140, 240, 46), ...strokesFor('x=2, 3', 140, 320, 46)]
  for (const s of strokes) await drawPage(s)
  await sleep(300)
  const userObjects = await activePageObjects()
  await lasso([110, 130, 760, 410])
  await win.click('[data-testid="ask-ai-selection"]')
  server.ai.reply({ chunks: ['I read: $x^2+5x+6=0$, $(x+2)(x+3)=0$, $x = 2, 3$.\n\n', 'The factorisation is right, but each factor is zero when ', '$x = -2$ or $x = -3$.'], chunkDelayMs: 250, usage: { inputTokens: 1600, outputTokens: 90 } })
  await ask('Is this right?')
  await win.waitForSelector('[data-testid="ai-consent"][data-provider="cloud"]')
  await win.getByText(/does not use it to train models/).first().waitFor()
  assert.equal(server.ai.calls.length, 0, 'nothing is sent before consent')
  await win.click('[data-testid="ai-consent-allow"]')
  await waitAnswer('streaming')
  await waitAnswer('done')
  const call = lastCall()
  assert.equal(call.model, '@cf/qwen/qwen3.8-27b')
  assert.equal(call.inputs.stream, true)
  assert.equal(call.inputs.reasoning_effort, 'low')
  assert.match(call.inputs.messages[0].content, /You are Inkling's AI tutor/, 'the server supplies the instructions')
  const imgs = call.inputs.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []))
  assert.equal(imgs.length, 1, 'the selection goes as one image')
  assert.match(imgs[0].image_url.url, /^data:image\/jpeg;base64,/)
  const answer = await win.locator('[data-testid="tutor-message"][data-role="model"]').last().textContent()
  assert.match(answer, /−2|-2/)
  await win.locator('[data-testid="ai-provider-note"]').getByText(/AI server only when you ask\. About \d answers? left today/).waitFor()
  const leftAfterChat = await shownMatchesServer('after the first chat answer')
  assert.equal(await win.locator('[data-testid="tutor-session-note"]').count(), 1, 'the chat says it is kept for this session only')
  const afterChat = await quotaUsed()
  assert.ok(afterChat > 80 && afterChat < 100, `the answer cost about 92 Neurons (${afterChat})`)
  await win.screenshot({ path: join(shots, 'cloud-chat.png') })
  assert.ok(leftAfterChat < leftAtStart, `the count went down without a restart (${leftAtStart} → ${leftAfterChat})`)
  step(`streamed an answer about the handwriting image after consent; the server charged ${afterChat} Neurons and the panel shows what is left`)

  // ================================================================ on-page marks
  console.log('page')
  await win.locator('[data-testid="tutor-show-on-page"]').first().click()
  await win.waitForSelector('[data-testid="markup-proposal"]')
  assert.equal(lastCall().task, 'annotate')
  await shownMatchesServer('after a page markup (structured answer)')
  assert.match(lastCall().inputs.messages[0].content, /bbox_2d/, 'Qwen is asked for its native boxes')
  assert.match(lastCall().inputs.messages[0].content, /JSON Schema/)
  assert.equal(await win.locator('[data-testid="markup-item"]').count(), 3)
  assert.equal((await activePageObjects()).length, userObjects.length, 'nothing is added before approval')
  await win.getByRole('button', { name: 'Add 3 to my page' }).click()
  await win.waitForSelector('[data-testid="markup-applied"]')
  await sleep(400)
  const added = (await activePageObjects()).slice(userObjects.length)
  assert.ok(added.length >= 3 && added.every((o) => o.author === 'ai'))
  assert.ok(added.find((o) => o.type === 'text' && o.text === 'x = −2, −3'))
  const inkYs = userObjects.flatMap((o) => o.points.map((p) => p[1]))
  const [top, bottom] = [Math.min(...inkYs), Math.max(...inkYs)]
  const lowest = Math.max(...added.filter((o) => o.type === 'stroke').flatMap((o) => o.points.map((p) => p[1])))
  assert.ok(lowest > top + (bottom - top) * 0.6, 'the ✗ sits by the last line')
  await win.keyboard.press('Escape')
  await win.screenshot({ path: join(shots, 'cloud-markup-applied.png') })
  await win.keyboard.press('ControlOrMeta+z')
  await sleep(200)
  assert.equal((await activePageObjects()).length, userObjects.length)
  step('the cloud model’s marks were previewed, approved as one undoable AI-authored step, at the right line')

  // ================================================================ practice
  console.log('practice')
  await win.click('[data-testid="tutor-tab-practice"]')
  await win.click('[data-testid="practice-generate"]')
  await win.waitForFunction(() => document.querySelector('[data-testid="practice-position"]')?.textContent === '1 / 2')
  assert.equal(lastCall().task, 'practice')
  await shownMatchesServer('after a practice set (structured answer)')
  await win.fill('[data-testid="practice-answer"]', 'x = 3')
  await win.click('[data-testid="practice-check"]')
  await win.getByText('Correct!').waitFor()
  const callsBeforeCheck = server.ai.calls.length
  await shownMatchesServer('after an answer check (structured answer)')
  assert.equal(server.ai.calls.length, callsBeforeCheck, 'keeping the count current calls no model')
  step('practice problems generated and an answer checked through the cloud AI; the count stayed current after each')

  // ================================================================ allowance runs out
  console.log('allowance')
  await win.click('[data-testid="tutor-tab-chat"]')
  const before = server.ai.calls.length
  // A big answer uses up the rest; the next request is refused by the server before the model.
  server.ai.reply({ text: 'A long answer.', usage: { inputTokens: 3000, outputTokens: 2400 } })
  await ask('Explain everything about quadratics.')
  await waitAnswer()
  await ask('And one more thing?')
  await win.locator('[data-testid="tutor-error"][data-code="daily_quota"]').getByText(/used today’s free AI answers on this computer.*notebooks work as usual/).waitFor()
  assert.equal(server.ai.calls.length, before + 1, 'the refused request never reached the model')
  assert.equal(await win.locator('[data-testid="tutor-retry"]').count(), 0, 'no pointless retry button')
  await win.locator('[data-testid="ai-answers-left"]').getByText(/used up/).waitFor()
  await shownMatchesServer('after the server refused for the day')
  await win.screenshot({ path: join(shots, 'cloud-quota.png') })
  step('when the allowance is used up the tutor says so plainly and stops; nothing paid, no retry loop')

  await win.click('[data-testid="tutor-use-local"]')
  await win.waitForSelector('[data-testid="ai-settings"][data-provider="ollama"]')
  await win.click('[data-testid="ai-ollama-refresh"]')
  await win.waitForSelector('[data-testid="ai-ollama-status"][data-running="true"]')
  await closeSettings()
  await ask('Is (x+2)(x+3) right?')
  await waitAnswer()
  assert.ok(ollama.requests.some((r) => r.path === '/api/chat'), 'the local tutor answered')
  step('one click switches to the local Ollama tutor, which still works')

  console.log('\nCloud AI acceptance: all checks passed')
} catch (err) {
  console.error('\nCloud AI acceptance FAILED:', err)
  await win?.screenshot({ path: join(shots, 'cloud-failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  await server.close()
  await ollama.close()
}
