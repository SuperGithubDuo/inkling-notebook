/**
 * Phase 3 acceptance test, driven through the real Electron app.
 * Sections run in order and share one data folder:
 *   notes     – create, format and edit a rich-text note; restart; Markdown import/export
 *   search    – universal search, links, backlinks, renames         (added with that milestone)
 *   graph     – knowledge graph navigation                          (added with that milestone)
 *   pdf       – PDF import, annotation, reopen, export              (added with that milestone)
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/phase3.e2e.mjs
 */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e3-'))
const scratch = await mkdtemp(join(tmpdir(), 'inkling-e2e3-files-'))
const env = { ...process.env, INKLING_DATA_DIR: dataDir }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app, win
async function launch() {
  app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', root], env })
  win = await app.firstWindow()
  win.on('pageerror', (e) => console.error('PAGE ERROR', e))
  win.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()))
  await win.setViewportSize({ width: 1536, height: 960 })
  await win.waitForSelector('[data-testid="page-surface"], [data-testid="note-view"]')
  await sleep(300)
}
const lib = async () => JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
const notebook = async (name) => (await lib()).notebooks.find((n) => n.name === name)
const noteFile = (nbId, pageId) => join(dataDir, 'notebooks', nbId, 'notes', `${pageId}.json`)
const waitSaved = async () => {
  await sleep(200)
  await win.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 6000 })
}
const stubOpen = (path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, path)
const stubSave = (path) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, path)
const find = (n, type) => [...(n.type === type ? [n] : []), ...(n.content ?? []).flatMap((c) => find(c, type))]
const editor = () => win.locator('[data-testid="note-editor"]')
/** Moves the caret to the end of the note. The editor learns about caret moves
 * from an asynchronous browser event, so pause briefly like a person would. */
const caretToEnd = async () => {
  await editor().press('Control+End')
  await sleep(60)
}


// ===================================================================== notes
await launch()
await win.click('[data-testid="add-note"]')
await win.waitForSelector('[data-testid="note-view"]')
await win.click('[data-testid="note-title"]')
await win.keyboard.type('Quadratic equations')
await win.keyboard.press('Enter') // moves into the body
await win.keyboard.type('Factoring method')
await win.click('[data-testid="text-style"]')
await win.getByRole('menuitem', { name: /^Heading 2/ }).click()
await win.keyboard.press('End')
await win.keyboard.press('Enter')
await win.keyboard.type('Always ')
await win.click('[data-testid="fmt-bold"]')
await win.keyboard.type('check the signs')
await win.click('[data-testid="fmt-bold"]')
await win.keyboard.type(' of each root.')
await win.keyboard.press('Enter')
// Markdown-style shortcuts while typing
await win.keyboard.type('- set each factor to zero')
await win.keyboard.press('Enter')
await win.keyboard.type('solve each one')
await win.keyboard.press('Enter')
await win.keyboard.press('Enter') // leave the list
await win.click('[data-testid="fmt-task"]')
await win.keyboard.type('practise five problems')
await win.keyboard.press('Enter')
await win.keyboard.press('Enter')
// Formula through the dialog, with live KaTeX preview
await win.keyboard.type('Roots: ')
await win.click('[data-testid="fmt-math"]')
await win.getByRole('menuitem', { name: /^Inline formula/ }).click()
await win.fill('[data-testid="math-input"]', 'x = -2 \\text{ or } x = -3')
assert.ok(await win.locator('[role="dialog"] .katex').count(), 'KaTeX preview renders')
await win.click('[data-testid="math-apply"]')
await win.keyboard.press('End')
await win.keyboard.press('Enter')
// Table
await win.click('[data-testid="fmt-table"]')
await win.getByRole('menuitem', { name: /Insert 3 × 3 table/ }).click()
await win.keyboard.type('x')
await win.keyboard.press('Tab')
await win.keyboard.type('f(x)')
// Link via Ctrl+K on a selection, after the table
await caretToEnd()
await win.keyboard.type('Reference')
await win.keyboard.down('Shift')
for (let i = 0; i < 'Reference'.length; i++) await win.keyboard.press('ArrowLeft')
await win.keyboard.up('Shift')
await win.keyboard.press('Control+k')
await win.fill('[data-testid="link-input"]', 'example.com/quadratics')
await win.keyboard.press('Enter')
// Tags
await win.click('[data-testid="tag-input"]')
await win.keyboard.type('algebra')
await win.keyboard.press('Enter')
await win.keyboard.type('exam, homework')
await win.keyboard.press('Enter')
await waitSaved()
await win.screenshot({ path: join(shots, 'p3-01-note.png') })

