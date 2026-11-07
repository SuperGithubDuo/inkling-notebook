/**
 * Talking to the model on Workers AI: building the chat messages from
 * Inkling's turns, estimating a request's cost before it is sent, and reading
 * the model's answer (streamed server-sent events or a single JSON body) in
 * either of the two shapes Workers AI uses (OpenAI-style `choices[].delta`
 * or the older `{ response }`).
 */
import type { AiTurn } from '../../src/shared/ai'
import { UpstreamError, type UpstreamKind } from './provider'

/**
 * Prices in the ledger's cost unit per million tokens: Neurons on Workers AI,
 * micro-dollars (µ$, 1e-6 USD) on an external provider.
 */
export interface Rates {
  /** Cost units per million input tokens. */
  inputPerM: number
  /** Cost units per million output tokens, reasoning included. */
  outputPerM: number
  /** Cost units per million input tokens read from the provider's prompt cache (defaults to inputPerM). */
  cachedInputPerM?: number
  /** 'usd': units are micro-dollars and a provider-reported dollar cost is used when present. */
  unit?: 'neurons' | 'usd'
  /** Multiplier for fees the token price doesn't include (e.g. OpenRouter's 5.5% on credits). */
  costMultiplier?: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Input tokens the provider served from its prompt cache (billed at the cached rate). */
  cachedInputTokens?: number
  /** What the provider says it charged, in USD (OpenRouter's usage.cost), when reported. */
  reportedCostUsd?: number
}

export const neuronsFor = (u: Usage, r: Rates): number => (u.inputTokens * r.inputPerM + u.outputTokens * r.outputPerM) / 1e6

/**
 * The cost of an answer in the ledger's unit. The provider's own token counts
 * are used (its tokenizer, its image accounting, its cached-token count), priced
 * at the configured list price. When the provider also reports a dollar cost
 * (OpenRouter's usage.cost, DeepInfra's usage.estimated_cost), the HIGHER of the
 * two is charged: a promotional price never makes the caps count less than list
 * price, and a price rise above the configured one is still counted in full.
 */
export function costFor(u: Usage, r: Rates): number {
  const mult = r.costMultiplier ?? 1
  const cached = Math.min(u.inputTokens, Math.max(0, u.cachedInputTokens ?? 0))
  const cachedRate = r.cachedInputPerM ?? r.inputPerM
  const listed = (((u.inputTokens - cached) * r.inputPerM + cached * cachedRate + u.outputTokens * r.outputPerM) / 1e6) * mult
  const reported = reportedCost(u, r)
  return reported === undefined ? listed : Math.max(listed, reported)
}

/** The provider's own reported charge in the ledger's unit (µ$, fees included), when it gave one. */
export function reportedCost(u: Usage, r: Rates): number | undefined {
  if (r.unit !== 'usd' || typeof u.reportedCostUsd !== 'number' || !Number.isFinite(u.reportedCostUsd) || u.reportedCostUsd < 0) return undefined
  return u.reportedCostUsd * 1e6 * (r.costMultiplier ?? 1)
}

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
  /** The provider reported an error inside a 200 response or mid-stream (OpenRouter does this). */
  error?: true
}

interface UpstreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  /** OpenRouter: what it charged, in USD. */
  cost?: number
  /** DeepInfra: its own cost estimate, in USD, when it reports one. */
  estimated_cost?: number
}

function readUsage(u: UpstreamUsage | undefined): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const input = u.prompt_tokens ?? u.input_tokens
  const output = u.completion_tokens ?? u.output_tokens
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined
  const usage: Usage = { inputTokens: input, outputTokens: output }
  const cached = u.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) usage.cachedInputTokens = cached
  const cost = typeof u.cost === 'number' ? u.cost : typeof u.estimated_cost === 'number' ? u.estimated_cost : undefined
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) usage.reportedCostUsd = cost
  return usage
}

/** One parsed upstream event (a streamed chunk or a whole response). */
export function parseUpstream(json: unknown, whole = false): ParsedEvent {
  if (!json || typeof json !== 'object') return {}
  const o = json as Record<string, unknown>
  if (o.error && typeof o.error === 'object') return { error: true }
  const usage = readUsage(o.usage as UpstreamUsage | undefined)
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined
  if (choice) {
    const d = (whole ? choice.message : choice.delta) as Record<string, unknown> | undefined
    const text = typeof d?.content === 'string' ? d.content : undefined
    const reasoning = typeof d?.reasoning_content === 'string' ? d.reasoning_content : typeof d?.reasoning === 'string' ? d.reasoning : undefined
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined
    if (finishReason === 'error') return { text, reasoning, usage, finishReason, error: true }
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

export type UpstreamErrorKind = UpstreamKind

/**
 * Sorts a provider error. External providers throw an UpstreamError that
 * already carries its kind; Workers AI errors are sorted by their message
 * (they carry numeric codes such as 4006).
 */
export function classifyUpstream(err: unknown): { kind: UpstreamErrorKind; detail: string } {
  if (err instanceof UpstreamError) return { kind: err.kind, detail: err.message }
  const detail = String((err as Error)?.message ?? err).slice(0, 300)
  if (/\b4006\b|daily free allocation/i.test(detail)) return { kind: 'free_allocation', detail }
  if (/3040|capacity/i.test(detail)) return { kind: 'capacity', detail }
  if (/429|rate limit|too many requests|3036/i.test(detail)) return { kind: 'rate_limited', detail }
  // 5035: the model isn't available on the account's plan (e.g. a model listed but not on Workers Free).
  if (/5007|5035|no such model|model .*not found|not supported|not available on the workers free plan/i.test(detail)) return { kind: 'model_unavailable', detail }
  if (/json mode/i.test(detail)) return { kind: 'json_mode', detail }
  if (/^.{0,20}(400|5006|5021|3030)\b|invalid input|validation/i.test(detail)) return { kind: 'bad_request', detail }
  return { kind: 'other', detail }
}
