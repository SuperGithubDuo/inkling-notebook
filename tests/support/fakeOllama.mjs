/**
 * A local stand-in for the Ollama REST API, speaking its wire format:
 * `GET /api/version`, `GET /api/tags`, `POST /api/show` (capabilities),
 * and `POST /api/chat` streaming newline-delimited JSON, with Ollama's
 * `{"error": "..."}` bodies. Requests are recorded for assertions.
 *
 * Tests queue scripted replies with `reply(...)`; anything unscripted gets a
 * default answer chosen from the request's task (chat / practice / check /
 * annotate), in the shape a Qwen3-VL model returns (boxes as bbox_2d).
 */
import http from 'node:http'

export const DEFAULT_TAGS = [
  { name: 'qwen3-vl:4b-instruct', size: 3_300_000_000, digest: 'sha256:qwen4bi', capabilities: ['completion', 'vision', 'tools'] },
  { name: 'qwen3-vl:2b-instruct', size: 1_900_000_000, digest: 'sha256:qwen2bi', capabilities: ['completion', 'vision', 'tools'] },
  // The plain tag is Qwen3-VL's thinking build.
  { name: 'qwen3-vl:4b', size: 3_300_000_000, digest: 'sha256:qwen4b', capabilities: ['completion', 'vision', 'tools', 'thinking'] },
  { name: 'llama3.2:3b', size: 2_000_000_000, digest: 'sha256:llama', capabilities: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', size: 270_000_000, digest: 'sha256:embed', capabilities: ['embedding'] }
]

/** Which tutor task a chat request is, from its system message. */
export function taskOf(body) {
  const sys = (body?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('')
  if (/Reply with exactly: OK/.test(sys)) return 'test'
  if (/Create practice problems/.test(sys)) return 'practice'
  if (/Judge the student's answer/.test(sys)) return 'check'
  if (/Mark it up the way a teacher would/.test(sys)) return 'annotate'
  return 'chat'
}

export function defaultAnswer(body) {
  switch (taskOf(body)) {
    case 'test':
      return { text: 'OK' }
    case 'practice':
      return {
        json: {
          topic: 'Linear equations',
          problems: [
            { question: 'Solve $3x + 2 = 11$.', difficulty: 'easy', hints: ['Subtract $2$ from both sides.', 'Then divide by $3$.'], answer: '$x = 3$', solution: '$$3x = 9 \\Rightarrow x = 3$$' },
            { question: 'Solve $5x - 4 = 21$.', difficulty: 'easy', hints: ['Add $4$ to both sides.'], answer: '$x = 5$', solution: '$$5x = 25 \\Rightarrow x = 5$$' }
          ]
        }
      }
    case 'check': {
      const text = JSON.stringify(body.messages)
      const right = /Student answer[^"]*x\s*=\s*3\b/.test(text)
      return { json: right ? { verdict: 'correct', transcription: 'x = 3', feedback: 'Correct!' } : { verdict: 'incorrect', transcription: 'x = 7', feedback: 'Not quite: check the subtraction.' } }
    }
    case 'annotate':
      return {
        json: {
          transcription: 'x² + 5x + 6 = 0\n(x + 2)(x + 3) = 0\nx = 2, 3',
          summary: 'The factorisation is right, but the roots are $x = -2$ and $x = -3$.',
          annotations: [
            { kind: 'check', bbox_2d: [60, 40, 900, 300] },
            { kind: 'cross', bbox_2d: [60, 700, 500, 960] },
            { kind: 'correction', bbox_2d: [60, 700, 500, 960], text: 'x = −2, −3' }
          ]
        }
      }
    default: {
      const hasImage = (body.messages ?? []).some((m) => m.images?.length)
      return {
        chunks: [hasImage ? 'I read: $x^2 + 5x + 6 = 0$.\n\n' : 'Here is how to approach it.\n\n', 'Setting each factor to zero gives ', '$x = -2$ or $x = -3$.']
      }
    }
  }
}

export async function startFakeOllama(options = {}) {
  const queue = []
  const requests = []
  let tags = DEFAULT_TAGS
  let version = '0.40.13'
  let down = false

  const server = http.createServer((req, res) => {
    // "Not running": drop the connection, as a closed port would refuse it.
    if (down) return req.socket.destroy()
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null
      const record = { method: req.method, path: req.url, body, task: req.url === '/api/chat' ? taskOf(body) : null }
      requests.push(record)
      const json = (status, b) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(b))
      }
      if (req.method === 'GET' && req.url === '/api/version') return json(200, { version })
      if (req.method === 'GET' && req.url === '/api/tags') return json(200, { models: tags.map(({ capabilities: _c, ...t }) => ({ ...t, model: t.name })) })
      if (req.method === 'POST' && req.url === '/api/show') {
        const tag = tags.find((t) => t.name === body?.model)
        return tag ? json(200, { capabilities: tag.capabilities, details: {} }) : json(404, { error: `model '${body?.model}' not found` })
      }
      if (req.method !== 'POST' || req.url !== '/api/chat') return json(404, { error: 'not found' })

      const tag = tags.find((t) => t.name === body.model)
      if (!tag) return json(404, { error: `model '${body.model}' not found` })
      if (body.messages.some((m) => m.images?.length) && !tag.capabilities.includes('vision')) return json(500, { error: 'this model is missing data required for image input' })

      const scripted = record.task === 'test' ? null : queue.shift()
      let answer = typeof scripted === 'function' ? await scripted(record) : scripted
      answer ??= defaultAnswer(body)
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs))
      if (answer.error) return json(answer.status ?? 500, { error: answer.error })

      const chunks = answer.chunks ?? (answer.json ? chunkString(JSON.stringify(answer.json), 4) : [answer.text ?? ''])
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const c of chunks) {
        if (res.destroyed) return
        res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: c }, done: false }) + '\n')
        if (answer.chunkDelayMs) await new Promise((r) => setTimeout(r, answer.chunkDelayMs))
      }
      if (answer.hang) return
      if (answer.midStreamError) {
        res.end(JSON.stringify({ error: answer.midStreamError }) + '\n')
        return
      }
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: answer.doneReason ?? 'stop', prompt_eval_count: 300, eval_count: 60 }) + '\n')
    })
  })
  await new Promise((r) => server.listen(options.port ?? 0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    requests,
    /** Queue the next chat reply: {text} | {chunks} | {json} | {error, status} plus delayMs, chunkDelayMs, hang, midStreamError, doneReason. */
    reply(answer) {
      queue.push(answer)
    },
    setTags(list) {
      tags = list
    },
    setVersion(v) {
      version = v
    },
    /** Simulates Ollama being stopped (connections dropped) or started again. */
    setDown(value) {
      down = value
    },
    chats: () => requests.filter((r) => r.path === '/api/chat' && r.task !== 'test'),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(r)
      })
  }
}

function chunkString(s, n) {
  const size = Math.ceil(s.length / n)
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
