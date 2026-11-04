/**
 * A fake OpenAI-compatible inference provider (DeepInfra / OpenRouter style)
 * on local HTTP, for testing the AI server's external-provider path end to end.
 *
 * POST <base>/chat/completions with `authorization: Bearer <key>`. Answers come
 * from a fake Workers AI (fakeBeta.mjs), so the same default answers and the
 * same scripted replies work; the body is translated back (max_tokens →
 * max_completion_tokens) before it is handed over. HTTP-level failures can be
 * queued ahead of the answer with `fail()`.
 *
 * Every request is recorded (headers and JSON body) in memory only.
 */
import http from 'node:http'
import { fakeWorkersAi } from './fakeBeta.mjs'

export const FAKE_KEY = 'di-test-key-0123456789abcdefghijklmnop'

/**
 * `responseHeaders` is sent with every answer (Groq's x-ratelimit-* limits); `groqUsage` moves a
 * stream's usage into x_groq.usage on its last chunk, as Groq reports it.
 * @param {{ key?: string, path?: string, reportCost?: (usage: any) => number | undefined, cachedTokens?: number, responseHeaders?: Record<string, string>, groqUsage?: boolean }} [options]
 */
export async function startFakeOpenAi(options = {}) {
  const key = options.key ?? FAKE_KEY
  const base = options.path ?? '/v1/openai'
  const model = fakeWorkersAi()
  /** Queued HTTP-level outcomes, used before an answer: { status, headers, body } | { hangMs } | { garbage } | { errorEvent } | { idleAfterFirst } */
  const failures = []
  const requests = []
  const sockets = new Set()

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = undefined
    }
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body })
    if (req.method !== 'POST' || req.url !== `${base}/chat/completions`) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'not found' } }))
    }
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'invalid api key', code: 401 } }))
    }
    if (!body || !Array.isArray(body.messages) || typeof body.model !== 'string') {
      res.writeHead(422, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ detail: [{ msg: 'messages: field required' }] }))
    }
    const f = failures.shift()
    if (f?.hangMs) {
      await new Promise((r) => setTimeout(r, f.hangMs))
      if (res.destroyed) return
    }
    if (f?.status) {
      res.writeHead(f.status, { 'content-type': 'application/json', ...(f.headers ?? {}) })
      return res.end(typeof f.body === 'string' ? f.body : JSON.stringify(f.body ?? { error: { message: 'failure' } }))
    }
    if (f?.garbage) {
      res.writeHead(200, { 'content-type': body?.stream ? 'text/event-stream' : 'application/json' })
      return res.end(f.garbage)
    }
    if (f?.errorEvent) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ error: { message: 'Provider disconnected', code: 502 } })}\n\n`)
      return res.end()
    }
    if (f?.idleAfterFirst) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Starting' } }] })}\n\n`)
      return // never another byte
    }

    // Translate the OpenAI-compatible body back into the Workers AI inputs the fake model reads.
    const { max_tokens, max_completion_tokens, model: m, stream_options, chat_template_kwargs, reasoning, provider, service_tier, reasoning_format, ...rest } = body
    const inputs = { ...rest, max_completion_tokens: max_tokens ?? max_completion_tokens, ...(chat_template_kwargs ? { chat_template_kwargs } : {}) }
    const extra = options.responseHeaders ?? {}
    const out = await model.run(m, inputs)
    if (!body.stream) {
      const json = out
      if (json.usage) decorateUsage(json.usage)
      res.writeHead(200, { 'content-type': 'application/json', ...extra })
      return res.end(JSON.stringify(json))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...extra })
    const reader = out.getReader()
    res.on('close', () => void reader.cancel().catch(() => undefined))
    const dec = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
      let text = dec.decode(value)
      // Add the provider's own usage details (cached tokens, reported cost) to the usage chunk.
      text = text.replace(/^data: (\{.*"usage".*\})$/m, (_, j) => {
        const o = JSON.parse(j)
        if (o.usage) decorateUsage(o.usage)
        if (options.groqUsage && o.usage) {
          o.x_groq = { id: 'req_fake', usage: o.usage }
          delete o.usage
        }
        return `data: ${JSON.stringify(o)}`
      })
      res.write(text)
    }
    res.end()
  })

  function decorateUsage(usage) {
    if (options.cachedTokens) usage.prompt_tokens_details = { cached_tokens: options.cachedTokens }
    const cost = options.reportCost?.(usage)
    if (cost !== undefined) usage.cost = cost
  }

  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}${base}`
  return {
    url,
    key,
    model,
    requests,
    /** Queues an HTTP-level outcome for the next request. */
    fail(f) {
      failures.push(f)
    },
    /** Requests that reached the completions route with the right key. */
    completions: () => requests.filter((r) => r.path === `${base}/chat/completions`),
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy()
        server.close(r)
      })
  }
}
