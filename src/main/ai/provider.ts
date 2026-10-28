/**
 * What Inkling needs from a model provider. Gemini implements it today; a
 * local Ollama model (e.g. Qwen3-VL), OpenRouter or Anthropic Claude can be
 * added as further implementations without touching the tutor or the UI.
 */
import type { AiError, AiErrorCode, AiTurn, AiUsage } from '@shared/ai'

export interface ProviderModel {
  /** Model id without any `models/` prefix. */
  id: string
  displayName?: string
  inputTokenLimit?: number
  canGenerate: boolean
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
  readonly id: string
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
