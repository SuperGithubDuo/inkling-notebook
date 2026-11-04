#!/usr/bin/env node
/**
 * Direct probes of DeepInfra's API with a DEVELOPMENT key, to check what the
 * AI server's adapter assumes against real responses. Costs well under $0.01.
 *
 *   INFERENCE_API_KEY=… node beta-server/scripts/deepinfra-probe.mjs [report.md]
 *
 * Checks:
 *   1. streaming: chunks, time to first text, usage on the last chunk, extra usage fields
 *   2. the thinking switch (chat_template_kwargs.enable_thinking=false) vs model defaults
 *   3. real input tokens of Inkling's handwriting images vs the server's estimate
 *   4. error statuses and bodies (bad key, unknown model, malformed body, oversized
 *      max_tokens) and how the adapter classifies each
 *   5. rate-limit headers, and a burst of 20 tiny concurrent requests
 *
 * Prints no key and no full answers; error bodies are shortened.
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const KEY = (process.env.INFERENCE_API_KEY ?? '').trim()
const BASE = (process.env.UPSTREAM_BASE_URL || 'https://api.deepinfra.com/v1/openai').replace(/\/+$/, '')
const MODEL = process.env.UPSTREAM_MODEL || 'Qwen/Qwen3.8-27B'
const PRICE = { input: Number(process.env.PRICE_INPUT_USD_PER_M ?? 0.2), output: Number(process.env.PRICE_OUTPUT_USD_PER_M ?? 2.5) }
if (!KEY) {
  console.error('INFERENCE_API_KEY is not set')
  process.exit(2)
}

// The server's own modules, so the probe tests the real classification and estimate code.
const out = await build({
  stdin: { contents: `export * from './beta-server/src/provider.ts'\nexport { estimateInputTokens, imageTokens, parseUpstream } from './beta-server/src/upstream.ts'\nexport { taskSpec } from './src/main/ai/prompts.ts'`, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'src/shared') },
  write: false,
  logLevel: 'silent'
})
const dir = await mkdtemp(join(tmpdir(), 'di-probe-'))
await writeFile(join(dir, 'm.mjs'), out.outputFiles[0].text)
const S = await import(pathToFileURL(join(dir, 'm.mjs')).href)

const lines = [`# DeepInfra probe: ${MODEL}`, '', `${new Date().toISOString()} · ${BASE} · list price $${PRICE.input}/$${PRICE.output} per M`, '']
const usd = (u) => (u.prompt_tokens * PRICE.input + u.completion_tokens * PRICE.output) / 1e6
const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
const headersOf = (res) => Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry|x-request|x-robots|cf-ray|server|content-type/i.test(k)))

async function call(body, opts = {}) {
  try {
    return await callOnce(body, opts)
  } catch (err) {
    return { status: 0, headers: {}, totalMs: 0, text: `network error: ${err?.cause?.code ?? err?.message}`, json: null }
  }
}

async function callOnce(body, { key = KEY, stream = body.stream === true } = {}) {
  const started = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body) })
  const headerMs = Date.now() - started
  if (!res.ok || !stream) {
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: headersOf(res), headerMs, totalMs: Date.now() - started, text, json }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let answer = ''
  let reasoning = ''
  let usage = null
  let finish = null
  let chunks = 0
  let firstTextMs = null
  let lastRaw = null
  let malformed = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      if (!data || data === '[DONE]') continue
      let o
      try {
        o = JSON.parse(data)
      } catch {
        malformed++
        continue
      }
      chunks++
      const d = o.choices?.[0]?.delta ?? {}
      if (typeof d.content === 'string' && d.content) {
        firstTextMs ??= Date.now() - started
        answer += d.content
      }
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      if (o.choices?.[0]?.finish_reason) finish = o.choices[0].finish_reason
      if (o.usage) {
        usage = o.usage
        lastRaw = o
      }
    }
  }
  return { status: res.status, headers: headersOf(res), headerMs, firstTextMs, totalMs: Date.now() - started, answer, reasoning, usage, finish, chunks, malformed, lastRaw }
}

const sys = S.taskSpec('chat', 'cloud').system
const check = S.taskSpec('check', 'cloud')
const results = {}

// ---- 1 + 2: streaming and thinking
lines.push('## Streaming and the thinking switch', '', '| Settings | Status | Chunks | First text | Total | Tokens in → out | Reasoning chars | Finish | Cost at list | Answer (start) |', '|---|---|---|---|---|---|---|---|---|---|')
const q = [{ role: 'system', content: sys }, { role: 'user', content: 'Factor x^2+5x+6 and give the roots. Keep it short.' }]
const variants = [
  ['thinking off (what the server sends)', { chat_template_kwargs: { enable_thinking: false } }],
  ['reasoning_effort low only', { reasoning_effort: 'low' }],
  ['model defaults', {}]
]
for (const [name, extra] of variants) {
  const r = await call({ model: MODEL, messages: q, max_tokens: 900, temperature: 0.4, stream: true, stream_options: { include_usage: true }, ...extra })
  results[name] = r
  const u = r.usage
  lines.push(`| ${name} | ${r.status} | ${r.chunks ?? '–'} | ${r.firstTextMs ?? '–'} ms | ${r.totalMs} ms | ${u ? `${u.prompt_tokens} → ${u.completion_tokens}` : 'none'} | ${r.reasoning?.length ?? 0} | ${r.finish ?? '–'} | ${u ? `$${usd(u).toFixed(6)}` : '–'} | ${short(r.answer ?? r.text, 70)} |`)
}
const off = results['thinking off (what the server sends)']
lines.push('', `Usage object on the last chunk (thinking off): \`${JSON.stringify(off.usage)}\``)
lines.push(`Extra fields DeepInfra reports: ${off.usage ? Object.keys(off.usage).filter((k) => !['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(k)).join(', ') || 'none' : '–'}. Malformed SSE lines: ${off.malformed ?? '–'}.`, '')

// ---- 3: image tokens vs the server's estimate
lines.push('## Image input: real tokens vs the server\'s estimate', '', '| Image | Estimated input | Real input | Ratio real/estimate | Output | Cost at list |', '|---|---|---|---|---|---|')
for (const name of ['scenario-a.jpg', 'scenario-b.jpg', 'scenario-c.jpg']) {
  const data = (await readFile(join(root, 'tests/fixtures/handwriting', name))).toString('base64')
  const turns = [{ role: 'user', parts: [{ text: 'Is this right? Answer in one sentence.' }, { image: { mimeType: 'image/jpeg', data } }] }]
  const est = S.estimateInputTokens(sys, turns, 28)
  const r = await call({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: 'Is this right? Answer in one sentence.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }] }], max_tokens: 200, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } })
  const u = r.usage
  results[`img-${name}`] = { est, u, status: r.status }
  lines.push(`| ${name} | ${est} | ${u?.prompt_tokens ?? `status ${r.status}`} | ${u ? (u.prompt_tokens / est).toFixed(2) : '–'} | ${u?.completion_tokens ?? '–'} | ${u ? `$${usd(u).toFixed(6)}` : '–'} |`)
}
lines.push('')

// ---- 3b: structured answer (check task, schema in the prompt)
{
  const r = await call({ model: MODEL, messages: [{ role: 'system', content: check.system }, { role: 'user', content: 'Problem: Solve 2x+3=11. Expected answer: x=4. Student answer: x = 4' }], max_tokens: check.maxOutputTokens, temperature: 0.2, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } })
  let valid = false
  try {
    const j = JSON.parse(r.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    valid = ['correct', 'partially_correct', 'incorrect', 'unreadable'].includes(j.verdict) && typeof j.feedback === 'string'
  } catch {
    valid = false
  }
  results.check = { valid, usage: r.usage, ms: r.totalMs }
  lines.push('## Structured answer (check task)', '', `Status ${r.status}, ${r.totalMs} ms, tokens ${r.usage?.prompt_tokens} → ${r.usage?.completion_tokens}, valid JSON verdict: **${valid ? 'yes' : 'NO'}** (\`${short(r.answer, 120)}\`).`, '')
}

// ---- 4: errors and their classification
lines.push('## Errors and how the adapter classifies them', '', '| Case | HTTP | Retry-After | Adapter kind | Retried by adapter? | Body (start) |', '|---|---|---|---|---|---|')
const retryable = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])
const cases = [
  ['invalid API key', { model: MODEL, messages: q, max_tokens: 5 }, { key: 'invalid-key-0000000000000000' }],
  ['unknown model', { model: 'Qwen/Not-A-Model-27B', messages: q, max_tokens: 5 }, {}],
  ['malformed body (no messages)', { model: MODEL, max_tokens: 5 }, {}],
  ['messages not an array', { model: MODEL, messages: 'hi', max_tokens: 5 }, {}],
  ['max_tokens above the model limit', { model: MODEL, messages: q, max_tokens: 10_000_000 }, {}]
]
results.errors = []
for (const [name, body, opts] of cases) {
  const r = await call(body, { ...opts, stream: false })
  const kind = r.status >= 200 && r.status < 300 ? '(accepted)' : S.kindOfStatus(r.status, r.text.slice(0, 500))
  results.errors.push({ name, status: r.status, kind })
  lines.push(`| ${name} | ${r.status} | ${r.headers['retry-after'] ?? '–'} | ${kind} | ${retryable.has(r.status) ? 'yes' : 'no'} | ${short(r.json?.error?.message ?? (r.json?.detail !== undefined ? JSON.stringify(r.json.detail) : r.text), 90).replace(/\|/g, '/')} |`)
}
lines.push('')

// ---- 5: rate-limit headers and a small burst
{
  const n = 20
  const started = Date.now()
  const all = await Promise.all(Array.from({ length: n }, (_, i) => call({ model: MODEL, messages: [{ role: 'user', content: `Reply with the number ${i}.` }], max_tokens: 8, stream: false, chat_template_kwargs: { enable_thinking: false } })))
  const statuses = all.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
  const lat = all.map((r) => r.totalMs).sort((a, b) => a - b)
  const cost = all.reduce((s, r) => s + (r.json?.usage ? usd(r.json.usage) : 0), 0)
  results.burst = { n, statuses, p50: lat[Math.floor(n / 2)], p95: lat[Math.floor(n * 0.95)], wall: Date.now() - started, cost, headers: all[0].headers, usageExample: all[0].json?.usage }
  lines.push('## Rate limits', '', `Burst of ${n} concurrent tiny requests: statuses ${JSON.stringify(statuses)}, latency p50 ${results.burst.p50} ms, p95 ${results.burst.p95} ms, wall ${results.burst.wall} ms, cost $${cost.toFixed(6)}.`)
  lines.push(`Response headers seen: \`${JSON.stringify(all[0].headers)}\`. Non-stream usage object: \`${JSON.stringify(all[0].json?.usage)}\`.`, '')
}

const total = Object.values(results).reduce((s, r) => s + (r?.usage ? usd(r.usage) : 0) + (r?.u ? usd(r.u) : 0), 0) + (results.burst?.cost ?? 0)
lines.push(`Probe spend at list price: about $${total.toFixed(4)}.`)
const file = process.argv[2] ?? join(root, 'test-results', 'deepinfra-probe.md')
await writeFile(file, lines.join('\n') + '\n')
await writeFile(file.replace(/\.md$/, '.json'), JSON.stringify(results, (k, v) => (k === 'answer' || k === 'reasoning' || k === 'text' ? undefined : v), 2))
console.log(lines.join('\n'))
