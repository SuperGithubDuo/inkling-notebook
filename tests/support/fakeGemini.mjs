/**
 * A local stand-in for the Gemini REST API (v1beta), speaking the same wire
 * format the official @google/genai SDK uses: `x-goog-api-key` auth,
 * `models/{id}:streamGenerateContent?alt=sse` server-sent events,
 * `models/{id}:generateContent`, `GET models`, and Google's JSON error bodies.
 *
 * Tests queue scripted replies with `reply(...)`; anything unscripted gets a
 * default answer chosen from the request's task (chat / practice / check /
 * annotate). Every request is recorded for assertions.
 */
import http from 'node:http'

export const VALID_KEY = 'AIzaFakeTestKey-0123456789abcdef'
export const BAD_KEY = 'AIzaRejectedKey-0123456789abcdef'

const DEFAULT_MODELS = [
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/text-embedding-005', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }
]

/** Google error bodies the real API returns. */
export const errors = {
  invalidKey: () => ({
    status: 400,
    body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }
  }),
  perMinute: (retry = '17s') => ({
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }
        ]
      }
    }
  }),
  perDay: () => ({
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '250' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }
        ]
      }
    }
  }),
  noFreeTier: () => ({
    status: 429,
    body: { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '0' }] }] } }
  }),
  notFound: (model = 'gemini-3.8-flash') => ({
    status: 404,
    body: { error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: 'NOT_FOUND' } }
  }),
  overloaded: () => ({ status: 503, body: { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } } })
}

/** Which tutor task a request is, from its system instruction. */
export function taskOf(body) {
  const sys = (body?.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('')
  if (/Reply with exactly: OK/.test(sys)) return 'test'
  if (/Create practice problems/.test(sys)) return 'practice'
  if (/Judge the student's answer/.test(sys)) return 'check'
  if (/Mark it up the way a teacher would/.test(sys)) return 'annotate'
  return 'chat'
}

/** Default answers per task, valid for Inkling's schemas. */
export function defaultAnswer(body) {
  switch (taskOf(body)) {
    case 'test':
      return { text: 'OK' }
    case 'practice':
      return {
        json: {
          topic: 'Solving quadratic equations by factoring',
          problems: [
            { question: 'Solve $x^2 - 5x + 6 = 0$.', difficulty: 'easy', hints: ['Look for two numbers that multiply to $6$.', 'They also add up to $-5$.', 'Try $-2$ and $-3$.'], answer: '$x = 2$ or $x = 3$', solution: '$$x^2-5x+6=(x-2)(x-3)=0$$ so $x=2$ or $x=3$.' },
            { question: 'Solve $x^2 + x - 12 = 0$.', difficulty: 'medium', hints: ['Find two numbers with product $-12$.', 'Their sum is $1$.'], answer: '$x = 3$ or $x = -4$', solution: '$$(x+4)(x-3)=0$$ so $x=-4$ or $x=3$.' }
          ]
        }
      }
    case 'check': {
      const text = JSON.stringify(body.contents)
      const right = /x\s*=\s*2.*3|2\s*(,|and|or)\s*3/i.test(text.split('Student answer').pop() ?? '')
      return { json: right ? { verdict: 'correct', transcription: 'x = 2, x = 3', feedback: 'Correct — both roots check out.' } : { verdict: 'incorrect', transcription: 'x = 1', feedback: 'Not quite: substitute $x=1$ back in and you get $2 \\ne 0$.' } }
    }
    case 'annotate':
      return {
        json: {
          transcription: '2x + 3 = 11\n2x = 7\nx = 3.5',
          summary: 'The first step is right, but $11 - 3 = 8$, not $7$, so $x = 4$.',
          annotations: [
            { kind: 'check', box_2d: [40, 60, 300, 900] },
            { kind: 'cross', box_2d: [360, 60, 620, 700] },
            { kind: 'correction', box_2d: [360, 60, 620, 700], text: '2x = 8' },
            { kind: 'note', box_2d: [680, 60, 960, 700], text: '11 − 3 = 8, so x = 4' }
          ]
        }
      }
    default: {
      const hasImage = (body.contents ?? []).some((c) => (c.parts ?? []).some((p) => p.inlineData))
      return {
        chunks: [
          hasImage ? 'I can read your work: $2x + 3 = 11$.\n\n' : 'Here is how to approach it.\n\n',
          'Subtract $3$ from both sides:\n\n$$2x = 8$$\n\n',
          'Then divide by $2$, so $x = 4$.'
        ]
      }
    }
  }
}

export async function startFakeGemini() {
  const queue = []
  const requests = []
  let models = DEFAULT_MODELS
  let autoDelayMs = 0

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x')
      const key = req.headers['x-goog-api-key']
      const body = raw ? JSON.parse(raw) : null
      const match = url.pathname.match(/^\/v1beta\/models\/([^:/]+):(streamGenerateContent|generateContent)$/)
      const record = { method: req.method, path: url.pathname, model: match?.[1] ?? null, key, body, task: body ? taskOf(body) : null }
      requests.push(record)
      const sendError = ({ status, body: b }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(b))
      }
      if (key !== VALID_KEY) return sendError(errors.invalidKey())

      if (req.method === 'GET' && url.pathname === '/v1beta/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ models }))
      }
      if (!match) return sendError(errors.notFound('unknown'))
      if (!models.some((m) => m.name === `models/${match[1]}`)) return sendError(errors.notFound(match[1]))

      const scripted = record.task === 'test' ? null : queue.shift()
      let answer = typeof scripted === 'function' ? await scripted(record) : scripted
      answer ??= defaultAnswer(body)
      const delay = answer.delayMs ?? autoDelayMs
      if (delay) await new Promise((r) => setTimeout(r, delay))
      if (answer.error) return sendError(answer.error)

      const chunks = answer.chunks ?? (answer.json ? chunkString(JSON.stringify(answer.json), 3) : [answer.text ?? ''])
      const finishReason = answer.finishReason ?? 'STOP'
      const usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 }
      const chunkBody = (text, last) => ({
        candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...(last ? { finishReason } : {}) }],
        ...(last ? { usageMetadata } : {}),
        modelVersion: match[1]
      })
      if (match[2] === 'generateContent') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(chunkBody(chunks.join(''), true)))
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let i = 0; i < chunks.length; i++) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify(chunkBody(chunks[i], i === chunks.length - 1))}\r\n\r\n`)
        if (answer.chunkDelayMs) await new Promise((r) => setTimeout(r, answer.chunkDelayMs))
      }
      if (answer.hang) return // leaves the stream open, for cancel tests
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    requests,
    /** Queue the next generate reply: {text} | {chunks} | {json} | {error} plus delayMs, chunkDelayMs, hang, finishReason. */
    reply(answer) {
      queue.push(answer)
    },
    setModels(list) {
      models = list
    },
    setDelay(ms) {
      autoDelayMs = ms
    },
    generated: () => requests.filter((r) => r.model && r.task !== 'test'),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(r)
      })
  }
}

function chunkString(s, n) {
  const size = Math.ceil(s.length / n)
  return Array.from({ length: n }, (_, i) => s.slice(i * size, (i + 1) * size)).filter(Boolean)
}
