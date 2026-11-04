#!/usr/bin/env node
/**
 * Direct probes of Groq's FREE plan for Qwen 3.8 27B (qwen/qwen3.8-27b) with a
 * development key, to check what the AI server assumes. Never asks for a paid tier
 * (service_tier is always "on_demand", except one probe that confirms "flex" is
 * refused on the free plan); never sends a payment method or changes the account.
 *
 *   GROQ_API_KEY=… node beta-server/scripts/groq-probe.mjs [report.md]
 *
 * Checks: the model listing; the account's limits as Groq's headers report them
 * (free plan: 1,000 requests a day, 8,000 tokens a minute); streaming, where usage
 * arrives, first-token latency and speed; the reasoning switch; real image tokens;
 * a structured answer; whether the per-minute TOKEN limit counts max_completion_tokens
 * at admission; quality samples on tutor questions; error statuses; a burst past 30
 * requests a minute. Prints no key; answers are shortened. Uses about 70 of the day's
 * 1,000 requests and roughly 40,000 of its 200,000 tokens.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const KEY = (process.env.GROQ_API_KEY ?? '').trim()
const BASE = 'https://api.groq.com/openai/v1'
const MODEL = process.env.UPSTREAM_MODEL || 'qwen/qwen3.8-27b'
const BURST = process.argv.includes('--no-burst') ? 0 : Number(process.env.BURST ?? 34)
if (!KEY) {
  console.error('GROQ_API_KEY is not set')
  process.exit(2)
}
const lines = [`# Groq free-plan probe: ${MODEL}`, '', `${new Date().toISOString()}`, '']
const results = {}
const short = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
const cell = (s, n) => short(s, n).replace(/\|/g, '/')
const auth = { authorization: `Bearer ${KEY}` }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (h) => Object.fromEntries([...h].filter(([k]) => /ratelimit|retry-after|x-groq|content-type|x-request-id/i.test(k)))
const getJson = async (path) => {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: auth })
    return { status: r.status, json: await r.json().catch(() => null), headers: pick(r.headers) }
  } catch (e) {
    return { status: 0, json: null, error: String(e?.cause?.code ?? e?.message) }
  }
}
const body = (extra = {}) => ({ model: MODEL, max_completion_tokens: 400, temperature: 0.4, stream: true, stream_options: { include_usage: true }, service_tier: 'on_demand', reasoning_format: 'parsed', ...extra })

async function call(b, { stream = b.stream === true, key = KEY } = {}) {
  const started = Date.now()
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
  } catch (e) {
    return { status: 0, text: `network: ${e?.cause?.code ?? e?.message}`, ms: Date.now() - started, headers: {} }
  }
  const headers = pick(res.headers)
  if (!res.ok || !stream) {
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers, json, text, ms: Date.now() - started, usage: json?.usage, answer: json?.choices?.[0]?.message?.content ?? '', reasoning: json?.choices?.[0]?.message?.reasoning ?? '' }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const out = { status: res.status, headers, chunks: 0, answer: '', reasoning: '', usage: null, usageWhere: null, id: null, finish: null, firstTextMs: null, errorEvent: null, serviceTier: null }
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
      out.serviceTier ??= o.service_tier ?? null
      const d = o.choices?.[0]?.delta ?? {}
      if (d.content) {
        out.firstTextMs ??= Date.now() - started
        out.answer += d.content
      }
      if (d.reasoning) out.reasoning += d.reasoning
      if (o.choices?.[0]?.finish_reason) out.finish = o.choices[0].finish_reason
      if (o.usage) {
        out.usage = o.usage
        out.usageWhere = 'usage'
      } else if (o.x_groq?.usage) {
        out.usage = o.x_groq.usage
        out.usageWhere = 'x_groq.usage'
      }
    }
  }
  out.ms = Date.now() - started
  return out
}
const tokS = (r) => (r.usage?.completion_tokens && r.firstTextMs !== null ? (r.usage.completion_tokens / Math.max(0.001, (r.ms - r.firstTextMs) / 1000)).toFixed(0) : '–')

// ---------------------------------------------------------------- model listing
const list = await getJson('/models')
const m = list.json?.data?.find((x) => x.id === MODEL)
const one = await getJson(`/models/${encodeURIComponent(MODEL)}`)
results.model = m ?? one.json
lines.push('## The model (Groq /models)', '')
lines.push(`- Listed: **${m ? 'yes' : 'NO'}** (HTTP ${list.status}); \`${JSON.stringify(m ?? one.json ?? null)}\``)
lines.push(`- Models on this key: ${(list.json?.data ?? []).map((x) => x.id).sort().join(', ') || '–'}`, '')

// ---------------------------------------------------------------- streaming + reasoning
const sys = "You are Inkling's AI tutor for students. Be warm, precise and brief. Guide with hints before giving full solutions. Write mathematics in LaTeX with $...$."
const q = [{ role: 'system', content: sys }, { role: 'user', content: 'Factor x^2+5x+6 and give the roots. Keep it short.' }]
lines.push('## Streaming and reasoning', '', '| Settings | HTTP | Tier | Chunks | First text | Total | Output tok/s | Tokens in → out | Usage reported in | Reasoning chars | Answer (start) |', '|---|---|---|---|---|---|---|---|---|---|---|')
for (const [name, extra] of [
  ['no reasoning_effort (what the server sends)', {}],
  ['reasoning_effort none', { reasoning_effort: 'none' }],
  ['reasoning_effort low', { reasoning_effort: 'low' }],
  ['reasoning_effort default', { reasoning_effort: 'default' }]
]) {
  const r = await call(body({ messages: q, ...extra }))
  results[`stream:${name}`] = { status: r.status, usage: r.usage, usageWhere: r.usageWhere, ms: r.ms, firstTextMs: r.firstTextMs, chunks: r.chunks, reasoningChars: r.reasoning?.length, tier: r.serviceTier, headers: r.headers, error: r.json?.error ?? r.errorEvent }
  lines.push(`| ${name} | ${r.status} | ${r.serviceTier ?? '–'} | ${r.chunks ?? '–'} | ${r.firstTextMs ?? '–'} ms | ${r.ms} ms | ${tokS(r)} | ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens}` : '–'} | ${r.usageWhere ?? '–'} | ${r.reasoning?.length ?? 0} | ${cell(r.answer || r.json?.error?.message || r.text, 70)} |`)
}
lines.push('')

// ---------------------------------------------------------------- account limits from headers
const h = results['stream:no reasoning_effort (what the server sends)']?.headers ?? {}
const rpd = Number(h['x-ratelimit-limit-requests'])
const tpm = Number(h['x-ratelimit-limit-tokens'])
results.limits = h
const freePlan = rpd > 0 && rpd <= 1000 && tpm > 0 && tpm <= 8000
lines.push('## Account limits (Groq response headers)', '', `\`${JSON.stringify(h)}\``, '', `- Requests per day: **${rpd || '?'}**; tokens per minute: **${tpm || '?'}** → ${freePlan ? '**free-plan limits** (no paid tier on this account)' : '**NOT the documented free-plan limits — check the account plan before going further**'}`, '')

// ---------------------------------------------------------------- does the TPM limit count max_completion_tokens?
{
  await sleep(61_000) // a fresh minute for a clean reading
  const before = await call(body({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_completion_tokens: 5 }), { stream: false })
  const big = await call(body({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_completion_tokens: 6000 }), { stream: false })
  const after = await call(body({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_completion_tokens: 5 }), { stream: false })
  const over = await call(body({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_completion_tokens: 9000 }), { stream: false })
  const rem = (r) => Number(r.headers?.['x-ratelimit-remaining-tokens'])
  results.tpmAdmission = { before: rem(before), big: rem(big), after: rem(after), bigUsage: big.usage, overStatus: over.status, overError: over.json?.error?.message }
  const drop = rem(before) - rem(big)
  lines.push('## Does the per-minute token limit count the output cap?', '')
  lines.push(`- Remaining tokens: after a 5-token-cap call **${rem(before)}**, after a 6,000-cap call (which used ${big.usage?.total_tokens ?? '?'} tokens) **${rem(big)}**, after another 5-cap call **${rem(after)}**.`)
  lines.push(`- Drop on the 6,000-cap call: ${drop} → ${drop > 3000 ? '**the cap is counted at admission** (worst case held)' : 'only the tokens actually used are counted'}.`)
  lines.push(`- A 9,000-cap call (over 8,000/min): HTTP ${over.status} ${cell(over.json?.error?.message ?? '', 160)}`, '')
}

// ---------------------------------------------------------------- images
lines.push('## Images (Inkling’s handwriting fixtures)', '', '| Image | HTTP | Tokens in → out | Tokens in without image | Image cost | First text | Total | Answer (start) |', '|---|---|---|---|---|---|---|---|')
{
  const text = 'What is written here, and is it right? Two sentences.'
  const plain = await call(body({ messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], max_completion_tokens: 60 }))
  const baseIn = plain.usage?.prompt_tokens
  for (const name of ['scenario-a.jpg', 'scenario-b.jpg', 'scenario-c.jpg']) {
    const data = (await readFile(join(root, 'tests/fixtures/handwriting', name))).toString('base64')
    const r = await call(body({ messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }] }] }))
    results[`image:${name}`] = { status: r.status, usage: r.usage, ms: r.ms, firstTextMs: r.firstTextMs, error: r.json?.error ?? r.errorEvent, answer: short(r.answer, 300) }
    lines.push(`| ${name} | ${r.status} | ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens}` : '–'} | ${baseIn ?? '–'} | ${r.usage && baseIn ? r.usage.prompt_tokens - baseIn : '–'} | ${r.firstTextMs ?? '–'} ms | ${r.ms} ms | ${cell(r.answer || r.json?.error?.message || r.text, 80)} |`)
    await sleep(2500)
  }
}
lines.push('')

// ---------------------------------------------------------------- structured answer
{
  await sleep(10_000)
  const schema = { name: 'check', strict: true, schema: { type: 'object', additionalProperties: false, required: ['verdict', 'transcription', 'feedback'], properties: { verdict: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect', 'unreadable'] }, transcription: { type: 'string' }, feedback: { type: 'string' } } } }
  const msgs = [{ role: 'system', content: `${sys}\nJudge the answer. Reply with one JSON object and nothing else: {"verdict":"correct|partially_correct|incorrect|unreadable","transcription":"…","feedback":"…"}` }, { role: 'user', content: 'Problem: Solve 2x+3=11. Expected: x=4. Student: x = 5' }]
  const valid = (s) => {
    try {
      return ['correct', 'partially_correct', 'incorrect', 'unreadable'].includes(JSON.parse(String(s).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')).verdict)
    } catch {
      return false
    }
  }
  const p = await call(body({ messages: msgs }))
  const js = await call(body({ messages: msgs, stream: false, response_format: { type: 'json_schema', json_schema: schema } }), { stream: false })
  results.check = { prompt: { status: p.status, valid: valid(p.answer), ms: p.ms }, jsonSchema: { status: js.status, valid: valid(js.answer), ms: js.ms, error: js.json?.error?.message } }
  lines.push('## Structured answer (the "check" task)', '')
  lines.push(`- Schema in the prompt (what the server does): HTTP ${p.status}, valid verdict **${valid(p.answer) ? 'yes' : 'NO'}**, ${p.ms} ms (\`${short(p.answer, 110)}\`)`)
  lines.push(`- Groq json_schema mode: HTTP ${js.status}, valid **${valid(js.answer) ? 'yes' : 'no'}** ${js.json?.error ? `(${short(js.json.error.message, 100)})` : ''}`, '')
}

// ---------------------------------------------------------------- quality samples
lines.push('## Tutor quality samples', '', 'Short answers, for a human to judge (the full set of 13 scenarios runs against the test Worker).', '')
results.quality = []
for (const prompt of [
  'I got x = -2 and x = 3 for x^2 - x - 6 = 0. Is that right? Don’t just tell me, help me check.',
  'Explain why the derivative of x^2 is 2x, for a 15-year-old, in under 120 words.',
  'My working: 3(x + 4) = 18 → 3x + 4 = 18 → x = 14/3. Where did I go wrong?',
  'Give me one practice problem on Pythagoras’ theorem, with its answer hidden after the word ANSWER.'
]) {
  await sleep(4000)
  const r = await call(body({ messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], max_completion_tokens: 500 }))
  results.quality.push({ prompt, status: r.status, ms: r.ms, firstTextMs: r.firstTextMs, usage: r.usage, answer: r.answer })
  lines.push(`**Q:** ${prompt}`, '', `HTTP ${r.status}, first text ${r.firstTextMs ?? '–'} ms, total ${r.ms} ms, ${r.usage ? `${r.usage.prompt_tokens} → ${r.usage.completion_tokens} tokens` : 'no usage'}`, '', `> ${short(r.answer || r.json?.error?.message || r.text, 900)}`, '')
}

// ---------------------------------------------------------------- errors
await sleep(10_000)
lines.push('## Errors and tiers', '', '| Case | HTTP | Body (start) |', '|---|---|---|')
for (const [name, b, key] of [
  ['invalid key', body({ messages: q, stream: false, max_completion_tokens: 5 }), 'gsk_invalid000000000000000000000000000000000000000000'],
  ['unknown model', body({ model: 'qwen/not-a-model', messages: q, stream: false, max_completion_tokens: 5 }), null],
  ['service_tier flex (paid plans only)', body({ messages: q, stream: false, max_completion_tokens: 5, service_tier: 'flex' }), null],
  ['reasoning_effort xhigh (unsupported)', body({ messages: q, stream: false, max_completion_tokens: 5, reasoning_effort: 'xhigh' }), null],
  ['4 images (limit 3)', null, null]
]) {
  let r
  if (name.startsWith('4 images')) {
    const data = (await readFile(join(root, 'tests/fixtures/handwriting', 'scenario-a.jpg'))).toString('base64')
    const part = { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }
    r = await call(body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe.' }, part, part, part, part] }], stream: false, max_completion_tokens: 5 }), { stream: false })
  } else r = await call(b, { stream: false, key: key ?? KEY })
  results[`err:${name}`] = { status: r.status, body: short(r.text, 200) }
  lines.push(`| ${name} | ${r.status} | ${cell(r.text, 140)} |`)
}
lines.push('')

// ---------------------------------------------------------------- per-minute burst
if (BURST > 0 && freePlan) {
  await sleep(61_000)
  const started = Date.now()
  const all = await Promise.all(Array.from({ length: BURST }, (_, i) => call(body({ messages: [{ role: 'user', content: `Reply with the number ${i}.` }], stream: false, max_completion_tokens: 5 }), { stream: false })))
  const statuses = all.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})
  const limited = all.find((r) => r.status === 429)
  results.burst = { n: BURST, statuses, ms: Date.now() - started, headers429: limited?.headers, body429: limited?.json?.error }
  lines.push('## Per-minute request limit', '', `${BURST} concurrent tiny requests: ${JSON.stringify(statuses)} in ${Date.now() - started} ms. A 429's headers: \`${JSON.stringify(limited?.headers ?? {})}\`, body: \`${short(JSON.stringify(limited?.json?.error ?? null), 220)}\``, '')
} else lines.push('## Per-minute request limit', '', 'Skipped.', '')

// ---------------------------------------------------------------- after
await sleep(2000)
const last = await call(body({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_completion_tokens: 5 }), { stream: false })
results.limitsAfter = last.headers
lines.push('## After the probe', '', `\`${JSON.stringify(last.headers)}\``, '')
const remainingRequests = Number(last.headers?.['x-ratelimit-remaining-requests'] ?? 0)
if (!freePlan) lines.splice(3, 0, '> **STOP: this account does not report the free plan’s limits.** Check console.groq.com/settings/billing before any further test.', '')
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `free_plan=${freePlan}\nremaining_requests=${remainingRequests}\nlisted=${!!m}\n`)
const file = process.argv.find((a) => a.endsWith('.md')) ?? join(root, 'test-results', 'groq-probe.md')
await writeFile(file, lines.join('\n') + '\n')
await writeFile(file.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2))
console.log(lines.join('\n'))
if (!freePlan) console.log('::error title=Groq plan::the account does not report free-plan limits')
