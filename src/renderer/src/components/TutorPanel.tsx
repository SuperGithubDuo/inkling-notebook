/**
 * AI Tutor panel. Phase 1 ships the panel layout only: there is no model
 * connection yet, so every AI control is visibly marked as unavailable and
 * nothing from the notebook leaves this computer.
 */
import { useState } from 'react'
import { BookOpen, ChartColumn, Lightbulb, Mic, PenLine, Send, Settings, Sparkles, Target, X } from 'lucide-react'
import { useStore } from '@/store/store'
import { IconButton, Tip, cx } from './ui/primitives'

type Tab = 'chat' | 'page' | 'practice'

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'page', label: 'On Page' },
  { id: 'practice', label: 'Practice' }
]

const COPY: Record<Tab, { icon: typeof Sparkles; title: string; body: string }> = {
  chat: {
    icon: Sparkles,
    title: 'Ask about this page',
    body: 'Check your working, get a concept explained, or ask follow-up questions about the page you are on or a lasso selection.'
  },
  page: {
    icon: PenLine,
    title: 'Corrections on your page',
    body: 'The tutor will add editable notes, arrows, equations and graphs next to your work — never over it — and you approve each change.'
  },
  practice: {
    icon: Target,
    title: 'Practise from your notes',
    body: 'Generate problems from this notebook, work them out by hand, and get hints that stop short of the answer.'
  }
}

export function TutorPanel({ onOpenSettings, inputId }: { onOpenSettings: () => void; inputId: string }) {
  const [tab, setTab] = useState<Tab>('chat')
  const toggle = useStore((s) => s.toggle)
  const { icon: Icon, title, body } = COPY[tab]

  return (
    <aside
      aria-label="AI Tutor"
      data-testid="tutor-panel"
      className="m-3 ml-0 flex w-[392px] shrink-0 flex-col overflow-hidden rounded-[18px] border border-line bg-white shadow-[0_1px_3px_rgb(30_36_60/0.05)]"
    >
      <header className="flex items-center gap-2.5 px-5 pt-4 pb-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-lav-soft text-lav">
          <Sparkles size={16} />
        </span>
        <h2 className="flex-1 text-[17px] font-semibold">AI Tutor</h2>
        <IconButton label="AI settings" onClick={onOpenSettings}>
          <Settings size={18} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Close AI Tutor" onClick={() => toggle('tutorOpen')}>
          <X size={19} strokeWidth={1.8} />
        </IconButton>
      </header>

      <div role="tablist" className="mx-4 flex rounded-[12px] bg-[#f2f3f6] p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'h-9 flex-1 rounded-[9px] text-[14px] transition-all',
              tab === t.id ? 'bg-white font-medium text-accent shadow-[0_1px_3px_rgb(30_36_60/0.12)]' : 'text-ink-2 hover:text-ink'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 pt-6 pb-3" role="tabpanel">
        <div className="flex flex-col items-center px-4 text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lav-soft to-accent-soft text-lav">
            <Icon size={22} />
          </span>
          <h3 className="text-[15.5px] font-semibold">{title}</h3>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{body}</p>
        </div>

        <div data-testid="ai-status" className="mt-5 rounded-[14px] border border-[#e4e2fb] bg-lav-softer p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <span className="h-2 w-2 rounded-full bg-[#c4c7d0]" />
            Not connected
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
            The tutor will run on Claude through the Anthropic API, using a key you provide in Settings. That connection
            is not built yet, so these controls are inactive and nothing on your pages is sent anywhere.
          </p>
        </div>

        <div className="mt-auto pt-5">
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { icon: Lightbulb, label: 'Give me a hint', tint: 'text-[#e3a008]' },
              { icon: BookOpen, label: 'Explain the concept', tint: 'text-accent' },
              { icon: ChartColumn, label: 'Try a similar problem', tint: 'text-accent' }
            ].map(({ icon: QIcon, label, tint }) => (
              <button
                key={label}
                type="button"
                aria-disabled
                className="group relative flex h-[96px] cursor-not-allowed flex-col items-center justify-center gap-2 rounded-[14px] border border-line bg-white px-2 text-[13px] leading-snug text-ink-2 opacity-60"
              >
                <QIcon size={21} className={tint} strokeWidth={1.7} />
                {label}
                <Tip text="Available once the AI Tutor is connected" side="top" />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 pb-2">
        <div className="flex h-12 items-center gap-2 rounded-[14px] border border-line bg-[#fafafb] pr-2 pl-4">
          <input
            id={inputId}
            disabled
            placeholder="Ask a question…  (not connected yet)"
            className="min-w-0 flex-1 cursor-not-allowed bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          />
          <IconButton label="Voice input — not yet available" size="sm" disabled>
            <Mic size={17} />
          </IconButton>
          <IconButton label="Send — not connected" size="sm" disabled>
            <Send size={16} />
          </IconButton>
        </div>
      </div>
      <p className="flex items-center gap-1.5 px-5 pb-3.5 text-[12px] text-ink-3">
        <Sparkles size={12} className="text-lav" />
        Your notes stay on this computer.
      </p>
    </aside>
  )
}
