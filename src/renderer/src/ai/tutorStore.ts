/**
 * Tutor chat state. Each page has its own conversation (kept for this session
 * only). Sending builds the context, adds the question and an answer
 * placeholder, and streams the answer into it.
 */
import { create } from 'zustand'
import type { AiError, AiModelId, AiPart } from '@shared/ai'
import { useStore } from '@/store/store'
import { buildContext, hasSelection, type ContextKind, type ImageRegion } from './context'
import { cancelAi, preflight, startAi } from './client'
import { buildTurns, type ThreadEntry } from './turns'

export type QuickAction = 'hint' | 'explain' | 'check' | 'similar'
export type TutorTab = 'chat' | 'page' | 'practice'

export const QUICK: Record<QuickAction, { label: string; prompt: string }> = {
  hint: { label: 'Give me a hint', prompt: 'Give me a hint for the next step. Do not give the final answer.' },
  explain: { label: 'Explain the concept', prompt: 'Explain the concept behind this problem step by step, with a short example.' },
  check: { label: 'Check my work', prompt: 'Check my work. Find the first mistake, if any, explain why it is wrong and how to fix it.' },
  similar: { label: 'Try a similar problem', prompt: 'Give me one similar problem to practise, without the solution.' }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'model'
  /** Shown text: the question, or the (streaming) answer. */
  text: string
  status: 'pending' | 'streaming' | 'done' | 'error' | 'canceled'
  error?: AiError
  /** User messages: what was sent and where its image came from. */
  parts?: AiPart[]
  context?: { kind: Exclude<ContextKind, 'none'>; label: string; thumb?: string }
  region?: ImageRegion
  quick?: QuickAction
  model?: AiModelId
}

interface TutorState {
  tab: TutorTab
  threads: Record<string, ChatMessage[]>
  running: { key: string; messageId: string; requestId: string | null } | null
  /** `auto` = the selection if there is one, otherwise the page. */
  contextChoice: 'auto' | 'none'
  setTab(tab: TutorTab): void
  setContextChoice(choice: 'auto' | 'none'): void
  send(input: { text?: string; quick?: QuickAction }): Promise<void>
  retry(modelMessageId: string): Promise<void>
  stop(): void
  clear(): void
}

let seq = 0
const newId = (): string => `m${Date.now().toString(36)}${(seq++).toString(36)}`
export const TUTOR_INPUT_ID = 'tutor-input'

/** Opens the tutor on its chat and puts the caret in the question box. */
export function openTutorChat(): void {
  if (!useStore.getState().tutorOpen) useStore.getState().toggle('tutorOpen')
  useTutor.getState().setTab('chat')
  requestAnimationFrame(() => document.getElementById(TUTOR_INPUT_ID)?.focus())
}

export const threadKey = (): string => useStore.getState().activePageId ?? 'library'

export const useTutor = create<TutorState>((set, get) => {
  const update = (key: string, id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)): void =>
    set((s) => ({
      threads: { ...s.threads, [key]: (s.threads[key] ?? []).map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)) }
    }))
  const append = (key: string, ...msgs: ChatMessage[]): void => set((s) => ({ threads: { ...s.threads, [key]: [...(s.threads[key] ?? []), ...msgs] } }))

  /** Sends a user message already in the thread and streams the answer into a new model message. */
  const ask = async (key: string, user: ChatMessage): Promise<void> => {
    const thread = get().threads[key] ?? []
    const before = thread.slice(0, thread.findIndex((m) => m.id === user.id))
    const history: ThreadEntry[] = before.map((m) => ({ role: m.role, parts: m.role === 'user' ? (m.parts ?? []) : [{ text: m.text }], ok: m.status === 'done' || (m.status === 'canceled' && !!m.text) }))
    const answer: ChatMessage = { id: newId(), role: 'model', text: '', status: 'pending' }
    append(key, answer)
    set({ running: { key, messageId: answer.id, requestId: null } })
    const finish = (patch: Partial<ChatMessage>): void => {
      update(key, answer.id, patch)
      if (get().running?.messageId === answer.id) set({ running: null })
    }
    const result = await startAi(
      { task: 'chat', turns: buildTurns(history, user.parts!) },
      {
        onDelta: (text) => update(key, answer.id, (m) => ({ text: m.text + text, status: 'streaming' })),
        onDone: (e) => finish({ text: e.text, status: 'done', model: e.model }),
        onError: (error) => finish(error.code === 'canceled' ? { status: 'canceled' } : { status: 'error', error })
      }
    )
    if ('error' in result) finish({ status: 'error', error: result.error })
    else if (get().running?.messageId === answer.id) set({ running: { key, messageId: answer.id, requestId: result.requestId } })
  }

  return {
    tab: 'chat',
    threads: {},
    running: null,
    contextChoice: 'auto',
    setTab: (tab) => set({ tab }),
    setContextChoice: (contextChoice) => set({ contextChoice }),

    async send({ text, quick }) {
      if (get().running) return
      const question = (text ?? '').trim()
      if (!question && !quick) return
      const key = threadKey()
      const shown = quick ? QUICK[quick].label + (question ? ` — ${question}` : '') : question
      const user: ChatMessage = { id: newId(), role: 'user', text: shown, status: 'done', quick }
      const blocked = await preflight()
      if (blocked) {
        append(key, user, { id: newId(), role: 'model', text: '', status: 'error', error: blocked })
        return
      }
      const kind: ContextKind = get().contextChoice === 'none' ? 'none' : hasSelection() ? 'selection' : 'page'
      let ctx
      try {
        ctx = await buildContext(kind)
      } catch (err) {
        append(key, user, { id: newId(), role: 'model', text: '', status: 'error', error: { code: 'bad_request', message: (err as Error).message } })
        return
      }
      const prompt = quick ? `${QUICK[quick].prompt}${question ? `\n\n${question}` : ''}` : question
      user.parts = [...(ctx?.parts ?? []), { text: prompt }]
      if (ctx) {
        user.context = { kind: ctx.kind, label: ctx.label, thumb: ctx.thumb }
        user.region = ctx.region
      }
      append(key, user)
      await ask(key, user)
    },

    async retry(modelMessageId) {
      if (get().running) return
      const key = threadKey()
      const thread = get().threads[key] ?? []
      const i = thread.findIndex((m) => m.id === modelMessageId)
      const user = thread[i - 1]
      if (i < 1 || user?.role !== 'user' || !user.parts) return
      set((s) => ({ threads: { ...s.threads, [key]: thread.filter((m) => m.id !== modelMessageId) } }))
      const blocked = await preflight()
      if (blocked) return append(key, { id: newId(), role: 'model', text: '', status: 'error', error: blocked })
      await ask(key, user)
    },

    stop() {
      const r = get().running
      if (r?.requestId) cancelAi(r.requestId)
    },

    clear() {
      if (get().running) get().stop()
      const key = threadKey()
      set((s) => ({ threads: { ...s.threads, [key]: [] } }))
    }
  }
})
