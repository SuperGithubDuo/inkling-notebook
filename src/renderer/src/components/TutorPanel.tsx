/**
 * AI Tutor panel: chat about the page or a lasso selection, practice problems
 * and on-page feedback, all running on Google Gemini through the main process.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  ChartColumn,
  Check,
  CircleAlert,
  Copy,
  FileText,
  Lasso,
  Lightbulb,
  ListChecks,
  PenLine,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Square,
  SquarePen,
  X
} from 'lucide-react'
import { modelLabel, type AiError } from '@shared/ai'
import { useStore } from '@/store/store'
import { useAi } from '@/ai/aiStore'
import { Markdown } from '@/ai/Markdown'
import { QUICK, threadKey, useTutor, type ChatMessage, type QuickAction, type TutorTab } from '@/ai/tutorStore'
import { IconButton, cx } from './ui/primitives'

const TABS: { id: TutorTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'page', label: 'On Page' },
  { id: 'practice', label: 'Practice' }
]

const EMPTY: ChatMessage[] = []

export function TutorPanel({ onOpenSettings, inputId }: { onOpenSettings: () => void; inputId: string }) {
  const tab = useTutor((s) => s.tab)
  const toggle = useStore((s) => s.toggle)
  const hasMessages = useTutor((s) => (s.threads[threadKey()]?.length ?? 0) > 0)
  useStore((s) => s.activePageId) // re-render when the page (and its thread) changes
  useEffect(() => {
    void useAi.getState().load()
  }, [])

  return (
    <aside
      aria-label="AI Tutor"
      data-testid="tutor-panel"
      className="m-3 ml-0 flex w-[clamp(300px,27vw,392px)] shrink-0 flex-col overflow-hidden rounded-[18px] border border-line bg-white shadow-[0_1px_3px_rgb(30_36_60/0.05)]"
    >
      <header className="flex items-center gap-2.5 px-5 pt-4 pb-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-lav-soft text-lav">
          <Sparkles size={16} />
        </span>
        <h2 className="flex-1 text-[17px] font-semibold">AI Tutor</h2>
        {tab === 'chat' && hasMessages && (
          <IconButton label="New chat" data-testid="tutor-clear" onClick={() => useTutor.getState().clear()}>
            <SquarePen size={17} strokeWidth={1.8} />
          </IconButton>
        )}
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
            data-testid={`tutor-tab-${t.id}`}
            onClick={() => useTutor.getState().setTab(t.id)}
            className={cx(
              'h-9 flex-1 rounded-[9px] text-[14px] transition-all',
              tab === t.id ? 'bg-white font-medium text-accent shadow-[0_1px_3px_rgb(30_36_60/0.12)]' : 'text-ink-2 hover:text-ink'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'chat' && <ChatView onOpenSettings={onOpenSettings} inputId={inputId} />}
      {tab === 'page' && <Placeholder icon={PenLine} title="Corrections on your page" body="Select your handwritten work with the lasso, then ask the tutor to mark it up. You preview every change and approve it before it is added to your page." onOpenSettings={onOpenSettings} />}
      {tab === 'practice' && <Placeholder icon={ListChecks} title="Practise from your notes" body="Generate problems like the ones on this page, work them out by hand, and get hints that stop short of the answer." onOpenSettings={onOpenSettings} />}

      <p className="flex items-center gap-1.5 px-5 pb-3.5 text-[12px] text-ink-3">
        <Sparkles size={12} className="text-lav" />
        Sent to Google Gemini only when you ask.
      </p>
    </aside>
  )
}

function Placeholder({ icon: Icon, title, body, onOpenSettings }: { icon: typeof Sparkles; title: string; body: string; onOpenSettings: () => void }) {
  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-6 pb-3">
      <Intro icon={Icon} title={title} body={body} />
      <AiStatusCard onOpenSettings={onOpenSettings} />
    </div>
  )
}

function Intro({ icon: Icon, title, body }: { icon: typeof Sparkles; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-4 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lav-soft to-accent-soft text-lav">
        <Icon size={22} />
      </span>
      <h3 className="text-[15.5px] font-semibold">{title}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{body}</p>
    </div>
  )
}

/** Shown until a key is set and sending is allowed; a one-line badge afterwards. */
export function AiStatusCard({ onOpenSettings, compact }: { onOpenSettings: () => void; compact?: boolean }) {
  const status = useAi((s) => s.status)
  const ready = !!status?.hasKey && status.consented
  if (compact && ready) {
    return (
      <p data-testid="ai-status" data-state="ready" className="mt-4 flex items-center justify-center gap-1.5 text-[12px] text-ink-3">
        <span className="h-1.5 w-1.5 rounded-full bg-[#2fae66]" />
        Connected · {modelLabel(status!.model)} · free tier
      </p>
    )
  }
  return (
    <div data-testid="ai-status" data-state={ready ? 'ready' : 'setup'} className="mt-5 rounded-[14px] border border-[#e4e2fb] bg-lav-softer p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <span className={ready ? 'h-2 w-2 rounded-full bg-[#2fae66]' : 'h-2 w-2 rounded-full bg-[#c4c7d0]'} />
        {ready ? `Connected · ${modelLabel(status!.model)}` : status?.hasKey ? 'Allow sending to Gemini' : 'Set up the AI Tutor'}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
        {ready
          ? 'Runs on Google Gemini’s free tier. Only what you ask about is sent.'
          : 'Add a free Google Gemini API key in Settings. Nothing from your notebook is sent until you allow it and ask.'}
      </p>
      {!ready && (
        <button type="button" onClick={onOpenSettings} className="mt-2.5 rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-medium text-accent shadow-[0_0_0_1px_#e4e2fb] hover:bg-accent-softer">
          Open AI settings
        </button>
      )}
    </div>
  )
}

