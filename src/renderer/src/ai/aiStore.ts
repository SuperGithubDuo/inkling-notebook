/**
 * Renderer-side view of the AI connection: status from the main process and
 * the consent prompt. The key itself never reaches the renderer.
 *
 * The main process pushes a fresh status whenever the cloud server reports
 * the allowance (after every answer, structured or not), so the count shown
 * stays current without restarting. At the UTC reset the status is re-read
 * once, which costs no model usage.
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
let listening = false
let resetTimer: ReturnType<typeof setTimeout> | null = null
/** Re-read a little after midnight UTC, so the server has started the new day. */
const RESET_SLACK_MS = 5_000
/** setTimeout can't wait longer than about 24.8 days. */
const MAX_TIMER_MS = 2_147_000_000

/** Listens for status pushed by the main process (once per window). */
function listen(): void {
  if (listening || typeof window === 'undefined' || !window.inkling?.ai?.onEvent) return
  listening = true
  window.inkling.ai.onEvent((e) => {
    if (e.type === 'status') useAi.getState().setStatus(e.status)
  })
}

/** Schedules one status re-read for when today's cloud allowance resets. */
function scheduleReset(status: AiStatus): void {
  if (resetTimer) clearTimeout(resetTimer)
  resetTimer = null
  const resetAt = status.provider === 'cloud' && status.cloud.quota ? Date.parse(status.cloud.quota.resetAt) : NaN
  if (!Number.isFinite(resetAt)) return
  const wait = Math.min(MAX_TIMER_MS, Math.max(0, resetAt - Date.now()) + RESET_SLACK_MS)
  resetTimer = setTimeout(() => {
    resetTimer = null
    void useAi.getState().load()
  }, wait)
}

export const useAi = create<AiState>((set, get) => ({
  status: null,
  consentOpen: false,
  settingsOpen: false,
  async load() {
    listen()
    const status = await window.inkling.ai.status()
    get().setStatus(status)
    return status
  },
  setStatus(status) {
    listen()
    set({ status })
    scheduleReset(status)
  },
  async ensureConsent() {
    const status = get().status ?? (await get().load())
    if (status.consented) return true
    set({ consentOpen: true })
    return new Promise<boolean>((resolve) => pendingConsent.push(resolve))
  },
  async answerConsent(accepted) {
    const status = await window.inkling.ai.setConsent(accepted)
    get().setStatus(status)
    set({ consentOpen: false })
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
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
