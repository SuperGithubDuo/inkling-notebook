/**
 * Renderer-side view of the AI connection: status from the main process and
 * the consent prompt. The key itself never reaches the renderer.
 */
import { create } from 'zustand'
import type { AiStatus } from '@shared/ai'

interface AiState {
  status: AiStatus | null
  consentOpen: boolean
  settingsOpen: boolean
  load(): Promise<AiStatus>
  setStatus(status: AiStatus): void
  /** Resolves true once the user has agreed to send content to Gemini. */
  ensureConsent(): Promise<boolean>
  answerConsent(accepted: boolean): Promise<void>
  openSettings(open: boolean): void
}

let pendingConsent: ((ok: boolean) => void)[] = []

export const useAi = create<AiState>((set, get) => ({
  status: null,
  consentOpen: false,
  settingsOpen: false,
  async load() {
    const status = await window.inkling.ai.status()
    set({ status })
    return status
  },
  setStatus(status) {
    set({ status })
  },
  async ensureConsent() {
    const status = get().status ?? (await get().load())
    if (status.consented) return true
    set({ consentOpen: true })
    return new Promise<boolean>((resolve) => pendingConsent.push(resolve))
  },
  async answerConsent(accepted) {
    const status = await window.inkling.ai.setConsent(accepted)
    set({ status, consentOpen: false })
    const waiting = pendingConsent
    pendingConsent = []
    for (const resolve of waiting) resolve(status.consented)
  },
  openSettings(open) {
    set({ settingsOpen: open })
  }
}))

export const GEMINI_TERMS_URL = 'https://ai.google.dev/gemini-api/terms'
export const GET_KEY_URL = 'https://aistudio.google.com/apikey'
export const RATE_LIMITS_URL = 'https://ai.google.dev/gemini-api/docs/rate-limits'