const QUICK_ICONS: Record<QuickAction, { icon: typeof Sparkles; tint: string }> = {
  hint: { icon: Lightbulb, tint: 'text-[#e3a008]' },
  explain: { icon: BookOpen, tint: 'text-accent' },
  check: { icon: Check, tint: 'text-[#1f9a5a]' },
  similar: { icon: ChartColumn, tint: 'text-accent' }
}

function ChatView({ onOpenSettings, inputId }: { onOpenSettings: () => void; inputId: string }) {
  const messages = useTutor((s) => s.threads[threadKey()] ?? EMPTY)
  const running = useTutor((s) => !!s.running)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the streaming answer unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  return (
    <>
      <div
        ref={scroller}
        data-testid="tutor-messages"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="thin-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 pt-5 pb-3"
      >
        {messages.length === 0 ? (
          <>
            <Intro icon={Sparkles} title="Ask about this page" body="Check your working, get a concept explained, or ask follow-up questions about the page you are on or a lasso selection." />
            <AiStatusCard onOpenSettings={onOpenSettings} compact />
            <div className="mt-auto grid grid-cols-2 gap-2.5 pt-5">
              {(Object.keys(QUICK) as QuickAction[]).map((q) => {
                const { icon: QIcon, tint } = QUICK_ICONS[q]
                return (
                  <button
                    key={q}
                    type="button"
                    data-testid={`quick-${q}`}
                    disabled={running}
                    onClick={() => void useTutor.getState().send({ quick: q })}
                    className="flex h-[76px] flex-col items-center justify-center gap-1.5 rounded-[14px] border border-line bg-white px-2 text-[13px] leading-snug text-ink-2 transition-colors hover:border-[#d9dbe2] hover:bg-[#fafafb] hover:text-ink disabled:opacity-50"
                  >
                    <QIcon size={20} className={tint} strokeWidth={1.7} />
                    {QUICK[q].label}
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-3.5">
            {messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} m={m} /> : <ModelMessage key={m.id} m={m} onOpenSettings={onOpenSettings} />))}
          </div>
        )}
      </div>
      {messages.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {(Object.keys(QUICK) as QuickAction[]).map((q) => {
            const { icon: QIcon, tint } = QUICK_ICONS[q]
            return (
              <button
                key={q}
                type="button"
                disabled={running}
                onClick={() => void useTutor.getState().send({ quick: q })}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-[#fafafb] hover:text-ink disabled:opacity-50"
              >
                <QIcon size={13} className={tint} />
                {QUICK[q].label}
              </button>
            )
          })}
        </div>
      )}
      <Composer inputId={inputId} />
    </>
  )
}

function ContextChip({ kind, label, thumb }: { kind: 'selection' | 'page'; label: string; thumb?: string }) {
  const Icon = kind === 'selection' ? Lasso : FileText
  return (
    <span className="inline-flex max-w-full flex-col items-end gap-1">
      {thumb && <img src={thumb} alt="What was sent" className="max-h-[84px] max-w-[200px] rounded-lg border border-line bg-white object-contain" />}
      <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[11.5px] text-ink-3">
        <Icon size={11} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </span>
  )
}

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div data-testid="tutor-message" data-role="user" className="flex flex-col items-end gap-1.5 pl-8">
      {m.context && <ContextChip {...m.context} />}
      <div className="rounded-[16px] rounded-br-[6px] bg-accent-soft px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink select-text">{m.text}</div>
    </div>
  )
}

