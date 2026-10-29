/**
 * Practice mode: the tutor's model writes problems (with progressive hints, the answer
 * and a worked solution) from the page or selection; the student works them
 * by hand. Hints and solutions are revealed locally, one at a time, without
 * further requests; only checking an answer asks the model again.
 */
import { create } from 'zustand'
import type { AiError, AiPart } from '@shared/ai'
import { parseTaskResult, type CheckResult, type Difficulty, type PracticeSet } from '@shared/tutor'
import { useStore } from '@/store/store'
import { buildContext, hasSelection, type ContextKind } from './context'
import { cancelAi, preflight, startAi } from './client'

export type DifficultyChoice = Difficulty | 'mixed'

export interface ProblemProgress {
  hintsShown: number
  answer: string
  solutionShown: boolean
  check?: { status: 'checking' } | { status: 'done'; result: CheckResult; via: 'typed' | 'handwriting' } | { status: 'error'; error: AiError }
}

interface PracticeState {
  difficulty: DifficultyChoice
  count: number
  topic: string
  useContext: boolean
  set: PracticeSet | null
  source: string | null
  index: number
  progress: ProblemProgress[]
  generating: { requestId: string | null } | null
  error: AiError | null
  checkingId: string | null
  configure(patch: Partial<Pick<PracticeState, 'difficulty' | 'count' | 'topic' | 'useContext'>>): void
  generate(opts?: { count?: number; similar?: boolean }): Promise<void>
  cancel(): void
  go(index: number): void
  showHint(index: number): void
  showSolution(index: number): void
  setAnswer(index: number, answer: string): void
  check(index: number, via: 'typed' | 'handwriting'): Promise<void>
}

const emptyProgress = (): ProblemProgress => ({ hintsShown: 0, answer: '', solutionShown: false })

export const usePractice = create<PracticeState>((set, get) => {
  const patchProgress = (i: number, patch: Partial<ProblemProgress>): void =>
    set((s) => ({ progress: s.progress.map((p, j) => (j === i ? { ...p, ...patch } : p)) }))

  return {
    difficulty: 'medium',
    count: 3,
    topic: '',
    useContext: true,
    set: null,
    source: null,
    index: 0,
    progress: [],
    generating: null,
    error: null,
    checkingId: null,

    configure(patch) {
      set(patch)
    },

    async generate(opts = {}) {
      if (get().generating) return
      const { difficulty, topic, useContext } = get()
      const count = opts.count ?? get().count
      set({ error: null })
      const blocked = await preflight()
      if (blocked) return set({ error: blocked })
      set({ generating: { requestId: null } })
      const kind: ContextKind = !useContext && !opts.similar ? 'none' : hasSelection() ? 'selection' : 'page'
      let ctx
      try {
        ctx = await buildContext(kind)
      } catch (err) {
        return set({ generating: null, error: { code: 'bad_request', message: (err as Error).message } })
      }
      const level = difficulty === 'mixed' ? 'a mix of easy, medium and hard' : difficulty
      const ask = opts.similar
        ? `Create ${count} practice problem${count === 1 ? '' : 's'} very similar to the problem in my work above (same skill, different numbers), at ${level} difficulty.`
        : `Create ${count} practice problem${count === 1 ? '' : 's'} at ${level} difficulty${topic.trim() ? ` on: ${topic.trim()}` : ''}.${ctx ? ' Base them on the material above.' : ''}`
      const parts: AiPart[] = [...(ctx?.parts ?? []), { text: ask }]
      const finish = (patch: Partial<PracticeState>): void => set({ generating: null, ...patch })
      const result = await startAi(
        { task: 'practice', turns: [{ role: 'user', parts }] },
        {
          onDone: (e) => {
            const parsed = parseTaskResult('practice', e.text)
            if (!parsed) return finish({ error: { code: 'bad_response', message: 'The tutor’s problems were not in the expected format. Try again.' } })
            finish({ set: parsed, source: ctx?.label ?? (topic.trim() || null), index: 0, progress: parsed.problems.map(emptyProgress), error: null })
          },
          onError: (error) => finish(error.code === 'canceled' ? {} : { error })
        }
      )
      if ('error' in result) finish({ error: result.error })
      else if (get().generating) set({ generating: { requestId: result.requestId } })
    },

    cancel() {
      const g = get().generating
      if (g?.requestId) cancelAi(g.requestId)
      const c = get().checkingId
      if (c) cancelAi(c)
    },

    go(index) {
      const n = get().set?.problems.length ?? 0
      if (index >= 0 && index < n) set({ index })
    },

    showHint(i) {
      const problem = get().set?.problems[i]
      const p = get().progress[i]
      if (problem && p) patchProgress(i, { hintsShown: Math.min(problem.hints.length, p.hintsShown + 1) })
    },

    showSolution(i) {
      patchProgress(i, { solutionShown: true })
    },

    setAnswer(i, answer) {
      patchProgress(i, { answer })
    },

    async check(i, via) {
      const problem = get().set?.problems[i]
      const p = get().progress[i]
      if (!problem || !p || get().checkingId || get().generating) return
      const blocked = await preflight()
      if (blocked) return patchProgress(i, { check: { status: 'error', error: blocked } })
      const parts: AiPart[] = [{ text: `Practice problem:\n${problem.question}\n\nExpected final answer: ${problem.answer}` }]
      if (via === 'typed') {
        if (!p.answer.trim()) return
        parts.push({ text: `Student answer (typed): ${p.answer.trim()}` })
      } else {
        if (!hasSelection()) {
          return patchProgress(i, { check: { status: 'error', error: { code: 'bad_request', message: 'Select your handwritten answer on the page with the lasso first.' } } })
        }
        const ctx = await buildContext('selection').catch(() => null)
        const image = ctx?.parts.find((x) => 'image' in x)
        if (!image) return patchProgress(i, { check: { status: 'error', error: { code: 'bad_request', message: 'Could not capture your selection. Try selecting it again.' } } })
        parts.push({ text: 'Student answer: the attached image of their handwriting.' }, image)
      }
      patchProgress(i, { check: { status: 'checking' } })
      const done = (check: ProblemProgress['check']): void => {
        set({ checkingId: null })
        patchProgress(i, { check })
      }
      const result = await startAi(
        { task: 'check', turns: [{ role: 'user', parts }] },
        {
          onDone: (e) => {
            const parsed = parseTaskResult('check', e.text)
            done(parsed ? { status: 'done', result: parsed, via } : { status: 'error', error: { code: 'bad_response', message: 'The tutor’s answer was not in the expected format. Try again.' } })
          },
          onError: (error) => done(error.code === 'canceled' ? undefined : { status: 'error', error })
        }
      )
      if ('error' in result) done({ status: 'error', error: result.error })
      else set({ checkingId: result.requestId })
    }
  }
})

/** Puts a problem on the open canvas page as an editable text box, for working by hand. */
export function hasCanvasPage(): boolean {
  const s = useStore.getState()
  return !!s.activePageId && !!s.pages[s.activePageId]
}
