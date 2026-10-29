/**
 * Optional end-to-end check of the complete on-page workflow with a REAL local
 * model, through the app's UI: handwrite scenario A (a sign mistake), select
 * it, ask the tutor, "Show this on my page", look at the preview, approve,
 * then undo, redo and edit the AI's correction.
 *
 *   ollama pull qwen3-vl:4b-instruct
 *   npm run build && npm run test:live:app            (xvfb-run -a … on headless Linux)
 *   INKLING_LIVE_MODEL=qwen3-vl:2b-instruct npm run test:live:app
 *
 * Skips (exit 0) when Ollama isn't running or the model isn't installed.
 * Model-quality checks are reported, not asserted: the run fails only if the
 * app itself misbehaves (e.g. the page changes before approval, undo fails).
 * Writes test-results/live-app-<model>.md and screenshots.
 */
import { _electron as electron } from 'playwright-core'
import { electronPath } from '../support/electronPath.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { strokesFor } from '../support/handwriting.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = join(root, 'test-results')
await mkdir(shots, { recursive: true })
const model = process.env.INKLING_LIVE_MODEL ?? 'qwen3-vl:4b-instruct'
const ollama = 'http://127.0.0.1:11434'
const slug = model.replace(/[^a-z0-9.-]+/gi, '_')
const LONG = 15 * 60_000

// ---- Is a real model there?
try {
  const tags = await (await fetch(`${ollama}/api/tags`)).json()
  if (!tags.models?.some((m) => m.name === model)) {
    console.log(`Live app test skipped: ${model} is not installed (ollama pull ${model}).`)
    process.exit(0)
  }
} catch {
  console.log(`Live app test skipped: Ollama isn't running at ${ollama}.`)
  process.exit(0)
}

const dataDir = await mkdtemp(join(tmpdir(), 'inkling-live-app-'))
const configDir = await mkdtemp(join(tmpdir(), 'inkling-live-app-config-'))
await writeFile(join(configDir, 'ai-settings.json'), JSON.stringify({ version: 2, provider: 'ollama', models: { gemini: 'gemini-3.8-flash', ollama: model }, consent: null }))
// Test hooks expose the notebook context for reading the page; no AI endpoint is overridden,
// so the app talks to the real Ollama on 127.0.0.1:11434.
const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir, INKLING_CONFIG_DIR: configDir, INKLING_TEST_HOOKS: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
delete env.INKLING_OLLAMA_URL
delete env.INKLING_GEMINI_BASE_URL

