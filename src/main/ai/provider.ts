/**
 * What Inkling needs from a model provider. Local Ollama (ollama.ts, the
 * default) and Google Gemini (gemini.ts) implement it; OpenRouter or Anthropic
 * Claude could be added the same way without touching the tutor or the UI.
 */
import type { AiError, AiErrorCode, AiTurn, AiUsage } from '@shared/ai'

export interface ProviderModel {
  /** Model id without any `models/` prefix. */
  id: string
  displayName?: string
  inputTokenLimit?: number
  canGenerate: boolean
  /** Local models: can read images (undefined when the provider doesn't say). */
  vision?: boolean
  /** Local models: a reasoning ("thinking") model. */
  thinking?: boolean
  sizeBytes?: number
}

export interface ProviderRequest {
  model: string
  system: string
  turns: AiTurn[]
  /** When set, the model must answer with JSON matching this JSON Schema. */
  jsonSchema?: Record<string, unknown>
  maxOutputTokens: number
  temperature?: number
}

export type ProviderChunk = { type: 'text'; text: string } | { type: 'end'; usage: AiUsage; finishReason?: string }

export interface AiProvider {
  readonly id: 'gemini' | 'ollama'
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk>
}

/** An error already translated into something the user can act on. */
export class ProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryAfter?: number
  ) {
    super(message)
  }
  toJSON(): AiError {
    return { code: this.code, message: this.message, ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}) }
  }
}
