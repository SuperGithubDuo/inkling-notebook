/**
 * Starts AI requests through the main process and routes the streamed events
 * back to whoever started them.
 */
import type { AiError, AiEvent, AiRequest } from '@shared/ai'
import { useAi } from './aiStore'

export interface AiHandlers {
  onDelta?(text: string): void
  onDone(event: Extract<AiEvent, { type: 'done' }>): void
  onError(error: AiError): void
}

const handlers = new Map<string, AiHandlers>()
/** Events that arrive before start() has returned the request id. */
const early = new Map<string, AiEvent[]>()
let subscribed = false

function dispatch(h: AiHandlers, e: AiEvent): void {
  if (e.type === 'delta') return h.onDelta?.(e.text)
  handlers.delete(e.requestId)
  if (e.type === 'done') h.onDone(e)
  else {
    // Rate limits change the status (cooldown) shown in Settings.
    if (e.error.code === 'rate_limited' || e.error.code === 'daily_quota') void useAi.getState().load()
    h.onError(e.error)
  }
}

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.inkling.ai.onEvent((e) => {
    const h = handlers.get(e.requestId)
    if (h) return dispatch(h, e)
    const list = early.get(e.requestId) ?? []
    list.push(e)
    early.set(e.requestId, list)
    if (early.size > 20) early.delete(early.keys().next().value!)
  })
}

/**
 * Checks, before anything is built or sent, that a key is set and the user
 * has agreed to send content to Gemini (asking now if they have not).
 */
export async function preflight(): Promise<AiError | null> {
  subscribe()
  const ai = useAi.getState()
  const status = ai.status ?? (await ai.load())
  if (!status.hasKey) return { code: 'no_key', message: 'Add a free Gemini API key in AI settings to use the tutor.' }
  if (!(await ai.ensureConsent())) return { code: 'consent_required', message: 'Nothing was sent. The tutor needs your permission to send this to Google Gemini.' }
  return null
}

export async function startAi(request: AiRequest, h: AiHandlers): Promise<{ requestId: string } | { error: AiError }> {
  subscribe()
  let result
  try {
    result = await window.inkling.ai.start(request)
  } catch (err) {
    return { error: { code: 'bad_request', message: `Could not send the request: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': /, '')}` } }
  }
  if ('error' in result) {
    if (result.error.code === 'rate_limited' || result.error.code === 'daily_quota') void useAi.getState().load()
    return result
  }
  handlers.set(result.requestId, h)
  const pending = early.get(result.requestId)
  early.delete(result.requestId)
  for (const e of pending ?? []) if (handlers.has(result.requestId)) dispatch(h, e)
  return result
}

export function cancelAi(requestId: string): void {
  void window.inkling.ai.cancel(requestId)
}
