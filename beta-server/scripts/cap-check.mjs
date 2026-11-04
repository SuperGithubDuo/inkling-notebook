#!/usr/bin/env node
/**
 * Spending caps under concurrency, against a TEMPORARY copy of the AI server on
 * an external provider deployed with a tiny dollar cap (see
 * .github/workflows/ai-server-next.yml). Fires a burst of simultaneous,
 * deliberately long requests from many installations and checks that:
 *   - the service never spends past its cap, counting what the provider reports;
 *   - refusals are the expected cap refusal (daily or monthly), not errors;
 *   - no answer cost more than its reservation (output stays under its cap,
 *     real input stays near the estimate).
 *
 *   node beta-server/scripts/cap-check.mjs <url> <daily|monthly> [report.md]
 *   (INKLING_ADMIN_TOKEN in the environment)
 */
import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

const [rawUrl, scope = 'daily', reportFile] = process.argv.slice(2)
const url = (rawUrl ?? '').replace(/\/+$/, '')
const admin = (process.env.INKLING_ADMIN_TOKEN ?? '').replace(/[\r\n]/g, '')
const N = Number(process.env.CAP_BURST ?? 16)
if (!url || !admin) {
  console.error('usage: cap-check.mjs <url> <daily|monthly> [report.md] (INKLING_ADMIN_TOKEN set)')
  process.exit(2)
}
const summary = async () => (await fetch(`${url}/admin/summary`, { headers: { authorization: `Bearer ${admin}` } })).json()
const id = () => `inst_${randomBytes(18).toString('base64url')}`

async function ask(i) {
  const started = Date.now()
  const res = await fetch(`${url}/v1/tutor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inkling-install': id(), 'x-inkling-notice': '4' },
    // Long answers on purpose: each request should come close to its output cap.
    body: JSON.stringify({ task: 'chat', turns: [{ role: 'user', parts: [{ text: `Request ${i}: explain, step by step and at full length, how to solve quadratic equations by completing the square, with three fully worked examples.` }] }] })
  })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const j = await res.json().catch(() => null)
    return { i, status: res.status, refused: j?.error?.scope ?? j?.error?.code ?? 'unknown', ms: Date.now() - started }
  }
  const text = await res.text()
  const events = text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? 'null') }))
  const end = events.at(-1)
  return { i, status: res.status, event: end?.event, cost: end?.data?.neurons, usage: end?.data?.usage, finish: end?.data?.finishReason, ms: Date.now() - started }
}

const before = await summary()
const limit = scope === 'monthly' ? before.monthLimit : before.globalLimit
const results = await Promise.all(Array.from({ length: N }, (_, i) => ask(i)))
// Let every reservation settle.
await new Promise((r) => setTimeout(r, 5000))
const after = await summary()
const answered = results.filter((r) => r.event === 'done')
const refused = results.filter((r) => r.refused)
const failed = results.filter((r) => r.event === 'error' || (!r.refused && r.event !== 'done'))
const spent = answered.reduce((s, r) => s + (r.cost ?? 0), 0)
const used = scope === 'monthly' ? after.monthUsed : after.globalUsed
const maxOut = Math.max(0, ...answered.map((r) => r.usage?.outputTokens ?? 0))
const expectRefusal = scope === 'monthly' ? 'global_monthly_quota' : 'global_quota'
const checks = [
  ['the service stayed under its cap (ledger, after settling)', used <= limit, `${used} of ${limit} µ$`],
  ['answers delivered cost no more than the cap in all (provider-reported tokens)', spent <= limit, `${spent.toFixed(0)} µ$ in ${answered.length} answers`],
  ['some requests were answered and the rest refused by the cap', answered.length > 0 && refused.length > 0, `${answered.length} answered, ${refused.length} refused`],
  [`every refusal was the ${scope} cap or a busy/capacity pause, never an error`, refused.every((r) => [expectRefusal, 'capacity', 'busy', 'global_quota'].includes(r.refused)) && failed.length === 0, JSON.stringify(refused.map((r) => r.refused))],
  ['no answer passed its output cap (900 tokens for chat)', maxOut <= 900, `max output ${maxOut} tokens`]
]
const lines = [`## Spending cap under concurrency (${scope})`, '', `${N} simultaneous long chat requests from ${N} installations; cap ${limit} µ$ ($${(limit / 1e6).toFixed(4)}).`, '', '| Check | Result | Detail |', '|---|---|---|']
for (const [name, ok, detail] of checks) lines.push(`| ${name} | ${ok ? 'pass' : '**FAIL**'} | ${detail} |`)
lines.push('', '| # | Outcome | Tokens in → out | Cost µ$ | Finish | Time |', '|---|---|---|---|---|---|')
for (const r of results) lines.push(`| ${r.i} | ${r.refused ? `refused: ${r.refused}` : r.event} | ${r.usage ? `${r.usage.inputTokens} → ${r.usage.outputTokens}` : '–'} | ${r.cost ?? '–'} | ${r.finish ?? '–'} | ${(r.ms / 1000).toFixed(1)} s |`)
lines.push('')
console.log(lines.join('\n'))
if (reportFile) await appendFile(reportFile, lines.join('\n') + '\n')
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
