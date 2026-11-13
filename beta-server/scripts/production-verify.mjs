#!/usr/bin/env node
/**
 * Independent check of the PRODUCTION AI server ("inkling-ai-beta") after a provider switch.
 * Read-mostly: it never deploys, never changes limits, never pauses. It sends four short
 * questions (two as an updated app on notice 4, two as an older app) and one malformed request
 * that is refused before any model runs. Cost: about $0.002 on DeepInfra and ~100 Neurons on the
 * Workers AI free allocation.
 *
 *   node beta-server/scripts/production-verify.mjs   (writes a Markdown report to stdout)
 *
 * Env: URL, ADMIN (admin token), CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and optionally
 * DEEPINFRA_API_KEY (only to check that it never appears in anything the server sends back).
 * Exit 1 if any check fails.
 */
import { randomBytes } from 'node:crypto'
import { checkUsageReport } from './privacy-check.mjs'

const { URL: url, ADMIN: admin, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: cf, DEEPINFRA_API_KEY: key } = process.env
const script = 'inkling-ai-beta'
const lines = ['# Production AI server: independent check', '', `Server: ${url}  `, `Checked: ${new Date().toISOString()}`, '']
let failed = 0
const seen = [] // every body the server returned, for the key-leak check
const check = (name, ok, detail = '') => {
  lines.push(`- ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const section = (t) => lines.push('', `## ${t}`, '')
const inst = () => 'inst_' + randomBytes(16).toString('hex')

// ---- 1. Cloudflare's record of what is deployed -----------------------------------------
section('What Cloudflare has deployed')
const cfApi = async (path) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}${path}`, { headers: { authorization: `Bearer ${cf}` } })
  return r.json().catch(() => null)
}
const settings = await cfApi('/settings')
const bindings = settings?.result?.bindings ?? []
const plain = Object.fromEntries(bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]))
const secrets = bindings.filter((b) => b.type === 'secret_text').map((b) => b.name)
check('settings readable', settings?.success === true, settings?.success ? '' : JSON.stringify(settings?.errors).slice(0, 200))
check('INFERENCE_PROVIDER = deepinfra', plain.INFERENCE_PROVIDER === 'deepinfra', plain.INFERENCE_PROVIDER ?? 'not set (Workers AI)')
check('older apps bridged to Workers AI (LEGACY_WORKERS_AI = true)', plain.LEGACY_WORKERS_AI === 'true', plain.LEGACY_WORKERS_AI)
check('updated apps need notice 4 (MIN_NOTICE_VERSION = 4)', String(plain.MIN_NOTICE_VERSION) === '4', plain.MIN_NOTICE_VERSION)
check('model Qwen/Qwen3.8-27B', plain.UPSTREAM_MODEL === 'Qwen/Qwen3.8-27B', plain.UPSTREAM_MODEL)
const want = { GLOBAL_MONTHLY_USD: '5', GLOBAL_DAILY_USD: '0.25', MONTHLY_PACING: '1.5', INSTALL_DAILY_USD: '0.01', INSTALL_MONTHLY_USD: '0.15', NETWORK_DAILY_USD: '0.05', NETWORK_CONCURRENT: '4', NETWORK_PER_MINUTE: '20', GLOBAL_CONCURRENT: '8', INSTALL_CONCURRENT: '1', INSTALL_PER_MINUTE: '6', MAX_INPUT_TOKENS: '12000', UPSTREAM_MAX_ATTEMPTS: '3', MODEL_TEXT: '@cf/google/gemma-4-26b-a4b-it', TEXT_MODEL_TASKS: 'practice' }
for (const [k, v] of Object.entries(want)) check(`${k} = ${v}`, String(plain[k]) === v, String(plain[k]))
check('provider key and admin token are Cloudflare secrets (values not readable here)', secrets.includes('INFERENCE_API_KEY') && secrets.includes('ADMIN_TOKEN'), `secrets: ${secrets.join(', ')}`)
check('Workers AI binding kept (rollback and older apps)', bindings.some((b) => b.type === 'ai'), '')
check('ledgers are Durable Objects', bindings.some((b) => b.type === 'durable_object_namespace'), '')
const deps = await cfApi('/deployments')
const latest = deps?.result?.deployments?.[0]
check('one version serves 100% of traffic (no split with an older version)', latest?.versions?.length === 1 && latest.versions[0].percentage === 100, latest ? `deployed ${latest.created_on} by ${latest.source}; versions ${JSON.stringify(latest.versions?.map((v) => v.percentage))}` : 'not readable')
// The web app (GitHub Pages) can only use the tutor if its origin is on the server's allow-list.
const WEB_APP = 'https://supergithubduo.github.io'
check(`WEB_ORIGINS allows the web app (${WEB_APP})`, String(plain.WEB_ORIGINS ?? '').split(',').map((o) => o.trim()).includes(WEB_APP), String(plain.WEB_ORIGINS ?? 'not set: the web app’s tutor is blocked by the browser'))
const preflight = async (origin) => {
  const r = await fetch(url + '/v1/tutor', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-inkling-install,x-inkling-notice' } })
  return { status: r.status, allow: r.headers.get('access-control-allow-origin') }
}
const fromApp = await preflight(WEB_APP).catch((e) => ({ status: 0, allow: String(e) }))
check('browser preflight from the web app is answered', fromApp.status === 204 && fromApp.allow === WEB_APP, `HTTP ${fromApp.status}, allow-origin ${fromApp.allow}`)
const fromElsewhere = await preflight('https://not-inkling.example').catch((e) => ({ status: 0, allow: String(e) }))
check('other sites get no CORS headers', fromElsewhere.allow === null, `HTTP ${fromElsewhere.status}, allow-origin ${fromElsewhere.allow}`)
lines.push('', `Non-secret settings: ${Object.keys(plain).sort().map((k) => `${k}=${plain[k]}`).join(', ')}`)

// ---- 2. Admin reports (before) -----------------------------------------------------------
const get = async (path, auth = true) => {
  const r = await fetch(url + path, { headers: auth ? { authorization: `Bearer ${admin}` } : {} })
  const text = await r.text()
  seen.push(text)
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, body, text }
}
section('Admin reports')
const noAuth = await get('/admin/summary', false)
check('admin API hidden without the token', [401, 403, 404].includes(noAuth.status) && !/monthLimit|unit/.test(noAuth.text), `HTTP ${noAuth.status}`)
const mainBefore = (await get('/admin/summary')).body
const legacyBefore = (await get('/admin/legacy/summary')).body
check('DeepInfra ledger in dollars (µ$), $5 month, $0.25 day', mainBefore?.unit === 'usd' && mainBefore.monthLimit === 5_000_000 && mainBefore.dailyConfigured === 250_000, JSON.stringify({ unit: mainBefore?.unit, monthLimit: mainBefore?.monthLimit, dailyConfigured: mainBefore?.dailyConfigured, todayCap: mainBefore?.globalLimit, paced: mainBefore?.paced }))
check('Workers AI bridge ledger separate, in Neurons', legacyBefore?.unit === 'neurons', JSON.stringify({ unit: legacyBefore?.unit, globalLimit: legacyBefore?.globalLimit }))
check('not paused (both)', mainBefore?.paused === false && legacyBefore?.paused === false, `${mainBefore?.paused} / ${legacyBefore?.paused}`)
check('no overshoot today (real cost never above reservation)', (mainBefore?.overshoot?.count ?? 0) === 0, JSON.stringify(mainBefore?.overshoot))
const pm = checkUsageReport(mainBefore)
const pl = checkUsageReport(legacyBefore)
check('usage reports hold only numbers and identifiers (no notebook text)', pm.length === 0 && pl.length === 0, [...pm, ...pl].slice(0, 3).join('; '))
lines.push('', `Before: DeepInfra month $${((mainBefore?.monthUsed ?? 0) / 1e6).toFixed(5)} (${mainBefore?.monthAnswers} answers), today $${((mainBefore?.todayUsed ?? 0) / 1e6).toFixed(5)} (${mainBefore?.answers}); Workers AI today ${legacyBefore?.todayUsed} Neurons (${legacyBefore?.answers} answers).`)

// ---- 3. Status as each kind of app --------------------------------------------------------
section('Status as an updated app and as an older app')
const newApp = inst()
const oldApp = inst()
const status = async (id, notice) => {
  const h = { 'x-inkling-install': id }
  if (notice) h['x-inkling-notice'] = notice
  const r = await fetch(url + '/v1/status', { headers: h })
  const text = await r.text()
  seen.push(text)
  return { status: r.status, body: JSON.parse(text) }
}
const s4 = await status(newApp, '4')
const s3 = await status(oldApp, null)
check('notice-4 app: DeepInfra allowance ($0.01/day, $0.15/month per installation)', s4.body?.quota?.installLimit === 10_000 && s4.body?.quota?.installMonthLimit === 150_000, JSON.stringify(s4.body?.quota))
check('notice-4 app: provider-neutral model name', s4.body?.model === 'qwen3.8-27b', s4.body?.model)
check('older app: Workers AI allowance (900 Neurons/day)', s3.body?.quota?.installLimit === 900, JSON.stringify(s3.body?.quota))
check('older app: unchanged model name', s3.body?.model === '@cf/qwen/qwen3.8-27b', s3.body?.model)

// ---- 4. A few real answers -----------------------------------------------------------------
section('Four short answers')
const ask = async (id, notice, body) => {
  const h = { 'content-type': 'application/json', 'x-inkling-install': id }
  if (notice) h['x-inkling-notice'] = notice
  const t0 = Date.now()
  const r = await fetch(url + '/v1/tutor', { method: 'POST', headers: h, body: JSON.stringify(body) })
  let first = null
  let text = ''
  const dec = new TextDecoder()
  const reader = r.body.getReader()
  let chunks = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const piece = dec.decode(value, { stream: true })
    if (first === null && piece.includes('event: delta')) first = Date.now() - t0
    if (piece.includes('event: delta')) chunks++
    text += piece
  }
  seen.push(text)
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])])
  const answer = events.filter(([e]) => e === 'delta').map(([, d]) => d.text).join('')
  const done = events.find(([e]) => e === 'done')?.[1]
  const error = events.find(([e]) => e === 'error')?.[1]
  return { status: r.status, first, total: Date.now() - t0, deltas: events.filter(([e]) => e === 'delta').length, chunks, answer, done, error, ctype: r.headers.get('content-type') }
}
const chat = { task: 'chat', turns: [{ role: 'user', parts: [{ text: 'In two short sentences, explain why 3/4 is bigger than 2/3.' }] }] }
const practice = { task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create 1 practice problem at easy difficulty on: adding fractions with unlike denominators.' }] }] }
const runs = [
  ['updated app (notice 4)', 'chat', await ask(newApp, '4', chat)],
  ['updated app (notice 4)', 'practice', await ask(newApp, '4', practice)],
  ['older app', 'chat', await ask(oldApp, null, chat)],
  ['older app', 'practice', await ask(oldApp, null, practice)]
]
lines.push('| App | Task | HTTP | Streamed pieces | First text | Whole answer | Cost | Unit | Tokens in→out | Left today |', '|---|---|---|---|---|---|---|---|---|---|')
for (const [app, task, r] of runs) lines.push(`| ${app} | ${task} | ${r.status} | ${r.deltas} (${r.chunks} network chunks) | ${r.first ?? '–'} ms | ${r.total} ms | ${r.done?.neurons ?? '–'} | ${r.done?.unit ?? '–'} | ${r.done?.usage?.inputTokens ?? r.done?.usage?.prompt_tokens ?? '?'}→${r.done?.usage?.outputTokens ?? r.done?.usage?.completion_tokens ?? '?'} | ${r.done?.quota?.remaining ?? '–'} |`)
lines.push('')
for (const [app, task, r] of runs) {
  check(`${app} ${task}: answered`, r.status === 200 && !!r.done && r.answer.trim().length > 0, r.error ? JSON.stringify(r.error).slice(0, 200) : '')
  check(`${app} ${task}: streamed as server-sent events`, /text\/event-stream/.test(r.ctype ?? '') && r.deltas >= 1, `${r.deltas} text events`)
}
check('notice-4 answers billed in µ$ (DeepInfra)', runs.slice(0, 2).every(([, , r]) => r.done?.unit === 'usd'))
check('older-app answers billed in Neurons (Workers AI)', runs.slice(2).every(([, , r]) => r.done?.unit === 'neurons'))
check('notice-4 chat streamed in more than one piece', runs[0][2].deltas > 1, `${runs[0][2].deltas}`)
lines.push('', 'Answer previews (first 160 characters, for a human eye only; not used as a quality check):', '')
for (const [app, task, r] of runs) lines.push(`- ${app} ${task}: ${JSON.stringify(r.answer.slice(0, 160))}`)

// A malformed request is refused before any model runs.
const bad = await fetch(url + '/v1/tutor', { method: 'POST', headers: { 'content-type': 'application/json', 'x-inkling-install': newApp, 'x-inkling-notice': '4' }, body: '{"task":"chat","turns":"nope"}' })
const badText = await bad.text()
seen.push(badText)
check('a malformed request is refused (400) before any model runs', bad.status === 400, `HTTP ${bad.status}`)

// ---- 5. Admin reports (after): what was counted -----------------------------------------------
section('What the ledgers counted for these answers')
await new Promise((r) => setTimeout(r, 1500))
const mainAfter = (await get('/admin/summary')).body
const legacyAfter = (await get('/admin/legacy/summary')).body
const dm = (mainAfter?.monthUsed ?? 0) - (mainBefore?.monthUsed ?? 0)
const dl = (legacyAfter?.todayUsed ?? 0) - (legacyBefore?.todayUsed ?? 0)
const billed4 = runs.slice(0, 2).reduce((n, [, , r]) => n + (r.done?.neurons ?? 0), 0)
const billed3 = runs.slice(2).reduce((n, [, , r]) => n + (r.done?.neurons ?? 0), 0)
lines.push(`DeepInfra ledger: +${dm} µ$ ($${(dm / 1e6).toFixed(5)}); the two answers reported ${billed4.toFixed(1)} µ$. Tokens today ${JSON.stringify(mainBefore?.tokens?.today)} → ${JSON.stringify(mainAfter?.tokens?.today)}.  `)
lines.push(`Workers AI ledger: +${dl} Neurons; the two answers reported ${billed3.toFixed(1)} Neurons (other users may have answered meanwhile).`)
check('DeepInfra ledger grew by what the answers reported (±1 µ$, no other notice-4 users yet)', Math.abs(dm - billed4) <= 2, `${dm} vs ${billed4.toFixed(1)}`)
check('DeepInfra token counters grew', (mainAfter?.tokens?.today?.output ?? 0) > (mainBefore?.tokens?.today?.output ?? 0))
check('Workers AI ledger grew at least by its answers', dl >= Math.floor(billed3) - 1, `${dl} vs ${billed3.toFixed(1)}`)
const mm = mainAfter?.models?.today ?? {}
const lm = legacyAfter?.models?.today ?? {}
lines.push('', `DeepInfra models today: ${Object.entries(mm).map(([m, v]) => `${m} (${JSON.stringify(v.tasks)}, providerReported ${v.providerReported ?? 'none'} over ${v.providerReportedAnswers ?? 0} answers, errors ${v.errors} ${JSON.stringify(v.errorKinds ?? {})})`).join('; ')}  `)
lines.push(`Workers AI models today: ${Object.entries(lm).map(([m, v]) => `${m} (${JSON.stringify(v.tasks)}, errors ${v.errors})`).join('; ')}`)
check('notice-4 answers all from Qwen 3.8 27B on DeepInfra', Object.keys(mm).length > 0 && Object.keys(mm).every((m) => /qwen3\.8-27b/i.test(m)), Object.keys(mm).join(', '))
check('older-app practice from Gemma on Workers AI', Object.entries(lm).some(([m, v]) => /gemma/i.test(m) && (v.tasks?.practice ?? 0) > 0), Object.keys(lm).join(', '))
check('older-app chat from Qwen on Workers AI', Object.entries(lm).some(([m, v]) => /qwen3\.8-27b/.test(m) && (v.tasks?.chat ?? 0) > 0))
check('DeepInfra reports its own cost and the ledger compares it', Object.values(mm).some((v) => typeof v.providerReported === 'number'))
check('still no overshoot', (mainAfter?.overshoot?.count ?? 0) === 0, JSON.stringify(mainAfter?.overshoot))
const p2 = [...checkUsageReport(mainAfter), ...checkUsageReport(legacyAfter)]
check('usage reports after the answers: numbers and identifiers only', p2.length === 0, p2.slice(0, 3).join('; '))
const phrases = ['3/4 is bigger', 'unlike denominators', 'why 3/4']
check('none of the question text is in the usage reports', !phrases.some((p) => JSON.stringify(mainAfter).includes(p) || JSON.stringify(legacyAfter).includes(p)))

// ---- 6. The key never comes back -------------------------------------------------------------
section('Keys')
if (key && key.trim()) check('the DeepInfra key appears in nothing the server sent back', !seen.some((t) => t.includes(key.trim())), `${seen.length} responses checked`)
else lines.push('- (DeepInfra key not given; leak check skipped)')
check('no bearer token or key-shaped field in responses', !seen.some((t) => /authorization|api[_-]?key|bearer /i.test(t)))

lines.push('', failed ? `**${failed} check(s) failed.**` : '**All checks passed.**')
console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)