let nb = await notebook('Math Notes')
const noteMeta = nb.pages.find((p) => p.kind === 'note')
assert.equal(noteMeta.title, 'Quadratic equations')
assert.deepEqual(noteMeta.tags, ['algebra', 'exam', 'homework'])
let note = JSON.parse(await readFile(noteFile(nb.id, noteMeta.id), 'utf8'))
assert.equal(note.schemaVersion, 1)
assert.equal(find(note.doc, 'heading')[0].content[0].text, 'Factoring method')
assert.ok(find(note.doc, 'text').some((t) => t.text === 'check the signs' && t.marks?.some((m) => m.type === 'bold')))
assert.equal(find(note.doc, 'bulletList')[0].content.length, 2)
assert.equal(find(note.doc, 'taskItem').length, 1)
assert.equal(find(note.doc, 'inlineMath')[0].attrs.latex, 'x = -2 \\text{ or } x = -3')
assert.equal(find(note.doc, 'table').length, 1)
assert.ok(find(note.doc, 'text').some((t) => t.marks?.some((m) => m.type === 'link' && m.attrs.href === 'https://example.com/quadratics')))
step('created a note with heading, bold, lists, checklist, formula, table, link and tags')

// Check the box, edit a formula by clicking it, then undo/redo inside the editor.
await win.locator('[data-testid="note-editor"] ul[data-type="taskList"] input[type="checkbox"]').check()
await win.locator('[data-testid="note-editor"] [data-type="inline-math"] .katex-html').click()
await win.fill('[data-testid="math-input"]', 'x \\in \\{-2, -3\\}')
await win.click('[data-testid="math-apply"]')
await waitSaved()
note = JSON.parse(await readFile(noteFile(nb.id, noteMeta.id), 'utf8'))
assert.equal(find(note.doc, 'taskItem')[0].attrs.checked, true)
assert.equal(find(note.doc, 'inlineMath')[0].attrs.latex, 'x \\in \\{-2, -3\\}')
await editor().press('Control+z')
await waitSaved()
note = JSON.parse(await readFile(noteFile(nb.id, noteMeta.id), 'utf8'))
assert.equal(find(note.doc, 'inlineMath')[0].attrs.latex, 'x = -2 \\text{ or } x = -3', 'undo restores the formula')
step('checked a task, edited a formula in place, undo restores it')

const thumbs = win.locator('[data-testid="page-thumb"][data-kind="note"]')
assert.equal(await thumbs.count(), 1)
assert.match(await thumbs.textContent(), /Quadratic equations/)
step('note appears in the page navigator with a text preview')

const beforeRestart = note
await app.close()
await launch()
await win.waitForSelector('[data-testid="note-view"]') // reopens the last-open page: the note
assert.equal(await win.inputValue('[data-testid="note-title"]'), 'Quadratic equations')
await win.waitForSelector('[data-testid="note-editor"] table')
assert.ok(await win.locator('[data-testid="note-editor"] .katex').count(), 'formula renders after restart')
note = JSON.parse(await readFile(noteFile(nb.id, noteMeta.id), 'utf8'))
assert.deepEqual(note.doc, beforeRestart.doc, 'nothing changed by reopening')
assert.equal(await win.locator('[data-testid="note-toolbar"]').count(), 1, 'formatting toolbar present without typing first')
step('note reopens intact after restarting the app')

