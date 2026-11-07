#!/usr/bin/env node
/**
 * Privacy check of the AI server's usage data: it must STRUCTURALLY exclude notebook content.
 *
 * checkUsageReport(value, canaries) walks any JSON (an /admin/summary, the ledger's stored records)
 * and accepts only:
 *   - numbers, booleans, null;
 *   - strings and object keys that are short identifiers: at most 96 characters from
 *     [A-Za-z0-9 _ . : @ / + -], no spaces. Model names, task names, error kinds, dates, units and
 *     salted hashes fit; a sentence, a formula with spaces, notes or a base64 image do not;
 * and fails if any canary string appears anywhere (also inside keys).
 *
 * So the check doesn't depend on guessing which phrases a test used: free text has nowhere to go.
 *
 * CLI (against a deployed TEST Worker, never production; a few cents at most):
 *   node beta-server/scripts/privacy-check.mjs <url> <admin-token>
 * sends canary-filled requests as a notice-4 app (DeepInfra) and, if the bridge is on, as an older
 * app (Workers AI), then checks /admin/summary and /admin/legacy/summary.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const TOKEN = /^[A-Za-z0-9_.:@/+-]{1,96}$/

/** Returns a list of problems (empty = clean). */
export function checkUsageReport(value, canaries = [], path = '$') {
  const problems = []
  const visit = (v, p) => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return
    if (typeof v === 'string') {
      for (const c of canaries) if (c && v.includes(c)) problems.push(`${p}: contains canary ${c.slice(0, 12)}…`)
      if (v !== '' && !TOKEN.test(v)) problems.push(`${p}: free-text string ${JSON.stringify(v.slice(0, 40))}`)
      return
    }
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${p}[${i}]`))
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        for (const c of canaries) if (c && k.includes(c)) problems.push(`${p}: key contains canary`)
        if (!TOKEN.test(k)) problems.push(`${p}: free-text key ${JSON.stringify(k.slice(0, 40))}`)
        visit(x, `${p}.${k}`)
      }
      return
    }
    problems.push(`${p}: unexpected ${typeof v}`)
  }
  visit(value, path)
  return problems
}

/** Distinct, unguessable strings planted in every field a request can carry. */
export function makeCanaries() {
  const c = () => 'CANARY' + randomBytes(9).toString('hex')
  return { question: c(), note: c(), answer: c(), topic: c() }
}

/** A real handwriting photo from the test fixtures (a valid JPEG the provider accepts). */
export const FIXTURE_JPEG = readFileSync(new URL('../../tests/fixtures/handwriting/scenario-b.jpg', import.meta.url)).toString('base64')

/** Requests that carry the canaries in the question, notes, an earlier answer and a practice topic. */
export function canaryRequests(k) {
  return [
    {
      task: 'chat',
      turns: [
        { role: 'user', parts: [{ text: `<notes title="Lab ${k.note}">My lab partner is ${k.note}. Sample 14.0 g.</notes>` }, { text: `Question ${k.question}: how many moles is 14.0 g of N2?` }] },
        { role: 'model', parts: [{ text: `Earlier answer ${k.answer}: 0.5 mol.` }] },
        { role: 'user', parts: [{ image: { mimeType: 'image/jpeg', data: FIXTURE_JPEG } }, { text: `Follow-up ${k.question}: and at STP?` }] }
      ]
    },
    { task: 'practice', turns: [{ role: 'user', parts: [{ text: `Create 1 practice problem at easy difficulty on: ${k.topic} fractions.` }] }] }
  ]
}

async function main() {
  const [url, admin] = process.argv.slice(2)
  if (!url || !admin) {
    console.error('usage: privacy-check.mjs <test-worker-url> <admin-token>')
    process.exit(2)
  }
  if (/inkling-ai-beta\./.test(url)) {
    console.error('refusing to send test requests to production (inkling-ai-beta)')
    process.exit(2)
  }
  const k = makeCanaries()
  const canaries = Object.values(k)
  const ask = async (body, notice) => {
    const headers = { 'content-type': 'application/json', 'x-inkling-install': 'inst_' + randomBytes(16).toString('hex') }
    if (notice) headers['x-inkling-notice'] = notice
    const r = await fetch(`${url}/v1/tutor`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await r.text()
    return { status: r.status, done: /event: done/.test(text), error: /event: error/.test(text) ? text.slice(0, 200) : null }
  }
  const lines = ['## Privacy check (structural)', '', `Canary requests: ${canaryRequests(k).length} as a notice-4 app, ${canaryRequests(k).length} as an older app.`, '']
  const outcomes = []
  for (const body of canaryRequests(k)) outcomes.push(['notice 4', body.task, await ask(body, '4')])
  for (const body of canaryRequests(k)) outcomes.push(['older app', body.task, await ask(body, null)])
  lines.push('| App | Task | HTTP | Answered |', '|---|---|---|---|', ...outcomes.map(([a, t, r]) => `| ${a} | ${t} | ${r.status} | ${r.done ? 'yes' : `no ${r.error ?? ''}`} |`), '')
  let failed = 0
  const get = async (path) => {
    const r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${admin}` } })
    return r.status === 200 ? r.json() : null
  }
  const reports = { '/admin/summary': await get('/admin/summary'), '/admin/legacy/summary': await get('/admin/legacy/summary') }
  for (const [path, body] of Object.entries(reports)) {
    if (!body) {
      lines.push(`- ${path}: not available${path.includes('legacy') ? ' (bridge off)' : ''}`)
      if (!path.includes('legacy')) failed++
      continue
    }
    const problems = checkUsageReport(body, canaries)
    lines.push(`- ${path}: ${problems.length ? `**${problems.length} problem(s)**: ${problems.slice(0, 5).join('; ')}` : 'clean (numbers and identifiers only, no canary)'}`)
    failed += problems.length
  }
  const answered = outcomes.filter(([, , r]) => r.done).length
  lines.push('', `Answered ${answered} of ${outcomes.length}.`)
  if (answered === 0) failed++
  // Which models answered on each path (practice on the bridge should be Gemma, as in production today).
  for (const [path, body] of Object.entries(reports)) if (body?.models?.today) lines.push(`- ${path} models today: ${Object.entries(body.models.today).map(([m, v]) => `${m} (${Object.entries(v.tasks).map(([t, n]) => `${t} ${n}`).join(', ')})`).join('; ')}`)
  console.log(lines.join('\n'))
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
