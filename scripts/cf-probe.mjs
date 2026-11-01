#!/usr/bin/env node
/**
 * One minimal Workers AI request, straight to Cloudflare's REST API (not
 * through Inkling's server, so its 15-minute pause can't hide the answer):
 * "Reply with 5", at most 8 output tokens, thinking off. A few Neurons when
 * accepted; nothing when refused. Prints Cloudflare's own status, error codes
 * and messages (the prompt is fixed; no user content is involved).
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN allowed to run
 * Workers AI ("Workers AI: Read" or "Edit"). Never throws.
 *
 *   node scripts/cf-probe.mjs [model=@cf/qwen/qwen3.8-27b]
 */
const model = process.argv[2] ?? '@cf/qwen/qwen3.8-27b'
const at = new Date().toISOString()
try {
  const t0 = Date.now()
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'What is 2 + 3? Reply with the number only.' }],
      max_tokens: 8,
      max_completion_tokens: 8,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false }
    })
  })
  const body = await res.json().catch(() => null)
  const text = body?.result?.response ?? body?.result?.choices?.[0]?.message?.content ?? null
  console.log(
    JSON.stringify({
      at,
      accepted: res.ok && body?.success !== false,
      httpStatus: res.status,
      ms: Date.now() - t0,
      answer: typeof text === 'string' ? text.slice(0, 20) : null,
      usage: body?.result?.usage ?? null,
      errors: (body?.errors ?? []).map((e) => ({ code: e.code, message: String(e.message ?? '').slice(0, 300) }))
    })
  )
} catch (err) {
  console.log(JSON.stringify({ at, accepted: false, error: String(err?.message ?? err).slice(0, 300) }))
}
