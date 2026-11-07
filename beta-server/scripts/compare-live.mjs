#!/usr/bin/env node
/**
 * Side-by-side report of two live runs of the same scenarios (tests/live/cloud.live.test.ts):
 * DeepInfra (through the test Worker, cost in µ$) against Workers AI (cost in Neurons).
 *
 *   node beta-server/scripts/compare-live.mjs <deepinfra.json> <workers-ai.json> <out.md> [summary.json]
 *
 * `summary.json` (optional) is the test Worker's /admin/summary after the run: it adds what
 * DeepInfra itself reported charging (usage.estimated_cost) next to what the ledger counted.
 *
 * Workers AI Neurons are priced at Cloudflare's paid rate, $0.011 per 1,000 Neurons, for a
 * like-for-like dollar figure (on the free plan they cost nothing, up to 10,000 a day).
 * Reads only counts, timings and check results; answer text is shown only as check details.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [diPath, waiPath, out, summaryPath] = process.argv.slice(2)
if (!diPath || !waiPath || !out) {
  console.error('usage: compare-live.mjs <deepinfra.json> <workers-ai.json> <out.md> [summary.json]')
  process.exit(2)
}
const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const di = read(diPath)
const wai = read(waiPath)
const summary = summaryPath ? read(summaryPath) : null
const USD_PER_NEURON = 0.011 / 1000

const med = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const p95 = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)] : null
}
const sum = (xs) => xs.reduce((n, x) => n + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0)
const s = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`)
const usd = (x) => (x == null ? '–' : `$${x.toFixed(5)}`)

/** One row per scenario: answers, checks passed, timings, tokens, cost in dollars. */
function byScenario(report, dollarsPerUnit) {
  const rows = new Map()
  for (const r of report?.runs ?? []) {
    const row = rows.get(r.scenario) ?? { answers: 0, failed: 0, checks: 0, passed: 0, first: [], total: [], input: 0, output: 0, cost: 0 }
    if (r.ok) row.answers++
    else row.failed++
    row.checks += r.checks.length
    row.passed += r.checks.filter((c) => c.pass).length
    row.first.push(r.firstTokenMs)
    row.total.push(r.totalMs)
    row.input += r.inputTokens ?? 0
    row.output += r.outputTokens ?? 0
    row.cost += (r.neurons ?? 0) * dollarsPerUnit
    rows.set(r.scenario, row)
  }
  return rows
}
// DeepInfra runs report µ$ (unit "usd") in the `neurons` field; Workers AI reports Neurons.
const diRows = byScenario(di, 1e-6)
const waiRows = byScenario(wai, USD_PER_NEURON)
const names = [...new Set([...diRows.keys(), ...waiRows.keys()])].sort()

