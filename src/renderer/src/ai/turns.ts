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
  const turns: AiTurn[] = []
  kept.forEach(([u, m], i) => {
    const parts = u.parts.filter((p) => 'text' in p || i === imageOwner)
    turns.push({ role: 'user', parts: parts.length ? parts : [{ text: '(image omitted)' }] })
    const answer = m.parts.map((p) => ('text' in p ? p.text : '')).join('')
    turns.push({ role: 'model', parts: [{ text: answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer || '(no answer)' }] })
  })
  turns.push({ role: 'user', parts: current })
  return turns
}
