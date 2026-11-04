#!/usr/bin/env node
/**
 * Direct probes of OpenRouter's FREE Qwen 3.8 27B endpoint (qwen/qwen3.8-27b:free)
 * with a development key, to check what the AI server assumes. Free requests only,
 * every one with a zero price ceiling; the account's credits are read before and
 * after to show whether any were consumed.
 *
 *   OPENROUTER_API_KEY=… node beta-server/scripts/openrouter-free-probe.mjs [report.md]
 *
 * Checks: the endpoint's public metadata (host, context, output cap, parameters,
 * modalities, status) and the host's data policy as OpenRouter reports it; the
 * account's free-request counter and credits; streaming and the reasoning switch;
 * real image tokens; a structured answer; a long conversation; data_collection
 * deny vs allow; error statuses; a burst past the per-minute limit (only when the
 * daily allowance is 1,000). Prints no key; answers are shortened.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const KEY = (process.env.OPENROUTER_API_KEY ?? '').trim()
const BASE = 'https://openrouter.ai/api/v1'
const MODEL = process.env.UPSTREAM_MODEL || 'qwen/qwen3.8-27b:free'
const BURST = process.argv.includes('--no-burst') ? 0 : Number(process.env.BURST ?? 26)
if (!KEY) {
  console.error('OPENROUTER_API_KEY is not set')
  process.exit(2)
}
const lines = [`# OpenRouter Free probe: ${MODEL}`, '', `${new Date().toISOString()}`, '']
const results = {}
const short = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
const auth = { authorization: `Bearer ${KEY}` }
const getJson = async (path, withKey = true) => {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: withKey ? auth : {} })
    return { status: r.status, json: await r.json().catch(() => null) }
  } catch (e) {
    return { status: 0, json: null, error: String(e?.cause?.code ?? e?.message) }
  }
}
const ZERO = { prompt: 0, completion: 0, request: 0, image: 0 }
const body = (extra = {}) => ({ model: MODEL, max_tokens: 400, temperature: 0.4, stream: true, reasoning: { enabled: false }, provider: { allow_fallbacks: false, max_price: ZERO, data_collection: 'deny' }, ...extra })

async function call(b, { stream = b.stream === true } = {}) {
  const started = Date.now()
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-title': 'Inkling (probe)' }, body: JSON.stringify(b) })
  } catch (e) {
    return { status: 0, text: `network: ${e?.cause?.code ?? e?.message}`, ms: Date.now() - started, headers: {} }
  }
  const headers = Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry-after|x-generation|content-type/i.test(k)))
  if (!res.ok || !stream) {
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers, json, text, ms: Date.now() - started }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const out = { status: res.status, headers, chunks: 0, answer: '', reasoning: '', usage: null, id: null, provider: null, finish: null, firstTextMs: null, errorEvent: null }
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
        continue
      }
      out.chunks++
      if (o.error) out.errorEvent = o.error
      out.id ??= o.id
      out.provider ??= o.provider
      const d = o.choices?.[0]?.delta ?? {}
      if (d.content) {
        out.firstTextMs ??= Date.now() - started
        out.answer += d.content
      }
      if (d.reasoning) out.reasoning += d.reasoning
      if (o.choices?.[0]?.finish_reason) out.finish = o.choices[0].finish_reason
      if (o.usage) out.usage = o.usage
    }
  }
  out.ms = Date.now() - started
  return out
}

// ---------------------------------------------------------------- endpoint metadata
const eps = await getJson(`/models/${MODEL}/endpoints`, false)
const model = await getJson(`/models`, false)
const m = model.json?.data?.find((x) => x.id === MODEL)
results.endpoints = eps.json?.data
lines.push('## The free endpoint (OpenRouter metadata)', '')
lines.push(`- Listed: **${m ? 'yes' : 'NO'}**; modalities in: ${m?.architecture?.input_modalities?.join(', ') ?? '–'}; context ${m?.context_length ?? '–'}; pricing ${JSON.stringify(m?.pricing ?? {})}; expiration ${m?.expiration_date ?? 'none stated'}.`)
for (const e of eps.json?.data?.endpoints ?? []) {
  lines.push(`- Endpoint **${e.provider_name}** (${e.tag ?? e.name}): status ${e.status}, uptime 30 min ${e.uptime_last_30m ?? '–'}, context ${e.context_length}, max output ${e.max_completion_tokens ?? '–'}, max prompt ${e.max_prompt_tokens ?? '–'}, quantization ${e.quantization ?? '–'}, pricing ${JSON.stringify(e.pricing)}.`)
  lines.push(`  - Supported parameters: ${(e.supported_parameters ?? []).join(', ')}`)
  const policy = Object.fromEntries(Object.entries(e).filter(([k]) => /data|polic|train|retent|log|privacy|zdr/i.test(k)))
  lines.push(`  - Data policy fields: \`${JSON.stringify(policy)}\``)
}
const providers = await getJson('/providers', false)
const names = new Set((eps.json?.data?.endpoints ?? []).map((e) => e.provider_name))
for (const p of providers.json?.data ?? []) {
  if (!names.has(p.name)) continue
  results.provider = p
  lines.push(`- Host policy (OpenRouter /providers): \`${JSON.stringify(p)}\``)
}
lines.push('')

// ---------------------------------------------------------------- account
const key0 = await getJson('/key')
const credits0 = await getJson('/credits')
results.key = key0.json?.data
lines.push('## Account', '', `- Key: \`${JSON.stringify(Object.fromEntries(Object.entries(key0.json?.data ?? {}).filter(([k]) => !/label|hash|name/i.test(k))))}\``)
lines.push(`- Credits before: \`${JSON.stringify(credits0.json?.data ?? credits0.json)}\``, '')
const dailyLimit = key0.json?.data?.free_model_daily_requests?.limit

// ---------------------------------------------------------------- streaming + reasoning
const sys = 'You are Inkling\'s AI tutor. Be warm, precise and brief. Write mathematics in LaTeX with $...$.'
const q = [{ role: 'system', content: sys }, { role: 'user', content: 'Factor x^2+5x+6 and give the roots. Keep it short.' }]
lines.push('## Streaming and reasoning', '', '| Settings | HTTP | Host | Chunks | First text | Total | Tokens in → out | Reasoning chars | Cost reported | Answer (start) |', '|---|---|---|---|---|---|---|---|---|---|')
for (const [name, extra] of [
  ['reasoning off (what the server sends)', { reasoning: { enabled: false } }],
  ['reasoning effort low', { reasoning: { effort: 'low' } }],
  ['model default', { reasoning: undefined }]
]) {
  const r = await call(body({ messages: q, ...extra }))
  results[`stream:${name}`] = { status: r.status, usage: r.usage, ms: r.ms, firstTextMs: r.firstTextMs, chunks: r.chunks, provider: r.provider, reasoningChars: r.reasoning?.length, error: r.json?.error ?? r.errorEvent }
  lines.push(`| ${name} | ${r.status} | ${r.provider ?? '–'} | ${r.chunks ?? '–'} | ${r.firstTextMs ?? '–'} ms | ${r.ms} ms | ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens}` : '–'} | ${r.reasoning?.length ?? 0} | ${r.usage?.cost ?? '–'} | ${short(r.answer || r.json?.error?.message || r.text, 70).replace(/\|/g, '/')} |`)
}
lines.push('')

// ---------------------------------------------------------------- images
lines.push('## Images (Inkling’s handwriting fixtures)', '', '| Image | HTTP | Tokens in → out | First text | Total | Answer (start) |', '|---|---|---|---|---|---|')
for (const name of ['scenario-a.jpg', 'scenario-b.jpg', 'scenario-c.jpg']) {
  const data = (await readFile(join(root, 'tests/fixtures/handwriting', name))).toString('base64')
  const r = await call(body({ messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: 'What is written here, and is it right? Two sentences.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }] }] }))
  results[`image:${name}`] = { status: r.status, usage: r.usage, ms: r.ms, error: r.json?.error ?? r.errorEvent }
  lines.push(`| ${name} | ${r.status} | ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens}` : '–'} | ${r.firstTextMs ?? '–'} ms | ${r.ms} ms | ${short(r.answer || r.json?.error?.message || r.text, 80).replace(/\|/g, '/')} |`)
}
lines.push('')

// ---------------------------------------------------------------- long conversation
{
  const filler = 'The student wrote a long page of working about quadratic equations, discriminants and completing the square. '.repeat(250)
  const turns = [{ role: 'system', content: sys }, { role: 'user', content: `<page>${filler}</page> Summarise what the page is about in one sentence.` }, { role: 'assistant', content: 'It is about solving quadratics.' }, { role: 'user', content: 'And which method is mentioned last? One sentence.' }]
  const r = await call(body({ messages: turns }))
  results.long = { status: r.status, usage: r.usage, ms: r.ms, error: r.json?.error ?? r.errorEvent }
  lines.push('## A longer conversation', '', `HTTP ${r.status}, ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens} tokens` : 'no usage'}, ${r.ms} ms: ${short(r.answer || r.json?.error?.message || r.text, 120)}`, '')
}

// ---------------------------------------------------------------- structured answer
{
  const r = await call(body({ messages: [{ role: 'system', content: `${sys}\nJudge the answer. Reply with one JSON object and nothing else: {"verdict":"correct|partially_correct|incorrect|unreadable","transcription":"…","feedback":"…"}` }, { role: 'user', content: 'Problem: Solve 2x+3=11. Expected: x=4. Student: x = 4' }] }))
  let valid = false
  try {
    valid = ['correct', 'partially_correct', 'incorrect', 'unreadable'].includes(JSON.parse(r.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')).verdict)
  } catch {
    valid = false
  }
  results.check = { status: r.status, valid, usage: r.usage, ms: r.ms }
  lines.push('## Structured answer', '', `HTTP ${r.status}, valid JSON verdict: **${valid ? 'yes' : 'NO'}**, ${r.ms} ms (\`${short(r.answer || r.text, 100)}\`)`, '')
}

// ---------------------------------------------------------------- data policy routing
lines.push('## Data-policy routing', '', '| provider.data_collection | HTTP | Result |', '|---|---|---|')
for (const dc of ['deny', 'allow']) {
  // 'allow' only to explain a refusal under 'deny' (a neutral test prompt; Inkling never sends 'allow').
  if (dc === 'allow' && results['dc:deny']?.status === 200) {
    lines.push('| allow | – | not tried: deny already answered |')
    continue
  }
  const r = await call(body({ messages: dc === 'allow' ? [{ role: 'user', content: 'Reply with OK.' }] : q, stream: false, max_tokens: 20, provider: { allow_fallbacks: false, max_price: ZERO, data_collection: dc } }), { stream: false })
  results[`dc:${dc}`] = { status: r.status, error: r.json?.error }
  lines.push(`| ${dc} | ${r.status} | ${short(r.json?.error?.message ?? (r.json?.choices ? `answered by ${r.json.provider ?? '?'}` : r.text), 110).replace(/\|/g, '/')} |`)
}
lines.push('')

// ---------------------------------------------------------------- generation record (cost, host)
const gid = Object.values(results).find((r) => r?.status === 200)?.id
{
  const s = await call(body({ messages: q, max_tokens: 30 }))
  await new Promise((r) => setTimeout(r, 3000))
  const g = s.id ? await getJson(`/generation?id=${encodeURIComponent(s.id)}`) : null
  const gd = g?.json?.data
  results.generation = gd ? { provider_name: gd.provider_name, total_cost: gd.total_cost, usage: gd.usage, is_byok: gd.is_byok, native_tokens_prompt: gd.native_tokens_prompt, native_tokens_completion: gd.native_tokens_completion } : g
  lines.push('## Generation record', '', `\`${JSON.stringify(results.generation)}\``, '')
  void gid
}

// ---------------------------------------------------------------- errors
lines.push('## Errors', '', '| Case | HTTP | Body (start) |', '|---|---|---|')
for (const [name, b, key] of [
  ['invalid key', body({ messages: q, stream: false, max_tokens: 5 }), 'sk-or-invalid-000000000000000000000'],
  ['paid model under a zero price ceiling', body({ model: 'qwen/qwen3.8-27b', messages: q, stream: false, max_tokens: 5 }), null],
  ['unknown free model', body({ model: 'qwen/not-a-model:free', messages: q, stream: false, max_tokens: 5 }), null]
]) {
  let r
  if (key) {
    const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
    r = { status: res.status, text: await res.text() }
  } else r = await call(b, { stream: false })
  results[`err:${name}`] = { status: r.status }
  lines.push(`| ${name} | ${r.status} | ${short(r.text, 120).replace(/\|/g, '/')} |`)
}
lines.push('')

// ---------------------------------------------------------------- per-minute burst
if (BURST > 0 && dailyLimit >= 1000) {
  const started = Date.now()
  const all = await Promise.all(Array.from({ length: BURST }, (_, i) => call(body({ messages: [{ role: 'user', content: `Reply with the number ${i}.` }], stream: false, max_tokens: 5 }), { stream: false })))
  const statuses = all.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})
  const limited = all.find((r) => r.status === 429)
  results.burst = { n: BURST, statuses, ms: Date.now() - started, headers429: limited?.headers, body429: limited?.json?.error }
  lines.push('## Per-minute limit', '', `${BURST} concurrent tiny requests: ${JSON.stringify(statuses)} in ${Date.now() - started} ms. A 429's headers: \`${JSON.stringify(limited?.headers ?? {})}\`, body: \`${short(JSON.stringify(limited?.json?.error ?? null), 200)}\``, '')
} else lines.push('## Per-minute limit', '', `Skipped (daily free limit ${dailyLimit ?? 'unknown'}: a burst would use too much of it).`, '')

// ---------------------------------------------------------------- account after
const key1 = await getJson('/key')
const credits1 = await getJson('/credits')
results.keyAfter = key1.json?.data
results.creditsBefore = credits0.json?.data
results.creditsAfter = credits1.json?.data
lines.push('## Account after', '', `- Free requests today: before \`${JSON.stringify(key0.json?.data?.free_model_daily_requests)}\` → after \`${JSON.stringify(key1.json?.data?.free_model_daily_requests)}\``)
lines.push(`- Credits: before \`${JSON.stringify(credits0.json?.data)}\` → after \`${JSON.stringify(credits1.json?.data)}\` (usage changed: **${JSON.stringify(credits0.json?.data?.total_usage) === JSON.stringify(credits1.json?.data?.total_usage) ? 'no' : 'YES'}**)`, '')

const remaining = key1.json?.data?.free_model_daily_requests?.remaining
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(process.env.GITHUB_OUTPUT, `free_remaining=${remaining ?? 0}\nfree_limit=${key1.json?.data?.free_model_daily_requests?.limit ?? 0}\ndeny_ok=${results['dc:deny']?.status === 200}\n`)
}
const file = process.argv.find((a) => a.endsWith('.md')) ?? join(root, 'test-results', 'openrouter-free-probe.md')
await writeFile(file, lines.join('\n') + '\n')
await writeFile(file.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2))
console.log(lines.join('\n'))
