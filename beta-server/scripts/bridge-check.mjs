#!/usr/bin/env node
/**
 * Runs the REAL Worker (src/index.ts, in workerd through `wrangler dev --local`) with the
 * DeepInfra configuration plus the bridge for older apps, and checks the routing that unit
 * tests can't reach (they run the handler, not the Worker entry):
 *
 *   - an app on the old notice (no x-inkling-notice, as every published version) is answered
 *     by the Workers AI bridge: Neuron allowance, its own ledger, no "update" refusal
 *   - an app on notice 4 is answered by the DeepInfra path: dollar allowance, the $5 budget
 *   - the two ledgers are separate (/admin/summary vs /admin/legacy/summary)
 *   - with the bridge off, an old app is told to update; nothing reaches any provider
 *   - a missing provider key fails closed
 *
 * Only /v1/status and /admin/* are called: no model request, no key, no cost. The provider
 * key is a dummy and the AI binding is left out (status checks never use either).
 *
 *   node beta-server/scripts/bridge-check.mjs [wrangler.deepinfra.jsonc | wrangler.external.jsonc]
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const here = join(import.meta.dirname, '..')
const ADMIN = 'a'.repeat(40)
// The production DeepInfra config by default (the file that would be deployed), or another one.
const configFile = process.argv[2] ?? 'wrangler.deepinfra.jsonc'
const base = readFileSync(join(here, configFile), 'utf8')
  .replace(/"name": "[^"]+"/, '"name": "inkling-bridge-check"')
  .replace(/\s*"ai": \{ "binding": "AI" \},/, '')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

async function withWorker(vars, port, fn) {
  const cfg = join(here, `.bridge-check-${port}.jsonc`)
  writeFileSync(cfg, base)
  const persist = mkdtempSync(join(tmpdir(), 'inkling-bridge-'))
  const args = ['wrangler', 'dev', '-c', cfg, '--local', '--port', String(port), '--persist-to', persist, '--var', `ADMIN_TOKEN:${ADMIN}`, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])]
  const child = spawn('npx', args, { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 120; i++) {
      try {
        await fetch(url + '/')
        break
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
      if (i === 119) throw new Error('wrangler dev did not start:\n' + log.slice(-2000))
    }
    // Warm up: the first requests after start can race the runtime.
    for (let i = 0; i < 40; i++) {
      const r = await fetch(url + '/v1/status', { headers: { 'x-inkling-install': 'inst_' + 'w'.repeat(32), 'x-inkling-notice': '4' } }).catch(() => null)
      if (r && (r.status === 200 || r.status === 503)) break
      await new Promise((res) => setTimeout(res, 500))
    }
    const before = failures
    await fn(url)
    if (failures > before) console.log('  --- worker log (errors) ---\n' + log.split('\n').filter((l) => /error|exception|uncaught/i.test(l)).slice(0, 12).join('\n'))
  } finally {
    // npx starts wrangler, which starts workerd: stop the whole group, or the port stays taken.
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    await new Promise((r) => setTimeout(r, 500))
    rmSync(cfg, { force: true })
    rmSync(persist, { recursive: true, force: true })
  }
}

const install = (c) => 'inst_' + c.repeat(32)
const status = (url, headers) => fetch(url + '/v1/status', { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
const admin = (url, path) => fetch(url + path, { headers: { authorization: `Bearer ${ADMIN}` } }).then((r) => r.json())

console.log(`${configFile}, bridge on (LEGACY_WORKERS_AI=true), DeepInfra for notice 4:`)
await withWorker({ INFERENCE_API_KEY: 'dummy-key-not-used-by-status', LEGACY_WORKERS_AI: 'true' }, 8791, async (url) => {
  const old = await status(url, { 'x-inkling-install': install('a') })
  check('an old app (no notice header) gets a normal status', old.status === 200, JSON.stringify(old.body))
  // Workers Free allowance: 900 Neurons a day per installation (wrangler.external.jsonc's rollback values).
  check('…from the Workers AI bridge (Neuron allowance)', old.body?.quota?.installLimit === 900, JSON.stringify(old.body?.quota))
  const fresh = await status(url, { 'x-inkling-install': install('b'), 'x-inkling-notice': '4' })
  check('an app on notice 4 gets a normal status', fresh.status === 200, JSON.stringify(fresh.body))
  // $0.01 a day per installation = 10,000 µ$, and the paced daily cap ($0.25 at the start of a month or less).
  check('…from the DeepInfra path (dollar allowance)', fresh.body?.quota?.installLimit === 10_000, JSON.stringify(fresh.body?.quota))
  check('old apps see the model name production reports today; new apps the provider-neutral one', old.body?.model === '@cf/qwen/qwen3.8-27b' && fresh.body?.model === 'qwen3.8-27b', `${old.body?.model} / ${fresh.body?.model}`)
  const main = await admin(url, '/admin/summary')
  const legacy = await admin(url, '/admin/legacy/summary')
  check('the DeepInfra ledger counts in dollars with the $5 month', main.unit === 'usd' && main.monthLimit === 5_000_000, JSON.stringify({ unit: main.unit, monthLimit: main.monthLimit }))
  check('the bridge has its own ledger, in Neurons, under the Free-plan cap', legacy.unit === 'neurons' && legacy.globalLimit === 9000, JSON.stringify({ unit: legacy.unit, globalLimit: legacy.globalLimit }))
  // Separate ledgers: pausing the bridge's stops old apps only.
  await fetch(url + '/admin/legacy/pause', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) })
  const oldPaused = await status(url, { 'x-inkling-install': install('a') })
  const newRunning = await status(url, { 'x-inkling-install': install('b'), 'x-inkling-notice': '4' })
  check('pausing the bridge ledger pauses old apps…', oldPaused.body?.paused === true, JSON.stringify(oldPaused.body))
  check('…and leaves the DeepInfra path running (separate ledgers)', newRunning.body?.paused === false, JSON.stringify(newRunning.body))
  await fetch(url + '/admin/legacy/pause', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }) })
  check('unpausing restores old apps', (await status(url, { 'x-inkling-install': install('a') })).body?.paused === false)
  // The emergency pause (/admin/pause, used by `npm run admin -- pause` and the ops workflow) stops BOTH paths.
  const pause = (p) => fetch(url + '/admin/pause', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ paused: p }) })
  check('the emergency pause answers 200', (await pause(true)).status === 200)
  const both = [await status(url, { 'x-inkling-install': install('a') }), await status(url, { 'x-inkling-install': install('b'), 'x-inkling-notice': '4' })]
  check('…and stops older apps AND notice-4 apps', both.every((r) => r.body?.paused === true), JSON.stringify(both.map((r) => r.body?.paused)))
  await pause(false)
  const after = [await status(url, { 'x-inkling-install': install('a') }), await status(url, { 'x-inkling-install': install('b'), 'x-inkling-notice': '4' })]
  check('resume restores both', after.every((r) => r.body?.paused === false), JSON.stringify(after.map((r) => r.body?.paused)))
  const noAuth = await fetch(url + '/admin/legacy/summary')
  const leaked = await noAuth.text()
  check('the bridge admin API needs the admin token (hidden: 404, no data)', [401, 403, 404].includes(noAuth.status) && !/globalLimit|unit/.test(leaked), `${noAuth.status} ${leaked.slice(0, 80)}`)
})

console.log('Bridge off: old apps are told to update:')
await withWorker({ INFERENCE_API_KEY: 'dummy-key-not-used-by-status', LEGACY_WORKERS_AI: 'false' }, 8792, async (url) => {
  const r = await fetch(url + '/v1/tutor', { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': install('c') }, body: JSON.stringify({ task: 'chat', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] }) })
  const body = await r.json().catch(() => null)
  check('an old app asking a question gets 400 update_required (nothing sent anywhere)', r.status === 400 && body?.error?.scope === 'update_required', `${r.status} ${JSON.stringify(body)}`)
})

console.log('No provider key: fails closed:')
await withWorker({ LEGACY_WORKERS_AI: 'true' }, 8793, async (url) => {
  const r = await status(url, { 'x-inkling-install': install('d'), 'x-inkling-notice': '4' })
  check('503 beta_closed, naming the missing secret', r.status === 503 && /INFERENCE_API_KEY/.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body)}`)
})

console.log(failures ? `\n${failures} check(s) failed` : '\nAll bridge checks passed')
process.exit(failures ? 1 : 0)
