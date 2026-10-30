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

/**
 * Where answers come from.
 * - cloud: Inkling's free AI server (Cloudflare Workers AI, Qwen 3.8). Works
 *   right away: no download, account, code or key; a daily allowance applies.
 * - ollama: a vision model on this computer. Free, private, offline, no
 *   limits, but needs a few GB of download and memory.
 * - gemini: optional, with the user's own Google key; adults only.
 * A build made with the server address (MAIN_VITE_INKLING_BETA_URL) starts on
 * the cloud; otherwise on Ollama. A saved choice is always kept.
 */
export const providerIdSchema = z.enum(['cloud', 'ollama', 'gemini'])
export type AiProviderId = z.infer<typeof providerIdSchema>
export const DEFAULT_PROVIDER: AiProviderId = 'ollama'

export const PROVIDERS: Record<AiProviderId, { label: string; local: boolean; description: string }> = {
  cloud: { label: 'Inkling AI (cloud)', local: false, description: 'Free and ready to use: nothing to download, no account. A daily limit on answers applies.' },
  ollama: { label: 'Ollama (on this computer)', local: true, description: 'Free and private: a vision model runs on this computer. No account or API key.' },
  gemini: { label: 'Google Gemini', local: false, description: 'Optional cloud models. Requires a Google API key, and Google only permits users who are 18 or older.' }
}

/** The model behind the cloud AI. The server decides; this is what it is configured with. */
export const CLOUD_MODEL = '@cf/qwen/qwen3.8-27b'
export const CLOUD_MODEL_LABEL = 'Qwen 3.8 27B (Cloudflare Workers AI)'
/** What the cloud AI does with notebook content, shown wherever it can be chosen. */
export const CLOUD_DATA_NOTE =
  'Your question and an image of what you selected go to Inkling’s AI server and are answered by Cloudflare Workers AI. Neither keeps your content: Cloudflare says it does not use it to train models or store it after answering, and Inkling’s server never stores or logs it. To share out the free daily allowance, the server counts answers per installation (a random ID this app made) and per internet connection, in scrambled form that is deleted every day.'
export const CLOUD_TERMS_URL = 'https://developers.cloudflare.com/workers-ai/platform/privacy/'

/** The AI server address: https, or http on this computer (for testing). */
export const betaUrlSchema = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((u) => {
    // zod runs this even when .url() has already failed, so it must not throw.
    let url: URL
    try {
      url = new URL(u)
    } catch {
      return false
    }
    if (url.username || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(url.host.replace(/:\d+$/, ''))
  }, 'Use the https:// address you were given.')
  .transform((u) => u.replace(/\/+$/, ''))

/** Why Gemini is optional, shown wherever it can be chosen. */
export const GEMINI_ELIGIBILITY =
  'Google’s Gemini API terms require users to be 18 or older and do not allow it in apps likely to be used by people under 18. Students under 18 should use the local Ollama tutor.'

export interface AiModelInfo {
  id: string
  label: string
  description: string
  /** Download size, for local models. */
  size?: string
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
export const geminiModelIdSchema = z.enum(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
export type GeminiModelId = z.infer<typeof geminiModelIdSchema>
/** @deprecated name kept for older imports; use geminiModelIdSchema. */
export const modelIdSchema = geminiModelIdSchema

/**
 * Local vision models Inkling recommends; any other installed vision model can
 * be chosen too. The "-instruct" builds answer directly. The plain tags
 * (qwen3-vl:4b etc.) are Qwen3-VL's *thinking* builds: they reason at length
 * before every answer and Ollama doesn't let that be switched off, which made
 * them about 3× slower on a CPU in testing (same answers), so they are listed
 * only when installed, marked as slower.
 */
export const OLLAMA_MODELS: readonly AiModelInfo[] = [
  { id: 'qwen3-vl:4b-instruct', label: 'Qwen3-VL 4B', size: '3.3 GB', description: 'Recommended. Most accurate markups in testing. Needs about 5.5 GB of free memory (16 GB computers, or 8 GB with little else open).' },
  { id: 'qwen3-vl:2b-instruct', label: 'Qwen3-VL 2B', size: '1.9 GB', description: 'For 8 GB computers. Faster, reads well, but its markups are less reliable.' },
  { id: 'qwen3-vl:8b-instruct', label: 'Qwen3-VL 8B', size: '6.2 GB', description: 'Most capable. Needs about 16 GB RAM or a GPU with 8 GB.' }
] as const
export const OLLAMA_DEFAULT_MODEL = 'qwen3-vl:4b-instruct'
/** Shown for an installed model that reasons before answering (e.g. qwen3-vl:4b). */
export const THINKING_MODEL_NOTE = 'Thinking build: reasons step by step before answering, so it is much slower, especially without a GPU. The matching “-instruct” model answers directly.'
/** An Ollama model name such as `qwen3-vl:4b` or `user/model:tag`. */
export const ollamaModelIdSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,2}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/, 'Not an Ollama model name')
/** Model ids are provider-specific strings, validated by the schema of the active provider. */
export type AiModelId = string
export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

export const modelLabel = (id: string): string =>
  id === CLOUD_MODEL ? 'Qwen 3.8 27B' : ([...GEMINI_MODELS, ...OLLAMA_MODELS].find((m) => m.id === id)?.label ?? id.replace(/^qwen3-vl:(\d+)b$/, 'Qwen3-VL $1B (thinking)'))

/** Version of the data-use notice. Raising it asks the user to agree again. */
export const CONSENT_VERSION = 2
/** Version of the cloud AI's data notice (CLOUD_DATA_NOTE). 2: public access, anonymous IDs. */
export const CLOUD_CONSENT_VERSION = 2

/** This installation's anonymous ID for the cloud AI's fair-use limits (not secret, not an account). */
export const installIdSchema = z.string().regex(/^inst_[A-Za-z0-9_-]{22,64}$/)

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
  | 'offline' // the local Ollama server is not running
  | 'beta_closed' // the cloud AI is paused by its operator
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
  /** Local models: shown with this label (installed models Inkling doesn't list itself). */
  label?: string
  /** Local models: installed size in bytes. */
  sizeBytes?: number
  /** Local models: false when the installed model cannot read images. */
  vision?: boolean
  /** Local models: a reasoning ("thinking") build, slower. */
  thinking?: boolean
}

