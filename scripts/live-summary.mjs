#!/usr/bin/env node
/**
 * Turns the live cloud-model report (test-results/live-cloud-qwen3.8-27b.json)
 * into GitHub annotations, so the results can be read from the commit's
 * check runs as well as from the uploaded report.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'test-results/live-cloud-qwen3.8-27b.json'
let r
try {
  r = JSON.parse(readFileSync(file, 'utf8'))
} catch {
  console.log('::error title=Live cloud test::No report was written (the test did not run).')
  process.exit(0)
}
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const s = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`)
const lines = []
if (r.probes?.length) {
  lines.push('PROBE (one small check request each):')
  for (const p of r.probes) lines.push(`  ${p.name}: ${p.ok ? `${p.usage?.completion_tokens} out tokens, ${p.reasoningChars} reasoning chars, JSON ${p.validJson ? 'valid' : 'INVALID'}, ${p.neurons?.toFixed(1)} N, ${s(p.ms)}` : `ERROR ${p.error}`}`)
}
console.log(`::notice title=Live cloud: settings probe::${esc(lines.join('\n') || 'no probe')}`)

const rows = r.runs.map((x) => {
  const passed = x.checks.filter((c) => c.pass).length
  return `${x.scenario}/${x.task}: ${x.ok ? 'ok' : `ERROR ${x.error}`} | first ${s(x.firstTokenMs)} total ${s(x.totalMs)} | ${x.inputTokens ?? '?'}→${x.outputTokens ?? '?'} tok | ${x.neurons?.toFixed(1) ?? '?'} N | ${x.validated === undefined ? '' : x.validated ? 'valid ' : 'INVALID '}checks ${passed}/${x.checks.length}`
})
console.log(`::notice title=Live cloud: scenarios (${r.mode})::${esc(rows.join('\n'))}`)

const failed = r.runs.flatMap((x) => x.checks.filter((c) => !c.pass).map((c) => `${x.scenario}/${x.task}: ${c.name}${c.detail ? ` — ${String(c.detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`))
if (failed.length) console.log(`::warning title=Live cloud: ${failed.length} checks failed::${esc(failed.join('\n'))}`)

const done = r.runs.filter((x) => x.ok && x.neurons != null)
const mean = (t) => {
  const v = done.filter((x) => x.task === t).map((x) => x.neurons)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
}
const mix = { chat: 0.6, annotate: 0.25, check: 0.1, practice: 0.05 }
let wsum = 0
let tot = 0
for (const [t, w] of Object.entries(mix)) if (Number.isFinite(mean(t))) ((tot += mean(t) * w), (wsum += w))
const blended = tot / wsum
const total = done.reduce((a, x) => a + x.neurons, 0)
const summary = [
  `Answers: ${done.length}/${r.runs.length}; Neurons used by the run: ${total.toFixed(0)}`,
  ...Object.keys(mix).map((t) => `${t}: mean ${Number.isFinite(mean(t)) ? mean(t).toFixed(1) : '–'} N`),
  `Blended interaction: ${Number.isFinite(blended) ? blended.toFixed(0) : '–'} N → ${Number.isFinite(blended) ? Math.floor(10000 / blended) : '–'} per day on 10,000 free Neurons (${Number.isFinite(blended) ? Math.floor(9000 / blended) : '–'} under the 9,000 cap)`,
  r.quotaBefore && r.quotaAfter ? `Server ledger: tester ${r.quotaBefore.testerUsed}→${r.quotaAfter.testerUsed}, beta ${r.quotaBefore.globalUsed}→${r.quotaAfter.globalUsed}` : ''
]
console.log(`::notice title=Live cloud: allowance::${esc(summary.filter(Boolean).join('\n'))}`)
