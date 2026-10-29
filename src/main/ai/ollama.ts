/**
 * A local Ollama server (https://ollama.com) as the tutor's model provider.
 *
 * Talks to Ollama's REST API on the loopback interface only, so notebook
 * content never leaves this computer: `/api/version` to see whether the server
 * runs, `/api/tags` + `/api/show` to discover installed models and whether they
 * can read images, and `/api/chat` with streaming, base64 images and a JSON
 * Schema in `format` for structured answers. No new dependencies: plain fetch.
 *
 * Kept free of Electron imports so it can be tested against a local fake.
 */
import type { AiTurn } from '@shared/ai'
import { OLLAMA_DEFAULT_URL } from '@shared/ai'
import { ProviderError, type AiProvider, type ProviderChunk, type ProviderModel, type ProviderRequest } from './provider'

/**
 * Waiting for the first token includes loading the model from disk and
 * reading the image. In testing, a cold load alone took 194 s on a busy
 * 2-core machine, then ~90 s of image and prompt processing. The user can
 * press Stop at any time, so be generous.
 */
const FIRST_TOKEN_TIMEOUT_MS = 600_000
/** Once it streams, a long silence means something is stuck. */
const IDLE_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 8_000
/**
 * Context window. An image (~1,000 tokens), the instructions and a few turns
 * of history fit comfortably in 8K. More costs memory: with 12K, Qwen3-VL 4B
 * grew past 6 GB and was killed by the OS on an 8 GB test machine.
 */
const CONTEXT_TOKENS = 8192
/**
 * Extra tokens for a thinking build's reasoning. Ollama (0.40) ignores
 * `think: false` for Qwen3-VL's thinking builds, and the reasoning counts
 * towards num_predict: without room for it the answer itself gets cut off.
 */
const THINKING_BUDGET = 3072

/**
 * Small local models occasionally fall into a loop, repeating the same phrase
 * until the token limit — minutes on a CPU. Seen in testing with
 * qwen3-vl:2b-instruct (2,500+ tokens on a ~250-token answer). Stop as soon
 * as the end of the answer has occurred many times in its recent text.
 */
export function isLooping(text: string): boolean {
  if (text.length < 600) return false
  const tail = text.slice(-48)
  if (!tail.trim()) return false
  const recent = text.slice(-1600)
  let count = 0
  for (let i = recent.indexOf(tail); i >= 0; i = recent.indexOf(tail, i + 1)) count++
  return count >= 6
}

export interface OllamaOptions {
  /** Defaults to http://127.0.0.1:11434. Must be a loopback address. */
  baseUrl?: string
}

interface OllamaTag {
  name: string
  model?: string
  size?: number
  digest?: string
}

interface OllamaChunk {
  message?: { role?: string; content?: string; thinking?: string }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

/** True for http(s) URLs on 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama'
  readonly baseUrl: string
  /** Capabilities by model digest (or name), so /api/show runs once per model. */
  private readonly caps = new Map<string, string[]>()

  constructor(options: OllamaOptions = {}) {
    const url = (options.baseUrl ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, '')
    // Local processing is the point of this provider: never talk to another host.
    if (!isLoopbackUrl(url)) throw new Error(`Ollama must run on this computer (got ${url}).`)
    this.baseUrl = url
  }

  /** The server's version, or throws ProviderError('offline'). */
  async version(signal?: AbortSignal): Promise<string> {
    const body = (await this.getJson('/api/version', signal)) as { version?: string }
    return body.version ?? 'unknown'
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const body = (await this.getJson('/api/tags', signal)) as { models?: OllamaTag[] }
    const tags = (body.models ?? []).slice(0, 60)
    return Promise.all(
      tags.map(async (t): Promise<ProviderModel> => {
        const caps = await this.capabilities(t, signal).catch(() => [] as string[])
        return {
          id: t.name,
          displayName: t.name,
          // Embedding-only models can't chat.
          canGenerate: caps.length === 0 || caps.includes('completion'),
          vision: caps.includes('vision'),
          thinking: caps.includes('thinking'),
          sizeBytes: t.size
        }
      })
    )
  }

  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const timer = new Watchdog(signal)
    let res: Response
    const thinking = (await this.capabilities({ name: request.model }, timer.signal).catch(() => [] as string[])).includes('thinking')
    try {
      timer.arm(FIRST_TOKEN_TIMEOUT_MS)
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timer.signal,
        body: JSON.stringify({
          model: request.model,
          messages: toMessages(request.system, request.turns),
          stream: true,
          // Ask thinking builds not to reason at length (newer Ollama versions honour it).
          ...(thinking ? { think: false } : {}),
          ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
          options: {
            num_predict: request.maxOutputTokens + (thinking ? THINKING_BUDGET : 0),
            num_ctx: CONTEXT_TOKENS,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            // Qwen's recommended setting against repetition, for free text only (it would fight JSON keys).
            ...(request.jsonSchema ? {} : { presence_penalty: 1.5 })
          }
        })
      })
    } catch (err) {
      timer.clear()
      throw classifyOllamaError(err, { aborted: !!signal?.aborted, timedOut: timer.timedOut, model: request.model })
    }
    if (!res.ok || !res.body) {
      timer.clear()
      throw httpError(res.status, await res.text().catch(() => ''), request.model)
    }

    let usage = {}
    let finishReason: string | undefined
    let answer = ''
    let checkedAt = 0
    const decoder = new TextDecoder()
    let buffered = ''
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        timer.arm(IDLE_TIMEOUT_MS)
        buffered += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          if (!line) continue
          let chunk: OllamaChunk
          try {
            chunk = JSON.parse(line) as OllamaChunk
          } catch {
            throw new ProviderError('bad_response', 'Ollama sent a reply Inkling could not read. Try again, or update Ollama.')
          }
          if (chunk.error) throw httpError(500, JSON.stringify({ error: chunk.error }), request.model)
          const text = chunk.message?.content
          if (text) {
            answer += text
            if (answer.length - checkedAt >= 200) {
              checkedAt = answer.length
              if (isLooping(answer)) {
                throw new ProviderError('bad_response', 'The local model got stuck repeating itself, so Inkling stopped it. Try again, or choose a larger model in AI settings.')
              }
            }
            yield { type: 'text', text }
          }
          if (chunk.done) {
            finishReason = chunk.done_reason === 'length' ? 'MAX_TOKENS' : chunk.done_reason?.toUpperCase()
            usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count }
          }
        }
      }
    } catch (err) {
      void reader.cancel().catch(() => undefined)
      throw classifyOllamaError(err, { aborted: !!signal?.aborted, timedOut: timer.timedOut, model: request.model })
    } finally {
      timer.clear()
    }
    yield { type: 'end', usage, finishReason }
  }

  private async capabilities(tag: Pick<OllamaTag, 'name' | 'digest'>, signal?: AbortSignal): Promise<string[]> {
    const key = tag.digest ?? tag.name
    const known = this.caps.get(key)
    if (known) return known
    const body = (await this.postJson('/api/show', { model: tag.name }, signal)) as { capabilities?: string[] }
    const caps = body.capabilities ?? []
    this.caps.set(key, caps)
    return caps
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'GET' }, signal)
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS)
    const s = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: s })
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) throw new ProviderError('network', `Ollama at ${this.baseUrl} didn't respond. Restart the Ollama app and try again.`)
      throw classifyOllamaError(err, { aborted: !!signal?.aborted, timedOut: false })
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) throw httpError(res.status, text)
    try {
      return JSON.parse(text)
    } catch {
      throw new ProviderError('bad_response', `Something at ${this.baseUrl} answered, but it doesn't look like Ollama.`)
    }
  }
}

