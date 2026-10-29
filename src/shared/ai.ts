/**
 * The AI contract shared by the main process (which talks to the provider)
 * and the renderer (which builds requests and shows results).
 *
 * The renderer never sees an API key or picks a system prompt: it sends a
 * request with a `task` and conversation turns; the main process chooses the
 * instructions and output schema for that task, applies the user's consent,
 * key, model and rate limits, and streams the answer back.
 */
import { z } from 'zod'

export type AiProviderId = 'gemini'

export interface AiModelInfo {
  id: string
  label: string
  description: string
}

/**
 * Models Inkling may use. Only models that are free on the Gemini API's free
 * tier are listed; the app never switches to another model on its own.
 */
export const GEMINI_MODELS: readonly AiModelInfo[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Best quality on the free tier. Recommended.' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', description: 'Lighter and faster, with more generous free limits.' }
] as const
export const DEFAULT_MODEL = 'gemini-3.8-flash'
export const LITE_MODEL = 'gemini-3.5-flash-lite'
export const modelIdSchema = z.enum(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
export type AiModelId = z.infer<typeof modelIdSchema>
export const modelLabel = (id: string): string => GEMINI_MODELS.find((m) => m.id === id)?.label ?? id

/** Version of the data-use notice. Raising it asks the user to agree again. */
export const CONSENT_VERSION = 1

// ---------------------------------------------------------------- requests

/** What the request is for. Each task has its own instructions and output format. */
export const aiTaskSchema = z.enum(['chat', 'practice', 'check', 'annotate'])
export type AiTask = z.infer<typeof aiTaskSchema>

/** Images are downscaled JPEG/PNG crops; anything bigger is refused. */
export const MAX_IMAGE_BASE64 = 1_400_000 // ≈ 1 MB of image
export const MAX_IMAGES_PER_REQUEST = 2
export const MAX_TEXT_PART = 24_000
export const MAX_TURNS = 24
export const MAX_REQUEST_TEXT = 60_000

const textPart = z.object({ text: z.string().min(1).max(MAX_TEXT_PART) })
const imagePart = z.object({
  image: z.object({
    mimeType: z.enum(['image/jpeg', 'image/png']),
    data: z.string().max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/)
  })
})
export const aiPartSchema = z.union([textPart, imagePart])
export type AiPart = z.infer<typeof aiPartSchema>
export const aiTurnSchema = z.object({ role: z.enum(['user', 'model']), parts: z.array(aiPartSchema).min(1).max(8) })
export type AiTurn = z.infer<typeof aiTurnSchema>

export const aiRequestSchema = z
  .object({
    task: aiTaskSchema,
    turns: z.array(aiTurnSchema).min(1).max(MAX_TURNS)
  })
  .superRefine((req, ctx) => {
    const parts = req.turns.flatMap((t) => t.parts)
    if (parts.filter((p) => 'image' in p).length > MAX_IMAGES_PER_REQUEST) {
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_IMAGES_PER_REQUEST} images per request` })
    }
    const text = parts.reduce((n, p) => n + ('text' in p ? p.text.length : 0), 0)
    if (text > MAX_REQUEST_TEXT) ctx.addIssue({ code: 'custom', message: 'Request text is too long' })
    if (req.turns[req.turns.length - 1]!.role !== 'user') ctx.addIssue({ code: 'custom', message: 'Last turn must be from the user' })
  })
export type AiRequest = z.infer<typeof aiRequestSchema>

// ------------------------------------------------------------------ errors

export type AiErrorCode =
  | 'no_key'
  | 'consent_required'
  | 'invalid_key'
  | 'rate_limited' // too many requests per minute: wait and retry
  | 'daily_quota' // free daily quota for this model used up
  | 'not_free' // the model has no free quota for this key's project
  | 'model_unavailable'
  | 'network'
  | 'server'
  | 'blocked'
  | 'bad_request'
  | 'busy' // another request is still running
  | 'duplicate' // the same request was just sent
  | 'canceled'
  | 'bad_response'
  | 'unknown'

export interface AiError {
  code: AiErrorCode
  /** Friendly, actionable text for the user. */
  message: string
  /** Seconds to wait before retrying, when known. */
  retryAfter?: number
  /** Suggests letting the user switch to this (free) model themselves. */
  suggestModel?: AiModelId
}

// ------------------------------------------------------------------ status

export type KeyProtection = 'encrypted' | 'weak' | 'session'

export interface ModelAvailability {
  id: AiModelId
  /** `unknown` until the model list has been fetched with the current key. */
  status: 'available' | 'missing' | 'unknown'
  inputTokenLimit?: number
}

export interface AiStatus {
  provider: AiProviderId
  model: AiModelId
  hasKey: boolean
  /** Last four characters, so the user can tell keys apart. */
  keyHint: string | null
  /** encrypted: OS keychain; weak: OS storage without a keyring; session: not saved. */
  keyProtection: KeyProtection | null
  consented: boolean
  models: ModelAvailability[]
  /** ISO time the model list was last fetched. */
  modelsCheckedAt: string | null
  /** Set while the app is waiting out a rate limit or exhausted quota. */
  cooldown: { until: string; reason: 'rate_limited' | 'daily_quota'; model: AiModelId } | null
}

export type AiTestResult = { ok: true; model: AiModelId; latencyMs: number; models: ModelAvailability[] } | { ok: false; error: AiError }

export type AiStartResult = { requestId: string } | { error: AiError }

export interface AiUsage {
  inputTokens?: number
  outputTokens?: number
}

export type AiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; text: string; usage: AiUsage; model: AiModelId }
  | { requestId: string; type: 'error'; error: AiError }

/**
 * Accepted shape of a Gemini API key (format only; Google decides validity).
 * Google has used more than one format (legacy `AIza…` keys and newer `AQ.…`
 * keys), so we only require printable ASCII with no spaces, which is what an
 * HTTP header value can carry, rather than tying validation to any prefix.
 */
export const apiKeySchema = z
  .string()
  .trim()
  .min(20, 'That does not look like a Gemini API key.')
  .max(200)
  .regex(/^[\x21-\x7E]+$/, 'That does not look like a Gemini API key.')