// Markdown export: images go to a sibling folder
const exportPath = join(scratch, 'quadratics.md')
await stubSave(exportPath)
await win.click('[data-testid="more-menu"]')
await win.getByRole('menuitem', { name: /Export note as Markdown/ }).click()
await sleep(500)
const md = await readFile(exportPath, 'utf8')
assert.match(md, /^# Quadratic equations/)
assert.match(md, /## Factoring method/)
assert.match(md, /\*\*check the signs\*\*/)
assert.match(md, /- \[x\] practise five problems/)
assert.match(md, /\$x = -2 \\text\{ or \} x = -3\$/)
assert.match(md, /\[Reference\]\(https:\/\/example\.com\/quadratics\)/)
assert.match(md, /\| x\s+\| f\(x\)/)
step('exported the note as Markdown')

// Markdown import with a local image next to the file
const png = await win.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 120
  c.height = 80
  c.getContext('2d').fillRect(0, 0, 120, 80)
  return c.toDataURL('image/png').split(',')[1]
})
await mkdir(join(scratch, 'img'), { recursive: true })
await writeFile(join(scratch, 'img', 'graph.png'), Buffer.from(png, 'base64'))
const importPath = join(scratch, 'Vertex form.md')
await writeFile(
  importPath,
  `# Vertex form\n\nThe vertex of $y = a(x-h)^2 + k$ is $(h, k)$.\n\n![sketch](img/graph.png)\n\n1. complete the square\n2. read off h and k\n\n$$\ny = (x-2)^2 - 3\n$$\n\n[bad](javascript:alert(1))\n`
)
await stubOpen(importPath)
await win.click('[data-testid="import-menu"]')
await win.getByRole('menuitem', { name: /Markdown file as note/ }).click()
await win.waitForFunction(() => document.querySelector('[data-testid="note-title"]')?.value === 'Vertex form')
await win.waitForSelector('[data-testid="note-editor"] img')
assert.equal(await win.locator('[data-testid="note-toolbar"]').count(), 1, 'toolbar follows the switch to another note')
const imgLoaded = await win.evaluate(async () => {
  const img = document.querySelector('[data-testid="note-editor"] img')
  await img.decode().catch(() => undefined)
  return img.naturalWidth
})
assert.equal(imgLoaded, 120, 'imported image displays from the notebook')
await waitSaved()
nb = await notebook('Math Notes')
const imported = nb.pages.find((p) => p.title === 'Vertex form')
const importedDoc = JSON.parse(await readFile(noteFile(nb.id, imported.id), 'utf8')).doc
assert.equal(find(importedDoc, 'inlineMath').length, 2)
assert.equal(find(importedDoc, 'blockMath').length, 1)
assert.equal(find(importedDoc, 'orderedList').length, 1)
assert.match(find(importedDoc, 'image')[0].attrs.src, /^inkling-asset:\/\/asset\//)
assert.ok(!JSON.stringify(importedDoc).includes('javascript:'), 'unsafe link dropped')
assert.ok((await readdir(join(dataDir, 'notebooks', nb.id, 'assets'))).length >= 1)
await win.screenshot({ path: join(shots, 'p3-02-imported.png') })
step('imported Markdown as a note, with its image copied into the notebook')

// Exporting the imported note writes the image next to the .md
const export2 = join(scratch, 'vertex.md')
await stubSave(export2)
await win.click('[data-testid="more-menu"]')
await win.getByRole('menuitem', { name: /Export note as Markdown/ }).click()
await sleep(500)
const md2 = await readFile(export2, 'utf8')
const rel = md2.match(/!\[sketch\]\(([^)]+)\)/)[1]
assert.match(rel, /^vertex_assets\//)
assert.ok((await readFile(join(scratch, decodeURI(rel)))).length > 0)
step('exported Markdown carries its images in a sibling folder')

// A handwritten page is still a handwritten page.
await win.locator('[data-testid="page-thumb"][data-kind="canvas"]').first().click()
await win.waitForSelector('[data-testid="page-surface"]')
assert.equal(await win.locator('[data-testid="tool-pen"]').count(), 1)
step('switching back to a handwritten page restores the drawing tools')


// ===================================================================== search & links
async function search(q, { filter } = {}) {
  await win.keyboard.press('Escape')
  await win.click('[data-testid="open-search"]')
  await win.waitForSelector('[data-testid="search-palette"]')
  if (filter) {
    await win.click('[data-testid="search-filter"]')
    await win.getByRole('menuitem', { name: filter, exact: true }).click()
  }
  await win.fill('[data-testid="search-input"]', q)
  await sleep(350)
  return win.locator('[data-testid="search-result"]')
}
const openNote = async (title) => {
  await win.locator(`[data-testid="page-thumb"][data-kind="note"][aria-label$=": ${title}"]`).click()
  await win.waitForFunction((t) => document.querySelector('[data-testid="note-title"]')?.value === t, title)
}

// A text box on the handwritten page (searchable), next to plain ink (not searchable).
await win.click('[data-testid="tool-text"]')
const surface = await win.locator('[data-testid="page-surface"]').boundingBox()
await win.mouse.click(surface.x + 120, surface.y + 160)
await win.waitForSelector('[data-testid="text-editor"]')
await win.keyboard.type('Discriminant decides how many roots')
await win.keyboard.press('Escape')
await waitSaved()

let results = await search('signs')
assert.equal(await results.count(), 1)
assert.equal(await results.first().locator('[data-testid="result-title"]').textContent(), 'Quadratic equations')
assert.equal(await results.first().locator('[data-testid="result-snippet"] mark').first().textContent(), 'signs')
await win.screenshot({ path: join(shots, 'p3-03-search.png') })
await win.keyboard.press('Enter')
await win.waitForFunction(() => document.querySelector('[data-testid="note-title"]')?.value === 'Quadratic equations')
step('search finds words inside notes, highlights them and opens the note')

results = await search('discriminant')
assert.equal(await results.count(), 1)
assert.match(await results.first().textContent(), /Math Notes · page 1/)
await win.keyboard.press('ArrowDown')
await win.keyboard.press('Enter')
await win.waitForSelector('[data-testid="page-surface"]')
step('search finds text boxes on handwritten pages and opens the page')

await openNote('Vertex form')
await win.click('[data-testid="tag-input"]')
await win.keyboard.type('algebra')
await win.keyboard.press('Enter')
await waitSaved()
results = await search('#algebra')
assert.equal(await results.count(), 2, 'both algebra-tagged notes')
results = await search('vertex', { filter: 'Physics' })
assert.equal(await results.count(), 0, 'notebook filter excludes Math Notes')
await win.click('[data-testid="search-filter"]')
await win.getByRole('menuitem', { name: 'Math Notes', exact: true }).click()
await sleep(300)
assert.equal(await results.count(), 1)
await win.keyboard.press('Escape')
step('tag search and notebook filter')

// Link Vertex form → Quadratic equations with [[ and the picker.
await openNote('Vertex form')
await caretToEnd()
await win.keyboard.press('Enter')
await win.keyboard.type('Compare with [[')
await win.waitForSelector('[data-testid="page-picker-input"]')
await win.keyboard.type('quadr')
await win.keyboard.press('Enter')
await win.keyboard.type('and the first page ')
await win.click('[data-testid="fmt-page-link"]')
await win.keyboard.type('page 1')
await win.keyboard.press('Enter')
await waitSaved()
assert.match(await win.locator('[data-testid="note-editor"] .note-ref').first().textContent(), /Quadratic equations/)
const linkLine = await win.locator('[data-testid="note-editor"] p', { hasText: 'Compare with' }).textContent()
assert.equal(linkLine, 'Compare with Quadratic equations and the first page Math Notes · page 1 ', 'picker queries must not leak into the note')
await win.waitForSelector('[data-testid="outgoing"] [data-testid="connection"]')
assert.equal(await win.locator('[data-testid="outgoing"] [data-testid="connection"]').count(), 2)
step('inserted links to a note ([[) and to a handwritten page (toolbar picker)')

// Backlinks appear on the target note…
await win.locator('[data-testid="note-editor"] .note-ref', { hasText: 'Quadratic equations' }).click()
await win.waitForFunction(() => document.querySelector('[data-testid="note-title"]')?.value === 'Quadratic equations')
await win.waitForSelector('[data-testid="backlinks"] [data-testid="connection"]')
assert.match(await win.locator('[data-testid="backlinks"]').textContent(), /Vertex form/)
step('clicking a link navigates; the target lists the backlink')

// …and on the handwritten page, via the pill.
await win.locator('[data-testid="page-thumb"][data-kind="canvas"]').click()
await win.waitForSelector('[data-testid="backlinks-pill"]')
assert.match(await win.locator('[data-testid="backlinks-pill"]').textContent(), /1 backlink/)
await win.click('[data-testid="backlinks-pill"]')
assert.match(await win.locator('[role="dialog"] [data-testid="backlinks"]').textContent(), /Vertex form/)
await win.keyboard.press('Escape')
step('handwritten pages show their backlinks')

// Rename the target: links follow, search follows, Markdown export uses the new title.
await openNote('Quadratic equations')
await win.fill('[data-testid="note-title"]', 'Quadratics by factoring')
await win.keyboard.press('Tab')
await waitSaved()
await openNote('Vertex form')
await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="note-editor"] .note-ref')].some((a) => a.textContent === 'Quadratics by factoring'))
results = await search('factoring')
assert.equal(await results.first().locator('[data-testid="result-title"]').textContent(), 'Quadratics by factoring')
await win.keyboard.press('Escape')
const linkExport = join(scratch, 'vertex-links.md')
await stubSave(linkExport)
await win.click('[data-testid="more-menu"]')
await win.getByRole('menuitem', { name: /Export note as Markdown/ }).click()
await sleep(400)
nb = await notebook('Math Notes')
const quadId = nb.pages.find((p) => p.title === 'Quadratics by factoring').id
assert.ok((await readFile(linkExport, 'utf8')).includes(`[Quadratics by factoring](inkling://page/${quadId})`))
step('renaming a note keeps links valid; search and Markdown export use the new title')

