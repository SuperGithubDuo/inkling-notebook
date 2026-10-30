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
import { electronPath } from '../support/electronPath.mjs'
import { pdfjsDataDir } from '../support/pdfjsData.mjs'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'inkling-e2e3-'))
const scratch = await mkdtemp(join(tmpdir(), 'inkling-e2e3-files-'))
const env = { ...process.env, INKLING_SKIP_WELCOME: '1', INKLING_DATA_DIR: dataDir, INKLING_TEST_HOOKS: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app, win
const cspViolations = []
async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
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
  await editor().press('ControlOrMeta+End')
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
// The editor takes focus on the next animation frame; type only once the caret is in the first cell.
await win.waitForFunction(() => {
  const a = document.activeElement
  const n = window.getSelection()?.anchorNode
  const el = n && (n.nodeType === 1 ? n : n.parentElement)
  return !!a?.classList.contains('ProseMirror') && !!el?.closest('th, td')
})
await win.keyboard.type('x')
await win.keyboard.press('Tab')
await win.keyboard.type('f(x)')
// Link via Ctrl+K on a selection, after the table
await caretToEnd()
await win.keyboard.type('Reference')
await win.keyboard.down('Shift')
for (let i = 0; i < 'Reference'.length; i++) await win.keyboard.press('ArrowLeft')
await win.keyboard.up('Shift')
await win.keyboard.press('ControlOrMeta+k')
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
const lastBlock = note.doc.content.at(-1)
assert.equal(lastBlock.type, 'paragraph', 'Ctrl+End leaves the table: the link is in a paragraph after it')
assert.equal(lastBlock.content[0].text, 'Reference')
assert.deepEqual(find(find(note.doc, 'table')[0], 'text').map((t) => t.text), ['x', 'f(x)'], 'nothing typed into the table by mistake')
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
await editor().press('ControlOrMeta+z')
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


// ===================================================================== knowledge graph
// A note in another notebook that links back, for a cross-notebook cluster.
await win.locator('[data-testid="notebook-item"]', { hasText: 'Physics' }).locator('button').first().click()
await win.click('[data-testid="add-note"]')
await win.waitForSelector('[data-testid="note-view"]')
await win.click('[data-testid="note-title"]')
await win.keyboard.type('Projectile motion')
await win.keyboard.press('Enter')
await win.keyboard.type('Height is a quadratic in time, see [[')
await win.waitForSelector('[data-testid="page-picker-input"]')
await win.keyboard.type('factoring')
await win.keyboard.press('Enter')
await waitSaved()

await win.getByRole('button', { name: 'Graph', exact: true }).click()
await win.waitForSelector('[data-testid="graph-node"]')
const lib3 = await lib()
const livePageCount = lib3.notebooks.filter((n) => !n.deletedAt).flatMap((n) => n.pages.filter((p) => !p.deletedAt)).length
assert.equal(await win.locator('[data-testid="graph-node"]').count(), livePageCount, 'every live page is a node')
assert.equal(await win.locator('[data-testid="graph-edge"]').count(), 3, 'three real links')
assert.equal(await win.locator('[data-testid="graph-cluster"]').count(), 1, 'one linked cluster')
assert.match(await win.locator('[data-testid="graph-summary"]').textContent(), /3 links/)
await win.screenshot({ path: join(shots, 'p3-05-graph.png') })
step(`graph shows ${livePageCount} pages and the 3 real links as one cluster`)

const quadNode = win.locator('[data-testid="graph-node"][aria-label^="Quadratics by factoring"]')
await quadNode.click()
await win.waitForSelector('[data-testid="graph-selection"]')
assert.equal(await win.locator('[data-testid="graph-selection-title"]').textContent(), 'Quadratics by factoring')
assert.match(await win.locator('[data-testid="graph-selection"]').textContent(), /Connected · 2/)
const dimmed = await win.locator('[data-testid="graph-node"][opacity="0.25"]').count()
assert.equal(dimmed, livePageCount - 3, 'unrelated nodes are dimmed')
step('selecting a node highlights it and its connected notes')

const zoomBefore = await win.locator('[data-testid="graph-zoom"]').textContent()
await win.getByRole('button', { name: 'Zoom in' }).click()
assert.notEqual(await win.locator('[data-testid="graph-zoom"]').textContent(), zoomBefore)
const tBefore = await win.locator('[data-testid="graph-viewport"]').getAttribute('transform')
const gbox = await win.locator('svg[aria-label="Knowledge graph"]').boundingBox()
await win.mouse.move(gbox.x + 30, gbox.y + gbox.height - 60)
await win.mouse.down()
await win.mouse.move(gbox.x + 130, gbox.y + gbox.height - 20, { steps: 5 })
await win.mouse.up()
assert.notEqual(await win.locator('[data-testid="graph-viewport"]').getAttribute('transform'), tBefore)
await win.getByRole('button', { name: 'Fit graph' }).click()
step('zoom and pan the graph')

await win.click('[data-testid="graph-filter"]')
await win.getByRole('menuitem', { name: 'Math Notes', exact: true }).click()
await sleep(300)
const mathNodes = lib3.notebooks.find((n) => n.name === 'Math Notes').pages.filter((p) => !p.deletedAt).length
assert.equal(await win.locator('[data-testid="graph-node"]').count(), mathNodes)
assert.equal(await win.locator('[data-testid="graph-edge"]').count(), 2, 'only links within Math Notes')
await win.click('[data-testid="graph-filter"]')
await win.getByRole('menuitem', { name: 'All notebooks', exact: true }).click()
await win.getByLabel('Unlinked pages').uncheck()
await sleep(300)
assert.equal(await win.locator('[data-testid="graph-node"]').count(), 4, 'only linked pages')
step('filter the graph by notebook and hide unlinked pages')

await win.locator('[data-testid="graph-node"][aria-label^="Projectile motion"]').dblclick()
await win.waitForFunction(() => document.querySelector('[data-testid="note-title"]')?.value === 'Projectile motion')
assert.equal(await win.locator('[data-testid="notebook-title"]').textContent(), 'Physics')
step('double-clicking a node opens the note in its notebook')


// ===================================================================== PDF
const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createHash } = await import('node:crypto')
const sha = (b) => createHash('sha256').update(b).digest('hex')