/** Ollama messages: images go on the message as bare base64, in order. */
function toMessages(system: string, turns: AiTurn[]): Array<{ role: string; content: string; images?: string[] }> {
  return [
    { role: 'system', content: system },
    ...turns.map((t) => {
      const images = t.parts.flatMap((p) => ('image' in p ? [p.image.data] : []))
      return {
        role: t.role === 'model' ? 'assistant' : 'user',
        content: t.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n\n'),
        ...(images.length ? { images } : {})
      }
    })
  ]
}

/** An abort signal for one request: the caller's, or a timeout the stream re-arms as data arrives. */
class Watchdog {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  timedOut = false
  readonly signal: AbortSignal

  constructor(outer?: AbortSignal) {
    this.signal = outer ? AbortSignal.any([outer, this.controller.signal]) : this.controller.signal
  }
  arm(ms: number): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort()
    }, ms)
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

const pullHint = (model?: string): string => (model ? ` To install it, run: ollama pull ${model}` : '')

function httpError(status: number, body: string, model?: string): ProviderError {
  let message = body
  try {
    message = (JSON.parse(body) as { error?: string }).error ?? body
  } catch {
    /* plain text body */
  }
  const name = model ? `“${model}”` : 'This model'
  if (status === 404 || /not found|pull/i.test(message)) {
    return new ProviderError('model_unavailable', `${name} isn't installed in Ollama.${pullHint(model)}`)
  }
  if (/does not support (images|vision)|image input/i.test(message)) {
    return new ProviderError('model_unavailable', `${name} can't read images, so it can't see handwriting. Choose a vision model such as qwen3-vl:4b-instruct in AI settings.`)
  }
  if (/more system memory|out of memory|insufficient memory|cudaMalloc|failed to allocate/i.test(message)) {
    return new ProviderError('server', `${name} needs more memory than this computer has free. Close other apps or choose a smaller model (qwen3-vl:2b-instruct) in AI settings.`)
  }
  if (/unexpectedly stopped|exit status|llama runner|llama-server|EOF|signal: killed|terminated/i.test(message)) {
    // In testing this was the operating system stopping the model for lack of memory.
    return new ProviderError(
      'server',
      `Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (${shorten(message)})`
    )
  }
  if (status === 400) return new ProviderError('bad_request', `Ollama could not process this request: ${shorten(message)}`)
  if (status >= 500) return new ProviderError('server', `Ollama reported an error: ${shorten(message)}`, 5)
  return new ProviderError('unknown', `Ollama returned an error (${status}): ${shorten(message)}`)
}

export function classifyOllamaError(err: unknown, ctx: { aborted: boolean; timedOut: boolean; model?: string }): ProviderError {
  if (err instanceof ProviderError) return err
  if (ctx.aborted) return new ProviderError('canceled', 'Stopped.')
  if (ctx.timedOut) {
    const small = /2b/.test(ctx.model ?? '') ? '' : ' A smaller model (qwen3-vl:2b-instruct) is faster.'
    return new ProviderError('network', `The local model took too long to answer on this computer. Try a smaller selection, or close other apps.${small}`)
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError') return new ProviderError('canceled', 'Stopped.')
  const code = e?.cause?.code ?? ''
  if (/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL|ENOTFOUND|UND_ERR_SOCKET/.test(code) || /fetch failed/i.test(e?.message ?? '')) {
    return new ProviderError('offline', 'Ollama isn’t running. Start the Ollama app (or run “ollama serve” in a terminal), then try again.')
  }
  return new ProviderError('unknown', `Something went wrong talking to Ollama: ${shorten(e?.message ?? String(err))}`)
}

const shorten = (s: string): string => (s.length > 200 ? `${s.slice(0, 197)}…` : s)