// Trash the linking note: its backlink disappears; restore brings it back.
await win.locator('[data-testid="page-thumb"][data-kind="note"][aria-label$=": Vertex form"]').click({ button: 'right' })
await win.getByRole('menuitem', { name: 'Delete page' }).click()
await waitSaved()
results = await search('compare with')
assert.equal(await results.count(), 0, 'trashed notes are not searchable')
await win.keyboard.press('Escape')
await openNote('Quadratics by factoring')
await sleep(400)
assert.equal(await win.locator('[data-testid="backlinks"] [data-testid="connection"]').count(), 0)
await win.getByRole('button', { name: /^Trash/ }).click()
await win.getByRole('button', { name: 'Restore' }).click()
await waitSaved()
await win.getByRole('button', { name: 'Notebooks', exact: true }).click()
await win.locator('[data-testid="notebook-item"]', { hasText: 'Math Notes' }).locator('button').first().click()
await openNote('Quadratics by factoring')
await win.waitForSelector('[data-testid="backlinks"] [data-testid="connection"]')
results = await search('compare with')
assert.equal(await results.count(), 1, 'restored note is searchable again')
await win.keyboard.press('Escape')
step('trash removes a note from search and backlinks; restore brings it back')

await app.close()
await launch()
results = await search('compare')
await win.keyboard.press('Enter')
await win.waitForFunction(() => document.querySelector('[data-testid="note-title"]')?.value === 'Vertex form')
await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="note-editor"] .note-ref')].some((a) => a.textContent === 'Quadratics by factoring'))
await win.waitForSelector('[data-testid="outgoing"] [data-testid="connection"]')
await win.screenshot({ path: join(shots, 'p3-04-links.png') })
step('after a restart the search index is rebuilt and links still resolve')

await app.close()
console.log(`\nPhase 3 acceptance: PASS  (data: ${dataDir})`)