const notes = []
const log = (line) => {
  console.log(`  ${line}`)
  notes.push(`- ${line}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let app, win
try {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"]')
  await win.waitForSelector('[data-testid="ai-status"][data-state="ready"]', { timeout: 30_000 })

  const surface = async () => {
    const box = await win.locator('[data-testid="page-surface"]').boundingBox()
    const width = await win.evaluate(() => Number(document.querySelector('[data-testid="page-surface"]').dataset.pageWidth))
    return { x: box.x, y: box.y, k: box.width / width }
  }
  const drawPage = async (points) => {
    const s = await surface()
    const [first, ...rest] = points.map(([x, y]) => [s.x + x * s.k, s.y + y * s.k])
    await win.mouse.move(first[0], first[1])
    await win.mouse.down()
    for (const [x, y] of rest) await win.mouse.move(x, y, { steps: 4 })
    await win.mouse.up()
  }
  const objects = () => win.evaluate(() => window.__inkling.notebookContext.page(document.querySelector('[data-testid="page-surface"]').dataset.pageId).then((p) => p.objects))
  const lastAnswer = () => win.locator('[data-testid="tutor-message"][data-role="model"]').last()

  await win.click('[data-testid="tool-pen"]')
  for (const s of [...strokesFor('x²+5x+6=0', 140, 160, 46), ...strokesFor('(x+2)(x+3)=0', 140, 240, 46), ...strokesFor('x=2, 3', 140, 320, 46)]) await drawPage(s)
  await sleep(300)
  const mine = await objects()
  await win.click('[data-testid="tool-lasso"]')
  await drawPage([[110, 130], [760, 130], [760, 410], [110, 410], [110, 132]])
  await win.waitForSelector('[data-testid="selection-toolbar"]')
  await win.click('[data-testid="ask-ai-selection"]')

  // 1–2: interpret the handwriting and find the error, streamed.
  let t0 = Date.now()
  await win.fill('[data-testid="tutor-input"]', 'Check my work. Find the first mistake, if any, explain why it is wrong and how to fix it.')
  await win.press('[data-testid="tutor-input"]', 'Enter')
  await win.waitForFunction(() => {
    const all = document.querySelectorAll('[data-testid="tutor-message"][data-role="model"]')
    return ['streaming', 'done', 'error'].includes(all[all.length - 1]?.getAttribute('data-status'))
  }, null, { timeout: LONG })
  const firstText = Date.now() - t0
  let sawStreaming = (await lastAnswer().getAttribute('data-status')) === 'streaming'
  await win.waitForFunction(() => {
    const all = document.querySelectorAll('[data-testid="tutor-message"][data-role="model"]')
    return ['done', 'error'].includes(all[all.length - 1]?.getAttribute('data-status'))
  }, null, { timeout: LONG })
  const chatMs = Date.now() - t0
  const answer = (await lastAnswer().textContent()) ?? ''
  assert.equal(await lastAnswer().getAttribute('data-status'), 'done', `the tutor failed: ${answer}`)
  log(`Chat answer: first text after ${(firstText / 1000).toFixed(1)} s, complete after ${(chatMs / 1000).toFixed(1)} s, ${sawStreaming ? 'streamed' : 'not seen streaming'}.`)
  log(`Mentions −2 and −3: ${/[−-]\s*2/.test(answer) && /[−-]\s*3/.test(answer) ? 'yes' : 'NO'}. Answer: “${answer.replace(/\s+/g, ' ').slice(0, 400)}”`)
  await win.screenshot({ path: join(shots, `live-app-${slug}-chat.png`) })

  // 3–4: propose a correction and preview it; nothing changes yet.
  t0 = Date.now()
  await win.locator('[data-testid="tutor-show-on-page"]').last().click()
  await win.waitForSelector('[data-testid="markup-proposal"], [data-testid="markup-view"] [data-testid="tutor-error"]', { timeout: LONG })
  const markupMs = Date.now() - t0
  const failed = await win.locator('[data-testid="markup-view"] [data-testid="tutor-error"]').count()
  if (failed) {
    const msg = await win.locator('[data-testid="markup-view"] [data-testid="tutor-error"]').textContent()
    log(`Markup FAILED after ${(markupMs / 1000).toFixed(1)} s: ${msg}`)
    assert.deepEqual(await objects(), mine, 'a failed markup leaves the page unchanged')
    log('The page was left unchanged.')
  } else {
    const items = await win.locator('label:has([data-testid="markup-item"])').allTextContents()
    log(`Markup proposal after ${(markupMs / 1000).toFixed(1)} s, validated, ${items.length} marks: ${items.map((s) => s.replace(/\s+/g, ' ').trim()).join(' | ')}`)
    const read = await win.locator('[data-testid="markup-view"]').textContent()
    log(`Proposal panel: “${read.replace(/\s+/g, ' ').slice(0, 400)}”`)
    assert.deepEqual(await objects(), mine, 'nothing is added before approval')
    await win.screenshot({ path: join(shots, `live-app-${slug}-preview.png`) })

    // 5–6: approve; editable AI objects; the student's ink untouched.
    await win.getByRole('button', { name: /^Add \d+ to my page$/ }).click()
    await win.waitForSelector('[data-testid="markup-applied"]')
    await sleep(500)
    const after = await objects()
    const added = after.slice(mine.length)
    assert.ok(added.length > 0 && added.every((o) => o.author === 'ai'), 'only AI-authored objects were added')
    assert.deepEqual(after.slice(0, mine.length), mine, "the student's ink is untouched")
    log(`Approved: ${added.length} AI-authored objects added (${[...new Set(added.map((o) => o.type))].join(', ')}); the student's strokes are unchanged.`)
    await win.keyboard.press('Escape')
    await win.screenshot({ path: join(shots, `live-app-${slug}-applied.png`) })

    // 7: undo and redo.
    await win.keyboard.press('Control+z')
    await sleep(300)
    assert.equal((await objects()).length, mine.length, 'undo removes the correction')
    await win.keyboard.press('Control+Shift+z')
    await sleep(300)
    assert.equal((await objects()).length, after.length, 'redo restores it')
    log('Undo removed all AI marks in one step; redo restored them.')

    // Edit an AI text object with the ordinary text tool.
    const text = (await objects()).find((o) => o.type === 'text' && o.author === 'ai')
    if (text) {
      await win.click('[data-testid="tool-text"]')
      const s = await surface()
      await win.mouse.click(s.x + (text.x + 8) * s.k, s.y + (text.y + text.fontSize * 0.6) * s.k)
      await win.waitForSelector('textarea')
      await win.keyboard.press('End')
      await win.keyboard.type(' ✓')
      await win.click('[data-testid="tool-pen"]')
      // The edit commits when the text box closes; wait for it to reach the page.
      let edited
      for (let i = 0; i < 50 && !edited?.text.endsWith(' ✓'); i++) {
        await sleep(100)
        edited = (await objects()).find((o) => o.id === text.id)
      }
      assert.ok(edited?.text.endsWith(' ✓'), `the AI correction is editable (text is now “${edited?.text}”)`)
      log(`Edited the AI note “${text.text}” with the text tool.`)
    } else log('The proposal had no text note to edit.')
  }
  await writeFile(join(shots, `live-app-${slug}.md`), `# Live app workflow: ${model}\n\n${new Date().toISOString()}\n\n${notes.join('\n')}\n`)
  console.log(`\nLive app workflow (${model}): done — test-results/live-app-${slug}.md`)
} catch (err) {
  console.error('\nLive app workflow FAILED:', err)
  await win?.screenshot({ path: join(shots, `live-app-${slug}-failure.png`) }).catch(() => undefined)
  await writeFile(join(shots, `live-app-${slug}.md`), `# Live app workflow: ${model}\n\nFAILED: ${err}\n\n${notes.join('\n')}\n`).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