/** State of the local Ollama server, as of the last check. */
export interface OllamaState {
  url: string
  /** null until checked. */
  running: boolean | null
  version: string | null
  checkedAt: string | null
}

/**
 * The cloud AI allowance, as the server last reported it. Neurons are
 * Cloudflare's unit of Workers AI usage; the UI shows them as a share of the
 * day and as an approximate number of answers.
 */
export interface CloudQuota {
  /** This installation's use today. */
  installUsed: number
  installLimit: number
  /** Use today from this internet connection (shared with others on it). */
  networkUsed: number
  networkLimit: number
  /** Everyone's use today, against the service's cap (kept below Cloudflare's free 10,000). */
  globalUsed: number
  globalLimit: number
  /** Rough number of typical answers left today here. */
  approxAnswersLeft: number
  /** When the allowance resets (00:00 UTC, like Cloudflare's own). */
  resetAt: string
}

export interface CloudState {
  url: string | null
  /** Whether the server address came with this build. */
  urlFromBuild: boolean
  consented: boolean
  quota: CloudQuota | null
  checkedAt: string | null
}

export interface AiStatus {
  provider: AiProviderId
  /** True when the active provider processes everything on this computer. */
  local: boolean
  model: AiModelId
  /** The active provider needs an API key (Gemini). */
  needsKey: boolean
  /** A Gemini key is saved. */
  hasKey: boolean
  /** Last four characters, so the user can tell keys apart. */
  keyHint: string | null
  /** encrypted: OS keychain; weak: OS storage without a keyring; session: not saved. */
  keyProtection: KeyProtection | null
  /** May notebook content go to the active provider? Always true for a local one. */
  consented: boolean
  /** The user has agreed to Gemini's data use (and its age requirement). */
  geminiConsented: boolean
  /** Models of the active provider; for Ollama also other installed vision models. */
  models: ModelAvailability[]
  ollama: OllamaState
  cloud: CloudState
  /** ISO time the model list was last fetched. */
  modelsCheckedAt: string | null
  /** Set while the app is waiting out a rate limit or exhausted quota. */
  cooldown: { until: string; reason: 'rate_limited' | 'daily_quota'; model: AiModelId } | null
}

/** Can the tutor be asked something right now (as far as the app knows)? */
export function aiReady(s: AiStatus): boolean {
  if (s.provider === 'gemini') return s.hasKey && s.consented
  if (s.provider === 'cloud') return !!s.cloud.url
  return s.ollama.running !== false && s.models.find((m) => m.id === s.model)?.status !== 'missing'
}

export type AiTestResult = { ok: true; model: AiModelId; latencyMs: number; models: ModelAvailability[] } | { ok: false; error: AiError }

export type AiStartResult = { requestId: string } | { error: AiError }

export interface AiUsage {
  inputTokens?: number
  outputTokens?: number
  /** Milliseconds from sending to the first streamed text (includes loading a local model). */
  firstTokenMs?: number
  /** Milliseconds from sending to the complete answer. */
  totalMs?: number
  /** Cloud AI: Workers AI Neurons this answer used (from the model's token counts). */
  neurons?: number
}

export type AiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; text: string; usage: AiUsage; model: AiModelId }
  | { requestId: string; type: 'error'; error: AiError }
  /**
   * The main process's status changed without the renderer asking: the cloud
   * server reported a new allowance (with an answer, a refusal or a status
   * check). Not tied to a request; sent before that request's done or error.
   */
  | { requestId?: undefined; type: 'status'; status: AiStatus }

/** Accepted shape of a Gemini API key (format only; Google decides validity). */
export const apiKeySchema = z
  .string()
  .trim()
  .min(20, 'That does not look like a Gemini API key.')
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'That does not look like a Gemini API key.')
