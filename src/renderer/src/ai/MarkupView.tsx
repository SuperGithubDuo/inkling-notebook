/**
 * On Page tab: ask the tutor to mark up selected handwritten work, review the
 * proposed marks (previewed on the page), keep or drop each one, then add
 * them as one undoable step.
 */
import { Check, Circle, LoaderCircle, MoveRight, PenLine, Square, StickyNote, Underline, Undo2, X } from 'lucide-react'
import type { AnnotationKind } from '@shared/tutor'
import { latexToPlain } from '@shared/mathText'
import { useStore } from '@/store/store'
import { cx } from '@/components/ui/primitives'
import { ErrorCard } from './ErrorCard'
import { Markdown } from './Markdown'
import { useMarkup } from './markupStore'
import { AI_COLORS } from './annotate'

const KIND: Record<AnnotationKind, { label: string; icon: typeof Check; color: string }> = {
  check: { label: 'Correct', icon: Check, color: AI_COLORS.good },
  cross: { label: 'Mistake', icon: X, color: AI_COLORS.wrong },
  circle: { label: 'Circle', icon: Circle, color: AI_COLORS.wrong },
  underline: { label: 'Underline', icon: Underline, color: AI_COLORS.wrong },
  correction: { label: 'Correction', icon: PenLine, color: AI_COLORS.wrong },
  note: { label: 'Note', icon: StickyNote, color: AI_COLORS.note },
  arrow: { label: 'Pointer', icon: MoveRight, color: AI_COLORS.note }
}

export function MarkupView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const m = useMarkup()
  const hasSel = useStore((s) => s.selection.length > 0 && !!s.activePageId && !!s.pages[s.activePageId])
  const onOtherPage = useStore((s) => !!m.proposal && s.activePageId !== m.proposal.pageId)

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 pt-5 pb-3" data-testid="markup-view" data-status={m.status}>
      {(m.status === 'idle' || m.status === 'error') && (
        <>
          <div className="flex flex-col items-center px-3 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lav-soft to-accent-soft text-lav">
              <PenLine size={22} />
            </span>
            <h3 className="text-[15.5px] font-semibold">Corrections on your page</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
              Select your handwritten work with the lasso and the tutor will mark it up — ticks, crosses and notes beside your work, never over it. You preview
              every mark before anything is added.
            </p>
          </div>
          <button
            type="button"
            data-testid="markup-start"
            disabled={!hasSel}
            onClick={() => void m.start()}
            className="mt-5 h-10 rounded-[12px] bg-accent text-[13.5px] font-medium text-white hover:bg-accent-strong disabled:opacity-40"
          >
            {hasSel ? 'Mark up my selection' : 'Select your work with the lasso first'}
          </button>
          {m.status === 'error' && m.error && (
            <div className="mt-3">
              <ErrorCard error={m.error} onOpenSettings={onOpenSettings} onRetry={() => void m.start(m.lastRequest ?? {})} />
            </div>
          )}
        </>
      )}

      {m.status === 'running' && (
        <div className="flex flex-col items-center gap-3 pt-8 text-center text-[13.5px] text-ink-2">
          <LoaderCircle size={22} className="animate-spin text-lav" />
          Reading your work…
          <button type="button" data-testid="markup-cancel" onClick={m.cancel} className="flex items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] text-ink-3 hover:bg-[#f1f2f4]">
            <Square size={10} fill="currentColor" /> Stop
          </button>
        </div>
      )}

      {m.status === 'ready' && m.proposal && (
        <div data-testid="markup-proposal">
          <div className="rounded-[14px] border border-[#e4e2fb] bg-lav-softer p-3 text-[13.5px] leading-relaxed select-text">
            <Markdown text={m.proposal.result.summary} />
          </div>
          {m.proposal.result.transcription && (
            <details className="mt-2 text-[12.5px] text-ink-2">
              <summary className="cursor-pointer text-ink-3">What the tutor read</summary>
              <pre className="mt-1 rounded-lg bg-[#f6f7f9] px-2.5 py-2 font-sans whitespace-pre-wrap select-text">{m.proposal.result.transcription}</pre>
            </details>
          )}
          <p className="mt-3 mb-1.5 text-[12px] font-medium text-ink-3">
            {m.proposal.placed.length ? `Proposed marks — previewed on your page${onOtherPage ? ' (go back to that page to see it)' : ''}` : 'No marks proposed.'}
          </p>
          <ul className="space-y-1">
            {m.proposal.placed.map((p, i) => {
              const k = KIND[p.annotation.kind]
              return (
                <li key={i}>
                  <label className={cx('flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-2.5 py-2 text-[13px]', m.proposal!.included[i] ? 'border-line bg-white' : 'border-dashed border-line bg-transparent opacity-55')}>
                    <input type="checkbox" data-testid="markup-item" checked={m.proposal!.included[i]} onChange={() => m.toggle(i)} className="mt-0.5 accent-[var(--color-accent)]" />
                    <k.icon size={15} className="mt-0.5 shrink-0" style={{ color: k.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{k.label}</span>
                      {p.annotation.text && <span className="text-ink-2"> — {latexToPlain(p.annotation.text)}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="markup-approve"
              disabled={!m.proposal.included.some(Boolean) || onOtherPage}
              onClick={m.approve}
              className="h-9 flex-1 rounded-[10px] bg-accent text-[13px] font-medium text-white hover:bg-accent-strong disabled:opacity-40"
            >
              Add {m.proposal.included.filter(Boolean).length} to my page
            </button>
            <button type="button" data-testid="markup-discard" onClick={m.discard} className="h-9 rounded-[10px] px-3.5 text-[13px] font-medium text-ink-2 hover:bg-[#f1f2f4]">
              Discard
            </button>
          </div>
        </div>
      )}

      {m.status === 'applied' && m.applied && (
        <div data-testid="markup-applied" className="rounded-[14px] border border-[#bfe5cf] bg-[#effaf3] p-3.5 text-[13px]">
          <div className="flex items-center gap-1.5 font-semibold text-[#1f7a46]">
            <Check size={15} /> Added {m.applied.count} mark{m.applied.count === 1 ? '' : 's'} to your page
          </div>
          <p className="mt-1 text-ink-2">They are ordinary objects: move, edit or delete them like anything else. Undo removes them all at once.</p>
          <div className="mt-2.5 flex gap-2">
            <button type="button" data-testid="markup-undo" onClick={m.undoApplied} className="flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-[12.5px] font-medium text-ink-2 shadow-[0_0_0_1px_#e3e5ea] hover:text-ink">
              <Undo2 size={13} /> Undo
            </button>
            <button type="button" onClick={m.discard} className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-accent hover:bg-accent-softer">
              Mark up something else
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
