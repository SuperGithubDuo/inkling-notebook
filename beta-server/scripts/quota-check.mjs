#!/usr/bin/env node
/**
 * The account-wide request quota under concurrency, against a TEMPORARY copy of the
 * AI server on OpenRouter Free deployed with a tiny GLOBAL_REQUESTS_PER_DAY (see
 * .github/workflows/ai-server-free.yml). Fires a burst of simultaneous requests from
 * many installations and checks, with OpenRouter's own counter (GET /api/v1/key):
 *   - no more requests reached OpenRouter than the quota allows;
 *   - the rest were refused with the quota message (or a per-minute pause), never an error;
 *   - OpenRouter charged nothing.
 *
 *   node beta-server/scripts/quota-check.mjs <url> <quota> [report.md]
 *   (INKLING_ADMIN_TOKEN and OPENROUTER_API_KEY in the environment)
 */
import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

const [rawUrl, quotaArg, reportFile] = process.argv.slice(2)
const url = (rawUrl ?? '').replace(/\/+$/, '')
const quota = Number(quotaArg)
const admin = (process.env.INKLING_ADMIN_TOKEN ?? '').replace(/[\r\n]/g, '')
const key = (process.env.OPENROUTER_API_KEY ?? '').trim()
const N = Number(process.env.QUOTA_BURST ?? 12)
if (!url || !quota || !admin || !key) {
  console.error('usage: quota-check.mjs <url> <quota> [report.md] (INKLING_ADMIN_TOKEN, OPENROUTER_API_KEY set)')
  process.exit(2)
}
const orKey = async () => (await (await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } })).json())?.data
const credits = async () => (await (await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` } })).json())?.data
const summary = async () => (await fetch(`${url}/admin/summary`, { headers: { authorization: `Bearer ${admin}` } })).json()

async function ask(i) {
  const res = await fetch(`${url}/v1/tutor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inkling-install': `inst_${randomBytes(18).toString('base64url')}`, 'x-inkling-notice': '4' },
    body: JSON.stringify({ task: 'chat', turns: [{ role: 'user', parts: [{ text: `Question ${i}: what is ${i} + ${i}? One line.` }] }] })
  })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const j = await res.json().catch(() => null)
    return { i, refused: j?.error?.scope ?? j?.error?.code ?? `http ${res.status}` }
  }
  const events = (await res.text()).split('\n\n').filter(Boolean).map((b) => /^event: (.+)$/m.exec(b)?.[1])
  return { i, event: events.at(-1) }
}

const k0 = await orKey()
const c0 = await credits()
const results = await Promise.all(Array.from({ length: N }, (_, i) => ask(i)))
await new Promise((r) => setTimeout(r, 6000))
const k1 = await orKey()
const c1 = await credits()
const s = await summary()
const reached = (k1?.free_model_daily_requests?.used ?? NaN) - (k0?.free_model_daily_requests?.used ?? NaN)
const answered = results.filter((r) => r.event === 'done').length
const refused = results.filter((r) => r.refused)
const checks = [
  ['requests that reached OpenRouter ≤ the quota (OpenRouter’s own counter)', Number.isFinite(reached) ? reached <= quota : s.upstreamRequests <= quota, `${Number.isFinite(reached) ? reached : '?'} reached; server counted ${s.upstreamRequests} of ${s.upstreamRequestLimit}`],
  ['the rest were refused by the quota or a per-minute pause, never an error', refused.every((r) => ['free_daily_quota', 'capacity', 'rate_limited', 'upstream_unavailable'].includes(r.refused)) && results.every((r) => r.refused || r.event === 'done'), JSON.stringify(results.map((r) => r.refused ?? r.event))],
  ['answers were delivered up to the quota', answered > 0 && answered <= quota, `${answered} answered`],
  ['OpenRouter charged nothing (credits usage unchanged)', JSON.stringify(c0?.total_usage) === JSON.stringify(c1?.total_usage), `usage ${c0?.total_usage} → ${c1?.total_usage}`]
]
const lines = [`## Account-wide request quota under concurrency`, '', `${N} simultaneous requests from ${N} installations; server quota ${quota} requests a day.`, '', '| Check | Result | Detail |', '|---|---|---|']
for (const [name, ok, detail] of checks) lines.push(`| ${name} | ${ok ? 'pass' : '**FAIL**'} | ${detail} |`)
lines.push('')
console.log(lines.join('\n'))
if (reportFile) await appendFile(reportFile, lines.join('\n') + '\n')
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
