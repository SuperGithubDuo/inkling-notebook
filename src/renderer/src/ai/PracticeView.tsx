/**
 * Practice tab: generate problems from the page, reveal hints one at a time,
 * check a typed or handwritten answer, and copy a problem onto the page to
 * work it out by hand.
 */
import { useState } from 'react'
import { ArrowLeft, ArrowRight, CircleCheck, CircleHelp, CircleX, Eye, Lasso, Lightbulb, ListChecks, LoaderCircle, PenLine, Square, TriangleAlert } from 'lucide-react'
import { newId } from '@shared/factory'
import { latexToPlain } from '@shared/mathText'
import type { CheckResult, PracticeProblem } from '@shared/tutor'
import { useStore } from '@/store/store'
import { notebookContext } from '@/services/notebookContext'
import { objectBounds, unionRects } from '@/canvas/geometry'
import { cx } from '@/components/ui/primitives'
import { ErrorCard } from './ErrorCard'
import { Markdown, MarkdownInline } from './Markdown'
import { usePractice, type DifficultyChoice } from './practiceStore'

const LEVELS: { id: DifficultyChoice; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
  { id: 'mixed', label: 'Mixed' }
]

export function PracticeView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const p = usePractice()
  const selected = useStore((s) => s.selection.length > 0)
  const busy = !!p.generating

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 pt-4 pb-3" data-testid="practice-view">
      <section className="rounded-[14px] border border-line p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
          <ListChecks size={15} className="text-lav" /> New practice set
        </div>
        <div role="radiogroup" aria-label="Difficulty" className="mb-2 flex rounded-[10px] bg-[#f2f3f6] p-0.5">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={p.difficulty === l.id}
              data-testid={`practice-level-${l.id}`}
              onClick={() => p.configure({ difficulty: l.id })}
              className={cx('h-7 flex-1 rounded-[8px] text-[12.5px]', p.difficulty === l.id ? 'bg-white font-medium text-ink shadow-[0_1px_2px_rgb(30_36_60/0.12)]' : 'text-ink-2')}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <input
            value={p.topic}
            data-testid="practice-topic"
            aria-label="Topic (optional)"
            placeholder="Topic (optional), e.g. factoring"
            maxLength={160}
            onChange={(e) => p.configure({ topic: e.target.value })}
            className="min-w-0 flex-1 rounded-[10px] border border-line px-2.5 py-1.5 text-[13px] outline-none select-text focus:border-accent"
          />
          <select
            value={p.count}
            aria-label="Number of problems"
            data-testid="practice-count"
            onChange={(e) => p.configure({ count: Number(e.target.value) })}
            className="rounded-[10px] border border-line bg-white px-1.5 py-1.5 text-[13px] outline-none"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} problem{n === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </div>
        <label className="mb-2.5 flex items-center gap-2 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={p.useContext} onChange={(e) => p.configure({ useContext: e.target.checked })} className="accent-[var(--color-accent)]" />
          Based on {selected ? 'my selection' : 'this page'}
        </label>
        {busy ? (
          <button type="button" data-testid="practice-cancel" onClick={p.cancel} className="flex h-9 w-full items-center justify-center gap-2 rounded-[10px] bg-[#f2f3f6] text-[13px] font-medium text-ink-2">
            <LoaderCircle size={14} className="animate-spin" /> Writing problems… <Square size={10} fill="currentColor" className="ml-1" /> Stop
          </button>
        ) : (
          <button
            type="button"
            data-testid="practice-generate"
            disabled={!p.useContext && !p.topic.trim()}
            onClick={() => void p.generate()}
            className="h-9 w-full rounded-[10px] bg-accent text-[13px] font-medium text-white hover:bg-accent-strong disabled:opacity-40"
          >
            Generate problems
          </button>
        )}
        {p.error && (
          <div className="mt-2.5">
            <ErrorCard error={p.error} onOpenSettings={onOpenSettings} onRetry={() => void p.generate()} />
          </div>
        )}
      </section>

      {p.set && <ProblemCard key={`${p.set.topic}:${p.index}`} onOpenSettings={onOpenSettings} />}
    </div>
  )
}

function ProblemCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { set, index, progress, go, showHint, showSolution, setAnswer, check } = usePractice()
  const checking = usePractice((s) => !!s.checkingId)
  const hasSel = useStore((s) => s.selection.length > 0)
  const [copied, setCopied] = useState(false)
  const problem = set!.problems[index]!
  const prog = progress[index]!
  const n = set!.problems.length

  return (
    <section className="mt-3" data-testid="practice-problem" data-index={index}>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3" title={set!.topic}>
          <MarkdownInline text={set!.topic} />
        </span>
        <button type="button" aria-label="Previous problem" disabled={index === 0} onClick={() => go(index - 1)} className="rounded-md p-1 text-ink-2 hover:bg-[#f1f2f4] disabled:opacity-30">
          <ArrowLeft size={15} />
        </button>
        <span className="text-[12.5px] font-medium tabular-nums" data-testid="practice-position">
          {index + 1} / {n}
        </span>
        <button type="button" aria-label="Next problem" data-testid="practice-next" disabled={index === n - 1} onClick={() => go(index + 1)} className="rounded-md p-1 text-ink-2 hover:bg-[#f1f2f4] disabled:opacity-30">
          <ArrowRight size={15} />
        </button>
      </div>

      <div className="rounded-[14px] border border-line bg-[#fcfcfd] p-3.5">
        <DifficultyBadge level={problem.difficulty} />
        <div className="mt-1.5 text-[14px] leading-relaxed select-text" data-testid="practice-question">
          <Markdown text={problem.question} />
        </div>
        <button
          type="button"
          data-testid="practice-to-page"
          onClick={() => {
            if (copyToPage(problem, index)) setCopied(true)
          }}
          className="mt-2 flex items-center gap-1.5 text-[12px] text-accent hover:underline"
        >
          <PenLine size={12} /> {copied ? 'Added to your page' : 'Copy to my page to work it out'}
        </button>
      </div>

      {prog.hintsShown > 0 && (
        <ol className="mt-2.5 space-y-1.5" data-testid="practice-hints">
          {problem.hints.slice(0, prog.hintsShown).map((h, i) => (
            <li key={i} className="flex gap-2 rounded-[12px] bg-[#fff8e6] px-3 py-2 text-[13px]">
              <Lightbulb size={14} className="mt-0.5 shrink-0 text-[#e3a008]" />
              <div className="min-w-0 flex-1">
                <span className="text-[11.5px] font-semibold text-[#9a6200]">Hint {i + 1}</span>
                <Markdown text={h} />
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {prog.hintsShown < problem.hints.length && (
          <Pill testId="practice-hint" onClick={() => showHint(index)}>
            <Lightbulb size={13} className="text-[#e3a008]" />
            {prog.hintsShown === 0 ? 'Show a hint' : `Next hint (${prog.hintsShown + 1} of ${problem.hints.length})`}
          </Pill>
        )}
        {!prog.solutionShown && (
          <Pill testId="practice-solution" onClick={() => showSolution(index)}>
            <Eye size={13} /> Show solution
          </Pill>
        )}
      </div>

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void check(index, 'typed')
        }}
      >
        <label className="mb-1 block text-[12px] font-medium text-ink-2" htmlFor="practice-answer">
          Your answer
        </label>
        <div className="flex gap-1.5">
          <input
            id="practice-answer"
            value={prog.answer}
            data-testid="practice-answer"
            placeholder="e.g. x = 2 or x = 3"
            onChange={(e) => setAnswer(index, e.target.value)}
            className="min-w-0 flex-1 rounded-[10px] border border-line px-2.5 py-1.5 text-[13px] outline-none select-text focus:border-accent"
          />
          <button type="submit" data-testid="practice-check" disabled={!prog.answer.trim() || checking} className="rounded-[10px] bg-accent px-3 text-[13px] font-medium text-white disabled:opacity-40">
            Check
          </button>
        </div>
        <button
          type="button"
          data-testid="practice-check-handwriting"
          disabled={!hasSel || checking}
          onClick={() => void check(index, 'handwriting')}
          title={hasSel ? undefined : 'Write your answer on the page and select it with the lasso'}
          className="mt-1.5 flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:text-ink-3 disabled:no-underline"
        >
          <Lasso size={12} /> {hasSel ? 'Check my handwritten answer (selection)' : 'Select your handwritten answer to check it'}
        </button>
      </form>

      {prog.check?.status === 'checking' && (
        <p className="mt-2.5 flex items-center gap-2 text-[13px] text-ink-3">
          <LoaderCircle size={14} className="animate-spin" /> Checking…
        </p>
      )}
      {prog.check?.status === 'done' && <Verdict result={prog.check.result} />}
      {prog.check?.status === 'error' && (
        <div className="mt-2.5">
          <ErrorCard error={prog.check.error} onOpenSettings={onOpenSettings} onRetry={() => void check(index, 'typed')} />
        </div>
      )}

      {prog.solutionShown && (
        <div className="mt-3 rounded-[14px] border border-[#dfe8fb] bg-accent-softer p-3 text-[13px]" data-testid="practice-solution-text">
          <div className="mb-1 font-semibold">
            Answer: <MarkdownInline text={problem.answer} />
          </div>
          <Markdown text={problem.solution} />
        </div>
      )}
    </section>
  )
}

const VERDICTS: Record<CheckResult['verdict'], { label: string; icon: typeof CircleCheck; tone: string }> = {
  correct: { label: 'Correct', icon: CircleCheck, tone: 'border-[#bfe5cf] bg-[#effaf3] text-[#1f7a46]' },
  partially_correct: { label: 'Almost', icon: TriangleAlert, tone: 'border-[#f3d39a] bg-[#fff8e8] text-[#9a6200]' },
  incorrect: { label: 'Not yet', icon: CircleX, tone: 'border-[#f2c9ca] bg-[#fdf3f3] text-[#b13236]' },
  unreadable: { label: "Couldn't read it", icon: CircleHelp, tone: 'border-line bg-[#f6f7f9] text-ink-2' }
}

function Verdict({ result }: { result: CheckResult }) {
  const v = VERDICTS[result.verdict]
  return (
    <div className={cx('mt-2.5 rounded-[12px] border px-3 py-2.5 text-[13px]', v.tone)} data-testid="practice-verdict" data-verdict={result.verdict}>
      <div className="flex items-center gap-1.5 font-semibold">
        <v.icon size={15} /> {v.label}
        {result.transcription && <span className="ml-1 truncate font-normal opacity-75">· read “{result.transcription}”</span>}
      </div>
      <div className="mt-1 text-ink">
        <Markdown text={result.feedback} />
      </div>
    </div>
  )
}

function DifficultyBadge({ level }: { level: PracticeProblem['difficulty'] }) {
  const tone = level === 'easy' ? 'bg-[#e9f6ee] text-[#1f7a46]' : level === 'medium' ? 'bg-[#fff3d6] text-[#9a6200]' : 'bg-[#fdecec] text-[#b13236]'
  return <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase', tone)}>{level}</span>
}

function Pill({ children, onClick, testId }: { children: React.ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-[#fafafb] hover:text-ink">
      {children}
    </button>
  )
}

/** Adds the problem as an editable text box below the page's content. */
function copyToPage(problem: PracticeProblem, index: number): boolean {
  const s = useStore.getState()
  const page = s.activePageId ? s.pages[s.activePageId] : undefined
  if (!page) {
    s.setNotice('Open a handwriting page to copy the problem onto it.')
    return false
  }
  const content = unionRects(page.objects.map(objectBounds))
  const y = Math.min(page.height - 160, content ? content.y + content.height + 48 : 120)
  const id = newId()
  const result = notebookContext.applyCanvasCommands(
    page.id,
    [{ type: 'createText', id, text: { x: 80, y, width: Math.min(900, page.width - 160), text: `Problem ${index + 1}: ${latexToPlain(problem.question)}`, color: '#1f2430', fontSize: 26, font: 'sans' } }],
    { label: 'Copy practice problem' }
  )
  if (!result.ok) {
    s.setNotice(`Could not add the problem: ${result.error}`)
    return false
  }
  return true
}
