/**
 * Local-AI acceptance test: the AI Tutor on Ollama (the default provider),
 * driven through the real Electron app against a local fake of the Ollama
 * API (tests/support/fakeOllama.mjs). Covers setup (Ollama stopped, started,
 * model missing / installed), streaming chat about a handwritten selection,
 * practice, and "Show this on my page": preview, approve, undo/redo, edit.
 *
 * The same run captures the exact images Inkling sends for the handwriting
 * scenarios (A: algebra mistake, B: correct algebra, C: free-body diagram).
 * With UPDATE_FIXTURES=1 they are written to tests/fixtures/handwriting/ for
 * the live local-model tests (tests/live/).
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/ollama.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { startFakeOllama } from '../support/fakeOllama.mjs'
import { freeBodyDiagram, strokesFor } from '../support/handwriting.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const fixturesDir = join(root, 'tests/fixtures/handwriting')
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-ollama-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-ollama-config-'))
const fake = await startFakeOllama()
fake.setDown(true)
const env = {
  ...process.env,
  INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir,
  INKLING_CONFIG_DIR: configDir,
  INKLING_TEST_HOOKS: '1',
  INKLING_OLLAMA_URL: fake.url,
  // Gemini is never used here; point it at nothing so a slip would fail loudly.
  INKLING_GEMINI_BASE_URL: 'http://127.0.0.1:9'
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
const drawAll = async (strokes) => {
  for (const stroke of strokes) await drawPage(stroke)
}
const lasso = async ([x0, y0, x1, y1]) => {
  await win.click('[data-testid="tool-lasso"]')
  await drawPage([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]])
  await win.waitForSelector('[data-testid="selection-toolbar"]')
}
const newPage = async () => {
  await win.click('[data-testid="add-page"]')
  await sleep(300)
  await win.click('[data-testid="tool-pen"]')
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
const lastChat = () => fake.chats().at(-1)
const imagesOf = (req) => req.body.messages.flatMap((m) => m.images ?? [])
const activePageObjects = () => win.evaluate(() => window.__inkling.notebookContext.page(document.querySelector('[data-testid="page-surface"]').dataset.pageId).then((p) => p.objects))
const imageSize = (b64) =>
  win.evaluate(async (d) => {
    const img = new Image()
    img.src = `data:image/jpeg;base64,${d}`
    await img.decode()
    return { w: img.naturalWidth, h: img.naturalHeight }
  }, b64)
const captured = {}
const capture = async (name, b64) => {
  captured[name] = b64
  await writeFile(join(shots, `ollama-${name}.jpg`), Buffer.from(b64, 'base64'))
  if (process.env.UPDATE_FIXTURES === '1') {
    await mkdir(fixturesDir, { recursive: true })
    await writeFile(join(fixturesDir, `${name}.jpg`), Buffer.from(b64, 'base64'))
  }
}

try {
  // ================================================================ setup
  console.log('setup')
  await launch()
  await win.getByText('Start Ollama to use the tutor').waitFor()
  assert.equal(await win.getAttribute('[data-testid="ai-status"]', 'data-state'), 'setup')
  assert.match(await win.textContent('[data-testid="ai-provider-note"]'), /on this computer by Ollama/)
  await openSettings()
  assert.equal(await win.getAttribute('[data-testid="ai-settings"]', 'data-provider'), 'ollama')
  assert.equal(await win.getAttribute('[data-testid="ai-ollama-status"]', 'data-running'), 'false')
  await win.getByText(/Ollama isn't running/).waitFor()
  assert.ok(await win.locator('[data-testid="ai-ollama-status"] a[href="https://ollama.com/download"]').count())
  step('Ollama is the default provider; a stopped server is explained, with where to get it')

  fake.setDown(false)
  await win.click('[data-testid="ai-ollama-refresh"]')
  await win.waitForSelector('[data-testid="ai-ollama-status"][data-running="true"]')
  await win.getByText('Ollama 0.40.13 is running on this computer.').waitFor()
  assert.equal(await win.getAttribute('[data-testid="ai-model-qwen3-vl:4b-instruct"]', 'data-availability'), 'available')
  assert.equal(await win.getAttribute('[data-testid="ai-model-qwen3-vl:2b-instruct"]', 'data-availability'), 'available')
  assert.equal(await win.getAttribute('[data-testid="ai-model-qwen3-vl:8b-instruct"]', 'data-availability'), 'missing')
  assert.equal(await win.locator('[data-testid="ai-model-llama3.2:3b"]').count(), 0, 'text-only models are not offered')
  step('installed vision models discovered (4B, 2B); 8B shown as not installed; text-only models hidden')

  await win.click('[data-testid="ai-model-qwen3-vl:8b-instruct"]')
  await win.locator('[data-testid="ai-ollama-install"]').getByText('ollama pull qwen3-vl:8b-instruct').waitFor()
  await win.click('[data-testid="ai-test"]')
  await win.locator('[data-testid="ai-test-result"]').getByText(/isn't installed in Ollama yet.*ollama pull qwen3-vl:8b-instruct/).waitFor()
  assert.equal(fake.requests.filter((r) => r.path === '/api/chat').length, 0, 'nothing was generated for a missing model')
  step('choosing a model that is not installed shows the install command; nothing is downloaded')

  await win.click('[data-testid="ai-model-qwen3-vl:4b-instruct"]')
  await win.click('[data-testid="ai-test"]')
  await win.locator('[data-testid="ai-test-result"]').getByText(/Model answered in [\d.]+ s.*Nothing left this computer/).waitFor()
  assert.equal(await win.locator('[data-testid="ai-key-input"]').count(), 0, 'no API key is asked for')
  await win.getByText('Everything stays on this computer.').waitFor()
  await win.screenshot({ path: join(shots, 'ollama-settings.png') })
  await closeSettings()
  await win.getByText(/On this computer · Qwen3-VL 4B/).first().waitFor()
  assert.equal(await win.getAttribute('[data-testid="ai-status"]', 'data-state'), 'ready')
  step('Qwen3-VL 4B selected and tested; no key, no consent prompt; tutor ready')

  // ================================================================ scenario A: chat
  console.log('chat')
  await win.click('[data-testid="tool-pen"]')
  const aStrokes = [...strokesFor('x²+5x+6=0', 140, 160, 46), ...strokesFor('(x+2)(x+3)=0', 140, 240, 46), ...strokesFor('x=2, 3', 140, 320, 46)]
  await drawAll(aStrokes)
  await sleep(300)
  const userObjects = await activePageObjects()
  assert.equal(userObjects.length, aStrokes.length)
  await lasso([110, 130, 760, 410])
  await win.click('[data-testid="ask-ai-selection"]')
  fake.reply({ chunks: ['I read: $x^2+5x+6=0$, ', '$(x+2)(x+3)=0$, $x = 2, 3$.\n\n', 'The factorisation is right, but each factor is zero when ', '$x = -2$ or $x = -3$.'], chunkDelayMs: 250 })
  await ask('Is this right?')
  await waitAnswer('streaming')
  await waitAnswer('done')
  const sent = lastChat()
  assert.equal(sent.body.model, 'qwen3-vl:4b-instruct')
  assert.equal(sent.body.stream, true)
  assert.equal(sent.body.messages[0].role, 'system')
  assert.equal(imagesOf(sent).length, 1, 'the selection goes as one image')
  const size = await imageSize(imagesOf(sent)[0])
  assert.ok(Math.max(size.w, size.h) <= 1024)
  await capture('scenario-a', imagesOf(sent)[0])
  const answer = await win.locator('[data-testid="tutor-message"][data-role="model"]').last().textContent()
  assert.match(answer, /−2|-2/)
  // Follow-up keeps the history.
  await ask('Why negative?')
  await waitAnswer()
  const follow = lastChat().body.messages
  assert.deepEqual(follow.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.match(follow[2].content, /−2|-2/, 'the earlier answer is sent back as history')
  assert.equal(imagesOf(lastChat()).length, 1, 'at most one image per request')
  step(`streamed an answer about a ${size.w}×${size.h} image of the selection; a follow-up carries the history`)

  // ================================================================ on-page correction
  console.log('page')
  await win.locator('[data-testid="tutor-show-on-page"]').first().click()
  await win.waitForSelector('[data-testid="markup-proposal"]')
  const annotateReq = lastChat()
  assert.equal(annotateReq.task, 'annotate')
  assert.equal(annotateReq.body.format.properties.annotations.items.required.join(), 'kind,bbox_2d', 'Qwen is asked for its native boxes')
  assert.match(annotateReq.body.messages[0].content, /\[x1, y1, x2, y2\]/)
  assert.equal(await win.locator('[data-testid="markup-item"]').count(), 3)
  assert.equal((await activePageObjects()).length, userObjects.length, 'nothing is added before approval')
  await win.screenshot({ path: join(shots, 'ollama-markup-preview.png') })
  step('the local model proposed 3 marks; previewed, page unchanged')

  await win.getByRole('button', { name: 'Add 3 to my page' }).click()
  await win.waitForSelector('[data-testid="markup-applied"]')
  await sleep(400)
  let after = await activePageObjects()
  const added = after.slice(userObjects.length)
  assert.ok(added.length >= 3 && added.every((o) => o.author === 'ai'))
  assert.deepEqual(after.slice(0, userObjects.length), userObjects, "the student's own ink is untouched")
  const correction = added.find((o) => o.type === 'text' && o.text === 'x = −2, −3')
  assert.ok(correction, 'the correction is an editable text object')
  // The ✗ box was bbox_2d [60, 700, 500, 960] (x1, y1, x2, y2): the last line of the work.
  const inkYs = userObjects.flatMap((o) => o.points.map((p) => p[1]))
  const [top, bottom] = [Math.min(...inkYs), Math.max(...inkYs)]
  const crossYs = added.filter((o) => o.type === 'stroke').flatMap((o) => o.points.map((p) => p[1]))
  const lowest = Math.max(...crossYs)
  assert.ok(lowest > top + (bottom - top) * 0.6, `marks are placed by the last line (lowest mark y ${lowest.toFixed(0)}, ink ${top.toFixed(0)}–${bottom.toFixed(0)})`)
  await win.keyboard.press('Escape')
  await win.screenshot({ path: join(shots, 'ollama-markup-applied.png') })
  step('approved: AI-authored marks added at the right line, the correction as editable text')

  await win.keyboard.press('Control+z')
  await sleep(200)
  assert.equal((await activePageObjects()).length, userObjects.length)
  await win.keyboard.press('Control+Shift+z')
  await sleep(200)
  after = await activePageObjects()
  assert.equal(after.length, userObjects.length + added.length)
  step('one undo removes the correction; redo restores it')

  // A malformed local answer never reaches the page.
  await win.click('[data-testid="markup-view"] >> text=Mark up something else')
  await lasso([110, 130, 760, 410])
  const kept = (await activePageObjects()).length
  fake.reply({ json: { transcription: 'x', summary: 'bad', annotations: [{ kind: 'scribble', bbox_2d: [1, 2, 3, 4] }] } })
  await win.click('[data-testid="markup-start"]')
  await win.locator('[data-testid="tutor-error"][data-code="bad_response"]').waitFor()
  assert.equal((await activePageObjects()).length, kept)
  step('an answer that fails validation is rejected; the page is unchanged')

  // ================================================================ scenarios B and C: images captured
  console.log('scenarios')
  await newPage()
  await drawAll([...strokesFor('2x+3=11', 140, 160, 46), ...strokesFor('2x=8', 140, 240, 46), ...strokesFor('x=4', 140, 320, 46)])
  await lasso([110, 130, 560, 410])
  await win.click('[data-testid="markup-start"]')
  await win.waitForSelector('[data-testid="markup-proposal"]')
  await capture('scenario-b', imagesOf(lastChat())[0])
  await win.click('[data-testid="markup-discard"]')

  await newPage()
  await drawAll(freeBodyDiagram(320, 260, 130))
  await lasso([150, 120, 660, 560])
  await win.click('[data-testid="markup-start"]')
  await win.waitForSelector('[data-testid="markup-proposal"]')
  await capture('scenario-c', imagesOf(lastChat())[0])
  await win.click('[data-testid="markup-discard"]')
  step('captured the images sent for scenarios B (correct algebra) and C (free-body diagram)')

  // ================================================================ practice
  console.log('practice')
  await win.click('[data-testid="tutor-tab-practice"]')
  await win.click('[data-testid="practice-generate"]')
  await win.waitForFunction(() => document.querySelector('[data-testid="practice-position"]')?.textContent === '1 / 2')
  assert.ok(lastChat().body.format.properties.problems, 'practice uses the JSON schema as the output format')
  await win.fill('[data-testid="practice-answer"]', 'x = 3')
  await win.click('[data-testid="practice-check"]')
  await win.getByText('Correct!').waitFor()
  step('practice problems generated and a typed answer checked, as structured JSON')

  // ================================================================ Ollama stops
  console.log('errors')
  await win.click('[data-testid="tutor-tab-chat"]')
  fake.setDown(true)
  await ask('Still there?')
  await win.locator('[data-testid="tutor-error"][data-code="offline"]').getByText(/Ollama isn’t running/).waitFor()
  fake.setDown(false)
  await win.click('[data-testid="tutor-retry"]')
  await waitAnswer()
  step('Ollama stopping mid-session is explained; retry works once it is back')

  // Nothing went anywhere but the local fake.
  assert.ok(fake.requests.every((r) => r.path.startsWith('/api/')))
  console.log('\nOllama acceptance: all checks passed')
} catch (err) {
  console.error('\nOllama acceptance FAILED:', err)
  await win?.screenshot({ path: join(shots, 'ollama-failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  await fake.close()
}
