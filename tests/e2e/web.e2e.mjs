/**
 * Web app acceptance test, in a real browser (Chromium) against the built web
 * app, a local stand-in for Supabase (tests/support/fakeSupabase.mjs) and the
 * real AI server code with a fake model (tests/support/fakeBeta.mjs).
 *
 * Covers: use without an account (saved in the browser), stored images, working
 * offline after the first visit, sign-in with an email code, the question before
 * earlier notebooks join the account, sync between two browsers (desktop-sized
 * and phone-sized), offline edits merging without loss, version history, sign-out,
 * the AI tutor from a browser, the phone and tablet layouts, the security headers,
 * and — when the desktop app is built — the desktop app syncing with the web app.
 *
 * Usage: npm run build && xvfb-run -a node tests/e2e/web.e2e.mjs   (--web-only skips the desktop part)
 */
import { chromium, _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { startFakeSupabase } from '../support/fakeSupabase.mjs'
import { startBetaServer } from '../support/fakeBeta.mjs'

const root = resolve(import.meta.dirname, '../..')
const shots = process.env.SHOTS ?? join(root, 'test-results')
await mkdir(shots, { recursive: true })
const out = join(root, 'out/web-test')
const step = (msg) => console.log(`  ✓ ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EMAIL = 'student@example.com'
/** Served under a sub-path, as on GitHub Pages. */
const BASE = '/inkling-notebook/app/'

// ---------------------------------------------------------------- servers and build
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
const site = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (!path.startsWith(BASE)) return void res.writeHead(404).end()
  const file = join(out, path.slice(BASE.length) || 'index.html')
  if (!file.startsWith(out) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end()
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${site.address().port}`
const APP = origin + BASE
const supabase = await startFakeSupabase()
const beta = await startBetaServer({ allowedOrigins: [origin], minNoticeVersion: 0 })

execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '-c', 'vite.web.config.mts', '--logLevel', 'error'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, INKLING_WEB_OUT: 'out/web-test', VITE_SUPABASE_URL: supabase.url, VITE_SUPABASE_ANON_KEY: supabase.anonKey, VITE_INKLING_BETA_URL: beta.url }
})
step('built the web app with the test servers’ addresses')

const exe = process.env.INKLING_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
const browser = await chromium.launch(exe && statSync(exe).isFile() ? { executablePath: exe } : {})

async function open(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'allow', ...extra })
  await context.addInitScript(() => localStorage.setItem('inkling.testHooks', '1'))
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && page.errors.push(m.text()))
  await page.goto(APP)
  await ready(page)
  return page
}
const ready = async (page) => {
  await page.waitForSelector('[data-testid="page-surface"], [data-testid^="library-"]', { timeout: 30_000 })
  await sleep(400)
}

/** Draws one pen stroke on the page with the mouse. */
async function draw(page, from, to) {
  const box = await page.locator('[data-testid="page-surface"]').boundingBox()
  const at = ([x, y]) => [box.x + box.width * x, box.y + box.height * y]
  const [a, b] = [at(from), at(to)]
  await page.mouse.move(...a)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8)
  await page.mouse.up()
}
const saved = (page) => page.waitForSelector('[data-testid="save-status"][data-state="saved"]')
const synced = (page) => page.waitForSelector('[data-testid="save-status"][data-state="saved"][data-sync="synced"]', { timeout: 20_000 })

/** Everything stored in this browser for whoever is using it (read straight from IndexedDB). */
const stored = (page) =>
  page.evaluate(async () => {
    const who = JSON.parse(localStorage.getItem('inkling.account') ?? 'null')
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(who ? `inkling-u-${who.id}` : 'inkling-guest')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = (store, fn) => new Promise((res) => (db.transaction(store).objectStore(store)[fn]().onsuccess = (e) => res(e.target.result)))
    const [keys, values] = [await all('docs', 'getAllKeys'), await all('docs', 'getAll')]
    db.close()
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]))
  })
/** Stroke count of the first used notebook's first page. */
async function strokes(page, notebookName = 'Math Notes') {
  const docs = await stored(page)
  const nb = docs.library.notebooks.find((n) => n.name === notebookName)
  const doc = nb && docs[`page/${nb.id}/${nb.pages[0].id}`]
  return doc ? doc.objects.filter((o) => o.type === 'stroke').length : -1
}
/** Strokes on the page that is open, as the app has it in memory (what the user sees). */
const shown = (page) =>
  page.evaluate(async () => {
    const id = document.querySelector('[data-testid="page-surface"]').dataset.pageId
    return (await window.__inkling.notebookContext.page(id)).objects.filter((o) => o.type === 'stroke').length
  })