function ModelMessage({ m, onOpenSettings }: { m: ChatMessage; onOpenSettings: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div data-testid="tutor-message" data-role="model" data-status={m.status} className="pr-2">
      {m.status === 'pending' && (
        <div className="flex items-center gap-2 py-1 text-[13px] text-ink-3" aria-live="polite">
          <span className="tutor-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          Thinking…
        </div>
      )}
      {m.text && (
        <div className="text-[13.5px] leading-relaxed text-ink select-text">
          <Markdown text={m.text} />
          {m.status === 'streaming' && <span className="tutor-caret" aria-hidden />}
        </div>
      )}
      {m.status === 'canceled' && <p className="mt-1 text-[12px] text-ink-3">Stopped.</p>}
      {m.status === 'error' && m.error && <ErrorCard error={m.error} messageId={m.id} onOpenSettings={onOpenSettings} />}
      {m.status === 'done' && (
        <div className="mt-1.5 flex items-center gap-1 text-[11.5px] text-ink-3">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(m.text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[#f1f2f4] hover:text-ink"
          >
            <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
          </button>
          {m.model && <span className="ml-auto">{modelLabel(m.model)}</span>}
        </div>
      )}
    </div>
  )
}

const SETTINGS_CODES = new Set(['no_key', 'invalid_key', 'consent_required', 'not_free', 'model_unavailable'])
const NO_RETRY = new Set(['no_key', 'consent_required', 'duplicate', 'invalid_key'])

export function ErrorCard({ error, messageId, onOpenSettings, onRetry }: { error: AiError; messageId?: string; onOpenSettings: () => void; onRetry?: () => void }) {
  const running = useTutor((s) => !!s.running)
  const retry = onRetry ?? (messageId ? () => void useTutor.getState().retry(messageId) : undefined)
  const quota = error.code === 'daily_quota' || error.code === 'rate_limited'
  return (
    <div data-testid="tutor-error" data-code={error.code} className={cx('rounded-[12px] border px-3 py-2.5 text-[13px]', quota ? 'border-[#f3d39a] bg-[#fff8e8]' : 'border-[#f2c9ca] bg-[#fdf3f3]')}>
      <div className="flex items-start gap-2">
        <CircleAlert size={15} className={cx('mt-0.5 shrink-0', quota ? 'text-[#c27c0e]' : 'text-[#c03a3e]')} />
        <span className="leading-relaxed text-ink">{error.message}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
        {error.suggestModel && (
          <Action
            testId="tutor-switch-model"
            onClick={async () => {
              useAi.getState().setStatus(await window.inkling.ai.setModel(error.suggestModel!))
              retry?.()
            }}
          >
            Use {modelLabel(error.suggestModel)} (free)
          </Action>
        )}
        {retry && !NO_RETRY.has(error.code) && (
          <Action testId="tutor-retry" disabled={running} onClick={retry}>
            <RotateCcw size={12} /> Try again
          </Action>
        )}
        {SETTINGS_CODES.has(error.code) && <Action onClick={onOpenSettings}>Open AI settings</Action>}
      </div>
    </div>
  )
}

function Action({ children, onClick, testId, disabled }: { children: ReactNode; onClick: () => void; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[12.5px] font-medium text-accent shadow-[0_0_0_1px_#e3e5ea] hover:bg-accent-softer disabled:opacity-50">
      {children}
    </button>
  )
}

function Composer({ inputId }: { inputId: string }) {
  const [text, setText] = useState('')
  const running = useTutor((s) => !!s.running)
  const choice = useTutor((s) => s.contextChoice)
  const selected = useStore((s) => s.selection.length)
  const kind = useStore((s) => s.library?.notebooks.flatMap((n) => n.pages).find((p) => p.id === s.activePageId)?.kind)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(120, el.scrollHeight)}px`
  }, [text])

  const send = (): void => {
    if (running || !text.trim()) return
    void useTutor.getState().send({ text })
    setText('')
  }
  const label = selected && kind === 'canvas' ? `Selection · ${selected} item${selected === 1 ? '' : 's'}` : 'This page'

  return (
    <div className="px-4 pb-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        {choice === 'auto' ? (
          <span data-testid="tutor-context-chip" className="inline-flex items-center gap-1 rounded-full bg-lav-softer py-0.5 pr-1 pl-2 text-[11.5px] font-medium text-lav">
            {selected && kind === 'canvas' ? <Lasso size={11} /> : <FileText size={11} />}
            {label}
            <button type="button" aria-label="Don't include the page" onClick={() => useTutor.getState().setContextChoice('none')} className="rounded-full p-0.5 hover:bg-white">
              <X size={11} />
            </button>
          </span>
        ) : (
          <button type="button" data-testid="tutor-context-add" onClick={() => useTutor.getState().setContextChoice('auto')} className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-[11.5px] text-ink-3 hover:text-ink">
            <Plus size={11} /> Include page or selection
          </button>
        )}
      </div>
      <div className="flex items-end gap-2 rounded-[14px] border border-line bg-[#fafafb] py-1.5 pr-1.5 pl-3.5 focus-within:border-[#cfd3dc] focus-within:bg-white">
        <textarea
          ref={ref}
          id={inputId}
          rows={1}
          value={text}
          data-testid="tutor-input"
          aria-label="Ask the AI Tutor"
          placeholder="Ask a question…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          className="max-h-[120px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug outline-none select-text placeholder:text-ink-3"
        />
        {running ? (
          <IconButton label="Stop" size="sm" data-testid="tutor-stop" onClick={() => useTutor.getState().stop()} className="!h-8 !w-8 !rounded-[10px] bg-ink !text-white hover:!bg-ink-2">
            <Square size={12} fill="currentColor" />
          </IconButton>
        ) : (
          <IconButton label="Send" size="sm" data-testid="tutor-send" disabled={!text.trim()} onClick={send} className="!h-8 !w-8 !rounded-[10px] bg-accent !text-white hover:!bg-accent-strong">
            <Send size={15} />
          </IconButton>
        )}
      </div>
    </div>
  )
}
