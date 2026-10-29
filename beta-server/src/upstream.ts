/**
 * Talking to the model on Workers AI: building the chat messages from
 * Inkling's turns, estimating a request's cost before it is sent, and reading
 * the model's answer (streamed server-sent events or a single JSON body) in
 * either of the two shapes Workers AI uses (OpenAI-style `choices[].delta`
 * or the older `{ response }`).
 */
import type { AiTurn } from '../../src/shared/ai'

export interface Rates {
  /** Neurons per million input tokens (Cloudflare's price list). */
  inputPerM: number
  /** Neurons per million output tokens, reasoning included. */
  outputPerM: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export const neuronsFor = (u: Usage, r: Rates): number => (u.inputTokens * r.inputPerM + u.outputTokens * r.outputPerM) / 1e6

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export function toMessages(system: string, turns: AiTurn[]): ChatMessage[] {
  return [
    { role: 'system', content: system },
    ...turns.map((t): ChatMessage => {
      const role = t.role === 'model' ? 'assistant' : 'user'
      const hasImage = t.parts.some((p) => 'image' in p)
      if (!hasImage) return { role, content: t.parts.map((p) => ('text' in p ? p.text : '')).join('\n\n') }
      return {
        role,
        content: t.parts.map((p): ContentPart => ('text' in p ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.image.mimeType};base64,${p.image.data}` } }))
      }
    })
  ]
}

/** Width and height of a base64 PNG or JPEG, read from its header; null if not found. */
export function imageSize(base64: string): { width: number; height: number } | null {
  let bytes: Uint8Array
  try {
    const head = atob(base64.slice(0, 8192 - (8192 % 4)))
    bytes = Uint8Array.from(head, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  // PNG: IHDR right after the 8-byte signature.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
    const dv = new DataView(bytes.buffer)
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  // JPEG: walk the markers to a start-of-frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]!
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! }
      }
      i += 2 + len
    }
  }
  return null
}

/**
 * Tokens an image costs. Qwen vision models read images in 28×28-pixel
 * patches (14-px patches merged 2×2), after resizing to fit a pixel budget.
 * Inkling sends at most 1024 px on the long edge. An unreadable header
 * counts as the largest image Inkling sends.
 */
export function imageTokens(base64: string, patch = 28): number {
  const size = imageSize(base64) ?? { width: 1024, height: 1024 }
  const scale = Math.min(1, 1024 / Math.max(size.width, size.height, 1))
  const w = Math.max(patch, size.width * scale)
  const h = Math.max(patch, size.height * scale)
  return Math.ceil(w / patch) * Math.ceil(h / patch) + 2
}

/**
 * An upper estimate of a request's input tokens: text at 3 characters a token
 * (English averages about 4; maths and LaTeX are denser), each image by its
 * size, and a few tokens of chat formatting per message.
 */
export function estimateInputTokens(system: string, turns: AiTurn[], patch?: number): number {
  let chars = system.length
  let tokens = 8
  for (const t of turns) {
    tokens += 8
    for (const p of t.parts) {
      if ('text' in p) chars += p.text.length
      else tokens += imageTokens(p.image.data, patch)
    }
  }
  return tokens + Math.ceil(chars / 3)
}

// ------------------------------------------------------------- reading

export interface ParsedEvent {
  text?: string
  /** Reasoning text, if the model emits it separately (counted, never shown). */
  reasoning?: string
  usage?: Usage
  finishReason?: string
}

interface UpstreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
}

function readUsage(u: UpstreamUsage | undefined): Usage | undefined {
  if (!u) return undefined
  const input = u.prompt_tokens ?? u.input_tokens
  const output = u.completion_tokens ?? u.output_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return { inputTokens: input, outputTokens: output }
}

/** One parsed upstream event (a streamed chunk or a whole response). */
export function parseUpstream(json: unknown, whole = false): ParsedEvent {
  if (!json || typeof json !== 'object') return {}
  const o = json as Record<string, unknown>
  const usage = readUsage(o.usage as UpstreamUsage | undefined)
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined
  if (choice) {
    const d = (whole ? choice.message : choice.delta) as Record<string, unknown> | undefined
    const text = typeof d?.content === 'string' ? d.content : undefined
    const reasoning = typeof d?.reasoning_content === 'string' ? d.reasoning_content : typeof d?.reasoning === 'string' ? d.reasoning : undefined
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined
    return { text, reasoning, usage, finishReason }
  }
  // Older Workers AI shape. In JSON mode `response` may already be an object.
  const r = o.response
  const text = typeof r === 'string' ? r : r && typeof r === 'object' ? JSON.stringify(r) : undefined
  return { text, usage }
}

/** Splits a byte stream of server-sent events into parsed `data:` payloads. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        finished = true
        break
      }
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '')
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        try {
          yield parseUpstream(JSON.parse(data))
        } catch {
          /* a keep-alive or a line we don't understand */
        }
      }
    }
  } finally {
    // Stopped early (the student pressed Stop or closed the app): stop the model too.
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

// ------------------------------------------------------------- errors

export type UpstreamErrorKind = 'free_allocation' | 'rate_limited' | 'capacity' | 'model_unavailable' | 'json_mode' | 'bad_request' | 'other'

/** Sorts a Workers AI error by its message (they carry numeric codes such as 4006). */
export function classifyUpstream(err: unknown): { kind: UpstreamErrorKind; detail: string } {
  const detail = String((err as Error)?.message ?? err).slice(0, 300)
  if (/4006|daily free allocation|neurons/i.test(detail)) return { kind: 'free_allocation', detail }
  if (/3040|capacity/i.test(detail)) return { kind: 'capacity', detail }
  if (/429|rate limit|too many requests|3036/i.test(detail)) return { kind: 'rate_limited', detail }
  if (/5007|no such model|model .*not found|not supported/i.test(detail)) return { kind: 'model_unavailable', detail }
  if (/json mode/i.test(detail)) return { kind: 'json_mode', detail }
  if (/^.{0,20}(400|5006|5021|3030)\b|invalid input|validation/i.test(detail)) return { kind: 'bad_request', detail }
  return { kind: 'other', detail }
}