const syncNow = (page) => page.evaluate(() => window.inkling.account.syncNow())

async function signIn(page, email = EMAIL) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByTestId('sign-in-email').fill(email)
  await page.getByTestId('sign-in-email-send').click()
  await page.getByTestId('sign-in-code').fill('123456')
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Sign in', exact: true }).click()])
  await ready(page)
}

try {
  // ---------------------------------------------------------------- without an account
  const a = await open({ width: 1440, height: 900 })
  assert.equal(await a.evaluate(() => window.inkling.platform), 'web')
  await draw(a, [0.2, 0.2], [0.5, 0.3])
  await draw(a, [0.2, 0.4], [0.5, 0.5])
  await saved(a)
  assert.equal(await strokes(a), 2)
  assert.equal(supabase.requests.length, 0, 'nothing is sent anywhere before signing in')
  step('writes by hand without an account; saved in the browser, nothing sent')

  // A picture, stored in the browser and served to the page by the service worker.
  const [chooser] = await Promise.all([a.waitForEvent('filechooser'), a.getByRole('button', { name: /^Insert image/ }).click()])
  await chooser.setFiles(join(root, 'tests/fixtures/handwriting-linear.png'))
  await a.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.dataset.state === 'saved')
  await sleep(600)
  await saved(a)
  const asset = await a.evaluate(async () => {
    const { library } = await window.inkling.loadLibrary()
    const nb = library.notebooks[0]
    const image = (await window.inkling.loadPage(nb.id, nb.pages[0].id)).page.objects.find((o) => o.type === 'image')
    const res = await fetch(`asset/${nb.id}/${image.asset}`)
    return { asset: image.asset, nb: nb.id, status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength }
  })
  assert.equal(asset.status, 200, JSON.stringify(asset))
  assert.equal(asset.type, 'image/png')
  assert.ok(asset.bytes > 1000)
  assert.equal(await a.evaluate(() => fetch('asset/notebook-x/evil.html').then((r) => r.status)), 404, 'only image and PDF names are served')
  step('stores a picture in the browser and shows it from there')

  await a.reload()
  await ready(a)
  assert.equal(await a.locator('[data-testid="page-surface"]').count(), 1)
  assert.equal(await strokes(a), 2)
  step('reopens with the same notebook and ink after a reload')

  // A second tab on the same notebooks waits instead of saving over the first.
  const second = await a.context().newPage()
  await second.goto(APP)
  await second.getByText('already open in another tab').waitFor()
  await second.close()
  step('a second tab does not open the same notebooks at once')

  // ---------------------------------------------------------------- offline (PWA)
  const manifest = await a.evaluate(() => fetch(document.querySelector('link[rel=manifest]').href).then((r) => r.json()))
  assert.equal(manifest.display, 'standalone')
  for (const icon of manifest.icons) assert.equal(await a.evaluate((src) => fetch(src).then((r) => r.status), icon.src), 200, icon.src)
  assert.ok(await a.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page')
  await a.context().setOffline(true)
  await a.reload()
  await ready(a)
  await draw(a, [0.2, 0.6], [0.5, 0.7])
  await saved(a)
  assert.equal(await strokes(a), 3)
  assert.equal(await a.evaluate((p) => fetch(p).then((r) => r.status), `asset/${asset.nb}/${asset.asset}`), 200)
  await a.getByRole('button', { name: 'Search', exact: false }).first().click().catch(() => undefined)
  await a.keyboard.press('Escape')
  await a.screenshot({ path: join(shots, 'web-offline.png') })
  await a.context().setOffline(false)
  step('installable (manifest, icons, service worker); loads and edits with no network')

  // ---------------------------------------------------------------- sign in; earlier notebooks need a yes
  await signIn(a)
  await a.waitForSelector('[data-testid="migration-dialog"]')
  assert.equal(supabase.docsOf(EMAIL).size, 0, 'nothing joins the account before the user agrees')
  assert.match(await a.getByTestId('migration-dialog').innerText(), /1 notebook/)
  await a.screenshot({ path: join(shots, 'web-migration.png') })
  await Promise.all([a.waitForEvent('load'), a.getByTestId('migration-accept').click()])
  await ready(a)
  assert.equal(await a.locator('[data-testid="migration-dialog"]').count(), 0)
  assert.equal(await shown(a), 3, 'the notebook that was open is open again, with its ink')
  await syncNow(a)
  await synced(a)
  const cloud = supabase.docsOf(EMAIL)
  const library = cloud.get('library').content
  const math = library.notebooks.find((n) => n.name === 'Math Notes')
  assert.equal(cloud.get(`page/${math.id}/${math.pages[0].id}`).content.objects.length, 4, 'three strokes and the picture')
  assert.ok([...supabase.assets.keys()].some((k) => k === `${supabase.uidOf(EMAIL)}/${asset.nb}/${asset.asset}`), 'the picture was uploaded under the user’s own folder')
  assert.equal(await strokes(a), 3)
  assert.equal(await a.evaluate(() => indexedDB.databases().then((d) => d.some((x) => x.name === 'inkling-guest'))), false, 'the guest copy is gone only after it was moved')
  step('signs in with an email code; earlier notebooks join the account only after confirming')

  // ---------------------------------------------------------------- a second device: a phone
  const b = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true })
  await signIn(b)
  assert.equal(await b.locator('[data-testid="migration-dialog"]').count(), 0, 'an unused browser has nothing to ask about')
  await synced(b)
  assert.equal(await strokes(b), 3)
  assert.equal(await b.evaluate((p) => fetch(p).then((r) => r.status), `asset/${asset.nb}/${asset.asset}`), 200, 'the picture came down too')
  const names = (await stored(b)).library.notebooks.map((n) => n.name)
  assert.equal(names.filter((n) => n === 'Math Notes').length, 1, `no duplicate starter notebooks: ${names}`)
  step('a second browser signs in and gets the notebooks, ink and picture')

  // Phone layout: nothing wider than the screen; panels are drawers.
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling on a phone')
  assert.equal(await b.locator('aside[aria-label="Library"]').count(), 0)
  await b.getByRole('button', { name: 'Toggle sidebar' }).click()
  await b.waitForSelector('aside[aria-label="Library"]')
  await b.screenshot({ path: join(shots, 'web-phone-sidebar.png') })
  await b.getByRole('button', { name: 'Close panel' }).click()
  assert.equal(await b.locator('aside[aria-label="Library"]').count(), 0)
  await b.getByTestId('toggle-tutor').click()
  const tutor = await b.getByTestId('tutor-panel').boundingBox()
  assert.ok(tutor.width >= 389 && tutor.x <= 1, 'the tutor fills the phone screen')
  await b.getByRole('button', { name: 'Close AI Tutor' }).click()
  await b.screenshot({ path: join(shots, 'web-phone.png') })
  step('phone layout: fits the screen, sidebar and tutor open as overlays')

  // Finger input draws on a phone.
  const surface = await b.locator('[data-testid="page-surface"]').boundingBox()
  const cdp = await b.context().newCDPSession(b)
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  await touch('touchStart', surface.x + 60, surface.y + 300)
  for (let i = 1; i <= 6; i++) await touch('touchMove', surface.x + 60 + i * 20, surface.y + 300 + i * 6)
  await touch('touchEnd')
  await saved(b)
  assert.equal(await strokes(b), 4)
  step('writes with a finger on the phone')

  // ---------------------------------------------------------------- live sync, both directions
  await syncNow(b)
  await syncNow(a)
  await a.waitForFunction(() => true)
  await sleep(300)
  assert.equal(await strokes(a), 4)
  assert.equal(await shown(a), 4, 'the open page shows it')
  step('the phone’s ink appears on the first device (open page updated without a reload)')

  // ---------------------------------------------------------------- offline edits on both, then merge
  await a.context().setOffline(true)
  await draw(a, [0.6, 0.2], [0.8, 0.25])
  await saved(a)
  await a.waitForSelector('[data-testid="save-status"][data-sync="offline"]', { timeout: 20_000 })
  await touch('touchStart', surface.x + 60, surface.y + 420)
  for (let i = 1; i <= 6; i++) await touch('touchMove', surface.x + 60 + i * 20, surface.y + 420)
  await touch('touchEnd')
  await saved(b)
  await syncNow(b)
  await a.context().setOffline(false)
  await syncNow(a)
  await synced(a)
  await syncNow(b)
  await sleep(300)
  assert.equal(await strokes(a), 6)
  assert.equal(await strokes(b), 6)
  assert.equal(await shown(a), 6)
  assert.equal(await shown(b), 6)
  assert.equal(cloud.get(`page/${math.id}/${math.pages[0].id}`).content.objects.filter((o) => o.type === 'stroke').length, 6)
  assert.equal((await a.evaluate(() => window.inkling.account.state())).sync.conflicts.length, 0)
  step('edits made offline on one device and online on the other are both kept')

  // ---------------------------------------------------------------- version history
  const path = `page/${math.id}/${math.pages[0].id}`
  const versions = await a.evaluate((p) => window.inkling.account.versions(p), path)
  assert.ok(versions.length >= 1, 'the account keeps earlier versions')
  const oldest = versions.at(-1)
  assert.equal((await a.evaluate(([p, id]) => window.inkling.account.restoreVersion(p, id), [path, oldest.id])).status, 'saved')
  await sleep(400)
  const restored = await strokes(a)
  assert.ok(restored < 6, `restored an earlier version (${restored} strokes)`)
  await syncNow(a)
  await syncNow(b)
  await sleep(300)
  assert.equal(await strokes(b), restored)
  assert.equal(await shown(b), restored)
  step('an earlier version can be restored, and the restore syncs')

  // ---------------------------------------------------------------- the AI tutor from a browser
  const ai = await a.evaluate(async () => {
    const before = await window.inkling.ai.status()
    await window.inkling.ai.setConsent(true)
    return { provider: before.provider, url: before.cloud.url, test: await window.inkling.ai.test() }
  })
  assert.equal(ai.provider, 'cloud')
  assert.equal(ai.test.ok, true, JSON.stringify(ai.test))
  assert.ok(beta.requests.some((r) => r.path === '/v1/status'), 'the browser reached the AI server through its CORS allow-list')
  assert.equal(await a.locator('[data-testid="ai-provider-ollama"]:visible').count(), 0)
  step('the AI tutor works from the browser through the server’s allow-list; no key in the page')

  // ---------------------------------------------------------------- tablet
  const t = await open({ width: 820, height: 1180 }, { hasTouch: true })
  assert.ok(await t.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  assert.equal(await t.locator('[data-testid="tutor-panel"]').count(), 0, 'the tutor starts closed on a tablet')
  const tools = await t.locator('[role="toolbar"][aria-label="Drawing tools"]').boundingBox()
  const status = await t.getByTestId('save-status').boundingBox()
  assert.ok(tools.x + tools.width <= status.x + 1, 'tools and status don’t overlap on a tablet')
  // A stylus: pressure is recorded.
  const ts = await t.locator('[data-testid="page-surface"]').boundingBox()
  const pen = await t.context().newCDPSession(t)
  const penEvent = (type, dx, force) => pen.send('Input.dispatchMouseEvent', { type, x: ts.x + 80 + dx, y: ts.y + 200 + dx / 3, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force })
  await penEvent('mousePressed', 0, 0.3)
  for (let i = 1; i <= 8; i++) await penEvent('mouseMoved', i * 12, 0.3 + i * 0.05)
  await penEvent('mouseReleased', 100, 0)
  await saved(t)
  const penStroke = Object.values(await stored(t)).flatMap((d) => d.objects ?? []).find((o) => o.type === 'stroke')
  assert.ok(penStroke?.hasPressure && penStroke.points[1].length === 3, 'stylus pressure is stored with the stroke')
  await t.screenshot({ path: join(shots, 'web-tablet.png') })
  await t.context().close()
  step('tablet layout fits; a stylus stroke keeps its pressure')

  // ---------------------------------------------------------------- sign out
  b.once('dialog', (d) => void d.accept())
  await b.getByRole('button', { name: 'Settings', exact: true }).click()
  await Promise.all([b.waitForEvent('load'), b.getByTestId('sign-out').click()])
  await ready(b)
  const left = await b.evaluate(async () => ({ dbs: (await indexedDB.databases()).map((d) => d.name), account: localStorage.getItem('inkling.account') }))
  assert.equal(left.account, null)
  assert.ok(!left.dbs.some((n) => n.startsWith('inkling-u-')), `the account’s notebooks are removed from the browser: ${left.dbs}`)
  assert.equal(await b.evaluate((p) => fetch(p).then((r) => r.status), `asset/${asset.nb}/${asset.asset}`), 404, 'and its pictures')
  step('signing out (everything synced) leaves none of the account’s notes in the browser')

  // ---------------------------------------------------------------- security of what is served
  const html = readFileSync(join(out, 'index.html'), 'utf8')
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1]
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline|\*/.test(csp), csp)
  assert.match(csp, new RegExp(`connect-src 'self' ${supabase.url.replace(/[.:/]/g, '\\$&')}`))
  const bundle = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n')
  // Names of the server-side secrets (the AI provider's key, the admin token, Supabase's service key variables).
  for (const secret of ['INFERENCE_API_KEY', 'ADMIN_TOKEN', 'SUPABASE_SERVICE_ROLE', 'SERVICE_ROLE_KEY']) assert.ok(!bundle.includes(secret), `${secret} must not be in the web bundle`)
  assert.ok(supabase.requests.every((r) => !r.path.startsWith('/rest/') || r.authorization.startsWith('Bearer ey')), 'data requests carry the user’s own token')
  for (const p of [a, b]) assert.deepEqual(p.errors, [], 'no page errors')
  step('strict CSP, no server secrets in the bundle, no page errors')

  // ---------------------------------------------------------------- the desktop app on the same account
  if (!process.argv.includes('--web-only') && existsSync(join(root, 'out/main/index.js'))) {
    const { electronPath } = await import('../support/electronPath.mjs')
    const env = {
      ...process.env,
      INKLING_SKIP_WELCOME: '1',
      INKLING_TEST_HOOKS: '1',
      INKLING_DATA_DIR: await mkdtemp(join(tmpdir(), 'inkling-websync-')),
      INKLING_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'inkling-websync-config-')),
      INKLING_SUPABASE_URL: supabase.url,
      INKLING_SUPABASE_ANON_KEY: supabase.anonKey
    }
    delete env.NODE_OPTIONS
    delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root], env })
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.error('PAGE ERROR', e))
    await win.setViewportSize({ width: 1536, height: 960 })
    await win.waitForSelector('[data-testid="page-surface"]')
    await sleep(300)
    // Notebooks made on this computer before signing in.
    await win.getByTestId('notebook-title').click()
    await win.getByText('Rename notebook').click()
    await win.keyboard.type('Desktop Lab')
    await win.keyboard.press('Enter')
    await draw(win, [0.2, 0.2], [0.5, 0.3])
    await saved(win)

    await win.getByRole('button', { name: 'Settings', exact: true }).click()
    await win.getByTestId('sign-in-email').fill(EMAIL)
    await win.getByTestId('sign-in-email-send').click()
    await win.getByTestId('sign-in-code').fill('123456')
    await win.getByRole('button', { name: 'Sign in', exact: true }).click()
    await win.waitForSelector('[data-testid="migration-dialog"]')
    assert.ok(![...cloud.get('library').content.notebooks].some((n) => n.name === 'Desktop Lab'), 'not in the account before confirming')
    await win.getByTestId('migration-accept').click()
    await win.waitForSelector('[data-testid="account-email"]')
    await win.evaluate(() => window.inkling.account.syncNow())
    await win.waitForSelector('[data-testid="save-status"][data-sync="synced"]', { timeout: 20_000 })
    const merged = cloud.get('library').content.notebooks.map((n) => n.name)
    assert.ok(merged.includes('Desktop Lab') && merged.includes('Math Notes'), `the account has both devices’ notebooks: ${merged}`)
    assert.equal(merged.filter((n) => n === 'Physics').length, 1, `untouched starter notebooks are not duplicated: ${merged}`)
    step('desktop app: signs in, and its existing notebooks join the account after confirming')

    // The web app's notebook is now on the desktop, as ordinary files.
    await win.keyboard.press('Escape')
    const onDisk = JSON.parse(readFileSync(join(env.INKLING_DATA_DIR, 'library.json'), 'utf8'))
    const mathOnDisk = onDisk.notebooks.find((n) => n.name === 'Math Notes')
    const pageFile = join(env.INKLING_DATA_DIR, 'notebooks', mathOnDisk.id, 'pages', `${mathOnDisk.pages[0].id}.json`)
    assert.equal(JSON.parse(readFileSync(pageFile, 'utf8')).objects.filter((o) => o.type === 'stroke').length, restored)
    assert.ok(existsSync(join(env.INKLING_DATA_DIR, 'notebooks', asset.nb, 'assets', asset.asset)), 'the web app’s picture is a file on the desktop')
    step('desktop app: the web app’s notebook, ink and picture arrive as ordinary files')

    // And the desktop's notebook reaches the web app.
    await syncNow(a)
    await sleep(400)
    assert.ok((await stored(a)).library.notebooks.some((n) => n.name === 'Desktop Lab'))
    assert.equal(await strokes(a, 'Desktop Lab'), 1)
    await a.screenshot({ path: join(shots, 'web-after-desktop-sync.png') })
    step('web app: the desktop’s notebook and ink arrive')

    // Sign out on the desktop: notebooks stay on the computer.
    await win.getByRole('button', { name: 'Settings', exact: true }).click()
    win.once('dialog', (d) => void d.accept())
    await win.getByTestId('sign-out').click()
    await win.waitForSelector('[data-testid="account-signed-out"]')
    assert.ok(existsSync(pageFile))
    step('desktop app: signing out keeps the notebooks on the computer')
    await app.close()
  } else console.log('  – desktop part skipped')

  console.log('\nWeb acceptance: PASS')
} finally {
  await browser.close()
  await supabase.close()
  await beta.close()
  site.close()
}