const srcDoc = await PDFDocument.create()
const helv = await srcDoc.embedFont(StandardFonts.Helvetica)
const pg1 = srcDoc.addPage([595.28, 841.89])
pg1.drawText("Newton's second law: F = ma", { x: 72, y: 760, size: 20, font: helv })
pg1.drawRectangle({ x: 72, y: 600, width: 200, height: 100, borderColor: rgb(0.1, 0.2, 0.6), borderWidth: 2 })
const pg2 = srcDoc.addPage([595.28, 841.89])
pg2.drawText('Momentum: p = mv', { x: 72, y: 760, size: 20, font: helv })
const srcPath = join(scratch, 'Mechanics handout.pdf')
const srcBytes = await srcDoc.save()
await writeFile(srcPath, srcBytes)

await stubOpen(srcPath)
const thumbsBefore = await win.locator('[data-testid="page-thumb"]').count()
await win.click('[data-testid="import-menu"]')
await win.getByRole('menuitem', { name: 'PDF…' }).click()
await win.waitForFunction((n) => document.querySelectorAll('[data-testid="page-thumb"]').length === n + 2, thumbsBefore)
await win.waitForSelector('[data-testid="pdf-layer"][data-render-scale]')
const inked = await win.evaluate(() => {
  const c = document.querySelector('[data-testid="pdf-layer"]')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let dark = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 160) dark++
  return dark
})
assert.ok(inked > 200, `PDF content is drawn (${inked} dark pixels)`)
await waitSaved()
let physics = await notebook('Physics')
const pdfMetas = physics.pages.filter((p) => p.title.startsWith('Mechanics handout'))
assert.deepEqual(pdfMetas.map((p) => p.title), ['Mechanics handout · p. 1', 'Mechanics handout · p. 2'])
const pdfPagePath = join(dataDir, 'notebooks', physics.id, 'pages', `${pdfMetas[0].id}.json`)
let pdfPage = JSON.parse(await readFile(pdfPagePath, 'utf8'))
assert.equal(pdfPage.schemaVersion, 3)
assert.equal(pdfPage.background.type, 'pdf')
assert.equal(pdfPage.background.page, 0)
assert.ok(Math.abs(pdfPage.background.width - 595.28) < 0.01)
assert.match(pdfPage.background.text, /Newton's second law/)
const storedPdf = join(dataDir, 'notebooks', physics.id, 'assets', pdfPage.background.asset)
assert.equal(sha(await readFile(storedPdf)), sha(srcBytes), 'original PDF stored unchanged')
assert.equal(await win.locator('[data-testid="page-thumb"][aria-current="page"] [data-testid="pdf-thumb"]').count(), 1)
await win.screenshot({ path: join(shots, 'p3-06-pdf.png') })
step('imported a 2-page PDF: rendered live, text extracted, original kept unchanged')

// Annotate with the existing tools.
async function drawOnPage(pts) {
  const b = await win.locator('[data-testid="page-surface"]').boundingBox()
  const k = b.width / pdfPage.width
  const [first, ...rest] = pts
  await win.mouse.move(b.x + first[0] * k, b.y + first[1] * k)
  await win.mouse.down()
  for (const [x, y] of rest) await win.mouse.move(b.x + x * k, b.y + y * k, { steps: 6 })
  await win.mouse.up()
}
await win.click('[data-testid="tool-pen"]')
await win.click('[data-testid="color-#e5484d"]')
await drawOnPage([[150, 200], [400, 240], [700, 190]])
await win.click('[data-testid="tool-highlighter"]')
await drawOnPage([[150, 165], [760, 165]])
await win.click('[data-testid="tool-shape"]')
await drawOnPage([[140, 470], [620, 720]])
await win.click('[data-testid="tool-text"]')
const sb = await win.locator('[data-testid="page-surface"]').boundingBox()
await win.mouse.click(sb.x + 160 * (sb.width / pdfPage.width), sb.y + 820 * (sb.width / pdfPage.width))
await win.waitForSelector('[data-testid="text-editor"]')
await win.keyboard.type('Check units: N = kg·m/s²')
await win.keyboard.press('Escape')
await waitSaved()
pdfPage = JSON.parse(await readFile(pdfPagePath, 'utf8'))
assert.deepEqual(pdfPage.objects.map((o) => o.tool ?? o.kind ?? o.type), ['pen', 'highlighter', 'rect', 'text'])
const firstPoint = pdfPage.objects[0].points[0]
assert.ok(Math.hypot(firstPoint[0] - 150, firstPoint[1] - 200) < 1.5, 'ink lands where drawn on the PDF')
step('wrote, highlighted, drew a shape and typed text over the PDF page')

// Zoom in: the PDF re-renders sharper and stays aligned with the page.
const scale0 = Number(await win.locator('[data-testid="pdf-layer"]').getAttribute('data-render-scale'))
const vp = await win.locator('[data-testid="canvas-viewport"]').boundingBox()
await win.mouse.move(vp.x + 300, vp.y + 250)
await win.keyboard.down('Control')
for (let i = 0; i < 4; i++) await win.mouse.wheel(0, -120)
await win.keyboard.up('Control')
await win.waitForFunction((s0) => Number(document.querySelector('[data-testid="pdf-layer"]')?.dataset.renderScale) > s0 * 1.5, scale0)
await sleep(200)
const surf = await win.locator('[data-testid="page-surface"]').boundingBox()
const layer = await win.locator('[data-testid="pdf-layer"]').boundingBox()
const layerScale = Number(await win.locator('[data-testid="pdf-layer"]').getAttribute('data-render-scale'))
assert.ok(layerScale > scale0 * 1.5, `re-rendered at ${layerScale} (was ${scale0})`)
// The rendered region is either the whole page or the visible part of it; either way it is on the page.
assert.ok(layer.x >= surf.x - 1 && layer.y >= surf.y - 1 && layer.x + layer.width <= surf.x + surf.width + 1, 'PDF layer aligned with the page')
if (layer.width >= surf.width - 1) assert.ok(Math.abs(layer.x - surf.x) < 1 && Math.abs(layer.y - surf.y) < 1)
const before = JSON.stringify(pdfPage.objects)
await sleep(700)
assert.equal(JSON.stringify(JSON.parse(await readFile(pdfPagePath, 'utf8')).objects), before, 'zooming does not move annotations')
await win.screenshot({ path: join(shots, 'p3-07-pdf-zoomed.png') })
await win.keyboard.press('ControlOrMeta+0')
step(`zoomed in: PDF re-rendered at ${(layerScale / scale0).toFixed(1)}× resolution, annotations unchanged`)

results = await search('momentum')
assert.equal(await results.count(), 1)
assert.equal(await results.first().locator('[data-testid="result-title"]').textContent(), 'Mechanics handout · p. 2')
await win.keyboard.press('Enter')
await win.waitForFunction((id) => document.querySelector('[data-testid="page-thumb"][aria-current="page"]')?.getAttribute('aria-label')?.includes('p. 2'), null)
step('PDF text is searchable and opens the right page')

await app.close()
await launch()
await win.locator('[data-testid="notebook-item"]', { hasText: 'Physics' }).locator('button').first().click()
await win.locator('[data-testid="page-thumb"][aria-label$="Mechanics handout · p. 1"]').click()
await win.waitForSelector('[data-testid="pdf-layer"][data-render-scale]')
assert.equal(JSON.stringify(JSON.parse(await readFile(pdfPagePath, 'utf8')).objects), before)
step('PDF page and its annotations reopen intact after a restart')

// Export the notebook as an annotated PDF.
const outPath = join(scratch, 'Physics annotated.pdf')
await stubSave(outPath)
await win.click('[data-testid="more-menu-canvas"]')
await win.getByRole('menuitem', { name: /Export notebook as PDF/ }).click()
await win.waitForSelector('[role="alert"]:has-text("Exported to")', { timeout: 20000 })
const exported = await readFile(outPath)
const outDoc = await PDFDocument.load(exported)
physics = await notebook('Physics')
const canvasPages = physics.pages.filter((p) => !p.deletedAt && p.kind === 'canvas').length
assert.equal(outDoc.getPageCount(), canvasPages)
const exportedPdfPageIdx = physics.pages.filter((p) => !p.deletedAt && p.kind === 'canvas').findIndex((p) => p.id === pdfMetas[0].id)
assert.deepEqual(outDoc.getPage(exportedPdfPageIdx).getSize(), { width: 595.28, height: 841.89 })
const pdfjsDoc = await getDocument({ data: new Uint8Array(exported), standardFontDataUrl: pdfjsDataDir('standard_fonts') }).promise
const exportedPage = await pdfjsDoc.getPage(exportedPdfPageIdx + 1)
const exportedText = (await exportedPage.getTextContent()).items.map((i) => i.str).join(' ')
assert.match(exportedText, /Newton's second law/, 'original PDF text kept as text')
assert.match(exportedText, /Check units/, 'text annotation exported as text')
const ops = await exportedPage.getOperatorList()
const originalOps = await (await (await getDocument({ data: new Uint8Array(srcBytes), standardFontDataUrl: pdfjsDataDir('standard_fonts') }).promise).getPage(1)).getOperatorList()
assert.ok(ops.fnArray.length > originalOps.fnArray.length + 5, 'annotations added as vector drawing operations')
assert.equal(sha(await readFile(storedPdf)), sha(srcBytes), 'stored original still unchanged after export')
step(`exported an annotated ${outDoc.getPageCount()}-page PDF: original content preserved, annotations as vectors and text`)


// ===================================================================== assistant context (AI readiness)
await win.waitForFunction(() => window.__inkling?.notebookContext)
const ctxPage = await win.evaluate((id) => window.__inkling.notebookContext.page(id), pdfMetas[0].id)
assert.equal(ctxPage.kind, 'canvas')
assert.match(ctxPage.pdfText, /Newton's second law/)
assert.deepEqual(ctxPage.textBoxes, ['Check units: N = kg·m/s²'])
const ctxNote = await win.evaluate(() => {
  const ref = window.__inkling.notebookContext.outline().find((p) => p.title === 'Projectile motion')
  return window.__inkling.notebookContext.page(ref.pageId)
})
assert.match(ctxNote.markdown, /\[Quadratics by factoring\]\(inkling:\/\/page\//, 'notes come back as Markdown with live link titles')
const ctxSearch = await win.evaluate(() => window.__inkling.notebookContext.search('momentum'))
assert.equal(ctxSearch[0].page.title, 'Mechanics handout · p. 2')

// Lasso the handwriting over the PDF and read it as the assistant would.
await win.click('[data-testid="tool-lasso"]')
await drawOnPage([[120, 140], [800, 140], [800, 260], [120, 260], [120, 142]])
await win.waitForSelector('[data-testid="selection-toolbar"]')
const sel = await win.evaluate(async () => {
  const c = await window.__inkling.notebookContext.selection()
  const img = new Image()
  img.src = c.image
  await img.decode()
  const cv = document.createElement('canvas')
  cv.width = img.width
  cv.height = img.height
  const g = cv.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, cv.width, cv.height).data
  let dark = 0
  let red = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++
    if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 120) red++
  }
  return { types: c.objects.map((o) => o.tool ?? o.type), width: img.width, dark, red }
})
assert.deepEqual(sel.types.sort(), ['highlighter', 'pen'])
assert.ok(sel.dark > 50, 'selection image includes the PDF text underneath')
assert.ok(sel.red > 50, 'selection image includes the red ink')
await win.keyboard.press('Escape')
step('assistant context: page text, PDF text, Markdown, search and an image of the selected handwriting')

const userStroke = (await JSON.parse(await readFile(pdfPagePath, 'utf8'))).objects[0].id
const refused = await win.evaluate(([pageId, id]) => window.__inkling.notebookContext.applyCanvasCommands(pageId, [{ type: 'deleteObjects', ids: [id] }]), [pdfMetas[0].id, userStroke])
assert.equal(refused.ok, false)
assert.match(refused.error, /permission/)
const applied = await win.evaluate(
  (pageId) =>
    window.__inkling.notebookContext.applyCanvasCommands(pageId, [
      { type: 'createShape', shape: { kind: 'ellipse', x: 140, y: 120, width: 640, height: 90, color: '#6d63f0', strokeWidth: 3 } },
      { type: 'createText', text: { x: 820, y: 140, width: 320, text: 'Units check out ✓', color: '#6d63f0', font: 'hand' } }
    ], { label: 'AI correction' }),
  pdfMetas[0].id
)
assert.equal(applied.ok, true)
await waitSaved()
const aiObjects = JSON.parse(await readFile(pdfPagePath, 'utf8')).objects.filter((o) => o.author === 'ai')
assert.equal(aiObjects.length, 2, 'AI content is saved and tagged as AI-authored')
await win.keyboard.press('ControlOrMeta+z')
await waitSaved()
assert.equal(JSON.parse(await readFile(pdfPagePath, 'utf8')).objects.filter((o) => o.author === 'ai').length, 0, 'one undo removes the whole AI edit')
step('assistant edits go through typed commands: tagged as AI, one undo step, user ink protected')

await app.close()
assert.deepEqual(cspViolations, [], 'no Content Security Policy violations')
console.log(`\nPhase 3 acceptance: PASS  (data: ${dataDir})`)
