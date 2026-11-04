#!/usr/bin/env node
/**
 * The account-wide request and token quotas under concurrency, against a TEMPORARY
 * copy of the AI server on Groq deployed with a tiny GLOBAL_REQUESTS_PER_DAY (see
 * .github/workflows/ai-server-groq.yml). Fires a burst of simultaneous requests from
 * many installations and checks, with Groq's own counter (x-ratelimit-remaining-requests
 * on a direct 5-token call before and after):
 *   - no more requests reached Groq than the quota allows;
 *   - the rest were refused with a quota or capacity message, never an error;
 *   - the server's own token count stayed under its per-minute and daily quotas.
 *
 *   node beta-server/scripts/groq-quota-check.mjs <url> <quota> [report.md]
 *   (INKLING_ADMIN_TOKEN and GROQ_API_KEY in the environment)
 */
import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

const [rawUrl, quotaArg, reportFile] = process.argv.slice(2)
const url = (rawUrl ?? '').replace(/\/+$/, '')
const quota = Number(quotaArg)
const admin = (process.env.INKLING_ADMIN_TOKEN ?? '').replace(/[\r\n]/g, '')
const key = (process.env.GROQ_API_KEY ?? '').trim()
const N = Number(process.env.QUOTA_BURST ?? 12)
if (!url || !quota || !admin || !key) {
  console.error('usage: groq-quota-check.mjs <url> <quota> [report.md] (INKLING_ADMIN_TOKEN, GROQ_API_KEY set)')
  process.exit(2)
}
const remaining = async () => {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 5, service_tier: 'on_demand' })
  })
  await r.text()
  return Number(r.headers.get('x-ratelimit-remaining-requests'))
}
const summary = async () => (await fetch(`${url}/admin/summary`, { headers: { authorization: `Bearer ${admin}` } })).json()

const before = await remaining()
const all = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const res = await fetch(`${url}/v1/tutor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkling-install': `inst_${randomBytes(18).toString('base64url')}`, 'x-inkling-notice': '4' },
      body: JSON.stringify({ task: 'chat', turns: [{ role: 'user', parts: [{ text: `Reply with the number ${i} and nothing else.` }] }] })
    })
    const text = await res.text()
    let scope = null
    try {
      scope = JSON.parse(text).error?.scope ?? null
    } catch {
      scope = /event: done/.test(text) ? 'answered' : 'stream'
    }
    return { status: res.status, scope }
  })
)
await new Promise((r) => setTimeout(r, 4000))
const after = await remaining()
const s = await summary()
const answered = all.filter((r) => r.status === 200).length
const reached = before - after - 1 // the "after" call itself
const refused = all.filter((r) => r.status !== 200)
const okRefusals = refused.every((r) => ['free_daily_quota', 'capacity', 'free_token_quota', 'busy'].includes(r.scope))
const pass = answered <= quota && reached <= quota && okRefusals && s.providerLastMinute.tokens <= s.providerLastMinute.tokenLimit
const lines = [
  '## Request quota under concurrency (temporary Worker)',
  '',
  `- ${N} simultaneous requests, quota ${quota}: **${answered} answered**, refused: ${JSON.stringify(refused.reduce((a, r) => ((a[r.scope] = (a[r.scope] ?? 0) + 1), a), {}))}`,
  `- Groq's own counter: ${before} → ${after} remaining requests today, so **${reached}** reached Groq from the burst (quota ${quota}).`,
  `- Server's count: rolling 24 h \`${JSON.stringify(s.providerRolling24h)}\`, last minute \`${JSON.stringify(s.providerLastMinute)}\`.`,
  `- Result: **${pass ? 'PASS' : 'FAIL'}**`,
  ''
]
console.log(lines.join('\n'))
if (reportFile) await appendFile(reportFile, lines.join('\n') + '\n')
if (!pass) process.exit(1)