const lines = ['# Live comparison: DeepInfra vs Workers AI, Qwen 3.8 27B', '']
lines.push(`DeepInfra run: ${di ? `${di.at} · ${di.mode}` : '**missing**'}  `)
lines.push(`Workers AI run: ${wai ? `${wai.at} · ${wai.mode}` : '**missing**'}`, '')
lines.push('Workers AI dollars are its Neurons at the paid rate ($0.011 per 1,000); on the free plan they cost $0 up to 10,000 Neurons a day. DeepInfra dollars are what the ledger charged: the higher of list price ($0.20 / $2.50 per million) and DeepInfra’s own reported cost.', '')
lines.push('| Scenario | Checks DI | Checks WAI | First text DI / WAI (median) | Total DI / WAI (median) | Tokens in→out DI | Tokens in→out WAI | Cost DI | Cost WAI |', '|---|---|---|---|---|---|---|---|---|')
for (const n of names) {
  const a = diRows.get(n)
  const b = waiRows.get(n)
  lines.push(
    `| ${n} | ${a ? `${a.passed}/${a.checks}${a.failed ? ` (${a.failed} failed)` : ''}` : '–'} | ${b ? `${b.passed}/${b.checks}${b.failed ? ` (${b.failed} failed)` : ''}` : '–'} | ${s(med(a?.first ?? []))} / ${s(med(b?.first ?? []))} | ${s(med(a?.total ?? []))} / ${s(med(b?.total ?? []))} | ${a ? `${a.input}→${a.output}` : '–'} | ${b ? `${b.input}→${b.output}` : '–'} | ${usd(a?.cost)} | ${usd(b?.cost)} |`
  )
}
const all = (rows) => [...rows.values()]
const totals = (rows) => {
  const v = all(rows)
  const answers = sum(v.map((r) => r.answers))
  const cost = sum(v.map((r) => r.cost))
  return {
    answers,
    failed: sum(v.map((r) => r.failed)),
    checks: `${sum(v.map((r) => r.passed))}/${sum(v.map((r) => r.checks))}`,
    first: med(v.flatMap((r) => r.first)),
    firstP95: p95(v.flatMap((r) => r.first)),
    total: med(v.flatMap((r) => r.total)),
    totalP95: p95(v.flatMap((r) => r.total)),
    input: answers ? Math.round(sum(v.map((r) => r.input)) / answers) : null,
    output: answers ? Math.round(sum(v.map((r) => r.output)) / answers) : null,
    cost,
    perAnswer: answers ? cost / answers : null
  }
}
const A = totals(diRows)
const B = totals(waiRows)
lines.push('', '## Totals', '', '| | DeepInfra | Workers AI |', '|---|---|---|')
lines.push(`| Answers (failed) | ${A.answers} (${A.failed}) | ${B.answers} (${B.failed}) |`)
lines.push(`| Quality checks passed | ${A.checks} | ${B.checks} |`)
lines.push(`| First text, median / p95 | ${s(A.first)} / ${s(A.firstP95)} | ${s(B.first)} / ${s(B.firstP95)} |`)
lines.push(`| Whole answer, median / p95 | ${s(A.total)} / ${s(A.totalP95)} | ${s(B.total)} / ${s(B.totalP95)} |`)
lines.push(`| Mean tokens per answer, in → out | ${A.input ?? '–'} → ${A.output ?? '–'} | ${B.input ?? '–'} → ${B.output ?? '–'} |`)
lines.push(`| Total cost | ${usd(A.cost)} | ${usd(B.cost)} (paid rate) |`)
lines.push(`| Cost per answer | ${usd(A.perAnswer)} | ${usd(B.perAnswer)} (paid rate) |`)

if (summary) {
  const models = summary.models?.today ?? {}
  lines.push('', '## What DeepInfra reported charging vs what the ledger counted', '', '| Model | Answers | Errors | Ledger charged | DeepInfra reported (answers with a figure) | Overshoots |', '|---|---|---|---|---|---|')
  for (const [m, v] of Object.entries(models)) {
    lines.push(`| ${m} | ${v.requests - v.errors} | ${v.errors} ${Object.keys(v.errorKinds ?? {}).length ? JSON.stringify(v.errorKinds) : ''} | ${usd(v.neurons / 1e6)} | ${v.providerReported != null ? `${usd(v.providerReported / 1e6)} (${v.providerReportedAnswers})` : 'not reported'} | ${summary.overshoot?.count ?? 0} |`)
  }
  lines.push('', 'Failed requests are in the Errors column with their kind; what they cost is included in "Ledger charged" (nothing for refusals before the model ran, the input for timed-out attempts, the full reservation for lost streams).')
}

// Every failed check, with its detail, so a reader can judge quality differences.
const failures = (report, label) =>
  (report?.runs ?? []).flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- ${label} ${r.scenario}/${r.task}: ${c.name}${c.detail ? ` — ${String(c.detail).slice(0, 160).replace(/\n/g, ' ')}` : ''}`))
const f = [...failures(di, 'DeepInfra'), ...failures(wai, 'Workers AI')]
lines.push('', '## Failed checks', '', ...(f.length ? f : ['None.']))
writeFileSync(out, lines.join('\n') + '\n')
console.log(lines.join('\n'))
