/**
 * Turns a chat thread into the conversation sent to the model, keeping it
 * small: only the last few exchanges, earlier answers shortened, failed
 * exchanges dropped, and at most one earlier image (the most recent one) so
 * follow-up questions about the same handwriting still work.
 */
import type { AiPart, AiTurn } from '@shared/ai'

export interface ThreadEntry {
  role: 'user' | 'model'
  /** What was sent for user entries; the answer text for model entries. */
  parts: AiPart[]
  ok: boolean
}

export const HISTORY_ENTRIES = 10
export const MAX_ANSWER_CHARS = 4000
/** Text this long or longer (notebook content, not a short question) is sent once if a later message repeats it. */
export const REPEAT_MIN_CHARS = 300
export const REPEATED = '(The same notebook content as in a later message.)'

/**
 * The earlier messages that may go with a new question to `provider`: only those
 * this same provider handled. After a switch (say from Ollama, on this computer,
 * to a cloud AI) the earlier conversation stays on screen but is not sent, so
 * nothing written for one service reaches another. Messages with no recorded
 * provider are left out too.
 */
export function historyFor<T extends { provider?: string }>(messages: T[], provider: string | undefined): T[] {
  if (!provider) return []
  return messages.filter((m) => m.provider === provider)
}

export function buildTurns(history: ThreadEntry[], current: AiPart[]): AiTurn[] {
  // Keep only complete exchanges: a user entry followed by a usable answer.
  const pairs: [ThreadEntry, ThreadEntry][] = []
  for (let i = 0; i < history.length - 1; i++) {
    const u = history[i]!
    const m = history[i + 1]!
    if (u.role === 'user' && m.role === 'model' && m.ok) {
      pairs.push([u, m])
      i++
    }
  }
  const kept = pairs.slice(-(HISTORY_ENTRIES / 2))
  const currentHasImage = current.some((p) => 'image' in p)
  // The most recent earlier image survives only if this turn has none.
  let imageOwner = -1
  if (!currentHasImage) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i]![0].parts.some((p) => 'image' in p)) {
        imageOwner = i
        break
      }
    }
  }
  // Notebook content repeated in a later message (the same page asked about again) is sent once,
  // with its latest copy: the model still sees it, and the request isn't paying for it five times.
  const later = new Set<string>()
  for (const p of current) if ('text' in p && p.text.length >= REPEAT_MIN_CHARS) later.add(p.text)
  const dedupedUser: AiPart[][] = new Array(kept.length)
  for (let i = kept.length - 1; i >= 0; i--) {
    const own = kept[i]![0].parts
    dedupedUser[i] = own.map((p) => ('text' in p && p.text.length >= REPEAT_MIN_CHARS && later.has(p.text) ? { text: REPEATED } : p))
    for (const p of own) if ('text' in p && p.text.length >= REPEAT_MIN_CHARS) later.add(p.text)
  }
  const turns: AiTurn[] = []
  kept.forEach(([, m], i) => {
    const parts = dedupedUser[i]!.filter((p) => 'text' in p || i === imageOwner)
    turns.push({ role: 'user', parts: parts.length ? parts : [{ text: '(image omitted)' }] })
    const answer = m.parts.map((p) => ('text' in p ? p.text : '')).join('')
    turns.push({ role: 'model', parts: [{ text: answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer || '(no answer)' }] })
  })
  turns.push({ role: 'user', parts: current })
  return turns
}
