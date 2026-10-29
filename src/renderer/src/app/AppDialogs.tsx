/** Welcome, About and Privacy dialogs, the update notice, and menu-command handling. */
import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, Download, ExternalLink, MessageSquare, PenLine, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { platformName } from '@shared/product'
import { useApp, runCommand } from './appStore'
import { Dialog } from './Dialog'
import { BrandMark } from './Brand'
import { PrivacyContent } from './PrivacyContent'

export function AppDialogs() {
  const dialog = useApp((s) => s.dialog)
  const close = (): void => useApp.getState().open(null)

  useEffect(() => {
    const off = window.inkling.onCommand(runCommand)
    const offUpdates = window.inkling.updates.onState((u) => useApp.getState().setUpdate(u))
    void window.inkling.updates.state().then((u) => useApp.getState().setUpdate(u))
    useApp.getState().maybeWelcome()
    return () => {
      off()
      offUpdates()
    }
  }, [])

  return (
    <>
      <UpdateNotice />
      {dialog === 'welcome' && <Welcome />}
      {dialog === 'about' && <About onClose={close} />}
      {dialog === 'privacy' && (
        <Dialog title="Privacy" onClose={close} testId="privacy-dialog">
          <PrivacyContent />
        </Dialog>
      )}
    </>
  )
}

// ------------------------------------------------------------------ welcome

const STEPS = [
  {
    icon: PenLine,
    title: 'Write by hand',
    body: 'Use a pen or stylus, mouse or trackpad. Pick the pen, highlighter or eraser from the toolbar. To move or resize something, circle it with the lasso (L). Inkling saves as you go.'
  },
  {
    icon: BookOpen,
    title: 'Keep everything together',
    body: 'Notebooks hold handwritten pages, typed notes and imported PDFs you can write on. Search everything with Ctrl+F (⌘F on a Mac), and link notes with [[.'
  },
  {
    icon: Sparkles,
    title: 'Ask the AI Tutor (beta)',
    body: 'Circle your working and press ✨ to get a hint, have your work checked, or try practice problems. Suggested corrections appear on your page, and you choose which to keep. Nothing is sent until you allow it.'
  }
] as const

function Welcome() {
  const [step, setStep] = useState(0)
  const finish = (): void => useApp.getState().finishWelcome()
  const s = STEPS[step]!
  const Icon = s.icon
  const last = step === STEPS.length - 1
  return (
    <Dialog title="Welcome to Inkling" onClose={finish} width={480} testId="welcome" hideTitle>
      <div className="flex flex-col items-center text-center">
        {step === 0 ? <BrandMark size={72} /> : (
          <span className="flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-gradient-to-br from-accent-soft to-lav-soft text-accent">
            <Icon size={30} />
          </span>
        )}
        {step === 0 && <h2 className="mt-3 text-[20px] font-semibold">Welcome to Inkling</h2>}
        <h3 className={step === 0 ? 'mt-4 text-[15.5px] font-semibold' : 'mt-4 text-[18px] font-semibold'}>{s.title}</h3>
        <p className="mt-1.5 min-h-[66px] text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
        <div className="mt-4 flex gap-1.5" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? 'h-1.5 w-5 rounded-full bg-accent' : 'h-1.5 w-1.5 rounded-full bg-[#d6d9e0]'} />
          ))}
        </div>
        <div className="mt-5 flex w-full items-center justify-between gap-2">
          <button type="button" onClick={finish} className="rounded-xl px-3 py-2 text-[13px] text-ink-3 hover:text-ink">
            Skip
          </button>
          <div className="flex gap-2">
            {last && (
              <button type="button" data-testid="welcome-ai" onClick={() => (finish(), useApp.getState().openSettings('ai'))} className="rounded-xl border border-line px-3.5 py-2 text-[13px] font-medium hover:bg-[#fafafb]">
                Set up the tutor
              </button>
            )}
            <button
              type="button"
              data-testid="welcome-next"
              autoFocus
              onClick={() => (last ? finish() : setStep(step + 1))}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-accent-strong"
            >
              {last ? 'Start writing' : 'Next'} {!last && <ArrowRight size={14} />}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// -------------------------------------------------------------------- about

function About({ onClose }: { onClose: () => void }) {
  const info = useApp((s) => s.info)
  const update = useApp((s) => s.update)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    void useApp.getState().loadInfo()
  }, [])
  const check = async (): Promise<void> => {
    setChecking(true)
    useApp.getState().setUpdate(await window.inkling.updates.check())
    setChecking(false)
  }
  const beta = info?.version.includes('-')
  return (
    <Dialog title="About Inkling" onClose={onClose} width={440} testId="about" hideTitle>
      <div className="flex flex-col items-center text-center">
        <BrandMark size={72} />
        <h2 className="mt-3 text-[20px] font-semibold">Inkling</h2>
        <p className="text-[13px] text-ink-3">Handwritten notes with an AI tutor</p>
        <p className="mt-3 text-[14px]" data-testid="about-version">
          Version <strong>{info?.version ?? '…'}</strong>
          {beta && <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-semibold text-accent">BETA</span>}
        </p>
        {info && (
          <p className="mt-0.5 text-[12px] text-ink-3">
            {platformName(info.platform)} {info.arch} · Electron {info.electron}
            {!info.packaged ? ' · development build' : ''}
          </p>
        )}
        <div className="mt-4 w-full rounded-xl border border-line px-3 py-2.5 text-left text-[13px]" data-testid="about-updates">
          <UpdateLine update={update} />
          {update?.enabled && update.status !== 'ready' && update.status !== 'available' && (
            <button type="button" disabled={checking || update.status === 'checking'} onClick={() => void check()} className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-accent disabled:opacity-50">
              <RefreshCw size={12} className={checking ? 'animate-spin' : ''} /> Check for updates
            </button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-[12.5px]">
          <LinkButton onClick={() => void window.inkling.openFeedback()} icon={<MessageSquare size={13} />}>
            Send feedback
          </LinkButton>
          <LinkButton onClick={() => useApp.getState().open('privacy')} icon={<ShieldCheck size={13} />}>
            Privacy
          </LinkButton>
          {info && (
            <a href={info.releasesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-accent hover:bg-accent-softer">
              <ExternalLink size={13} /> Release notes
            </a>
          )}
        </div>
        <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">
          Inkling is built with open-source software; their licences are listed in the THIRD_PARTY_NOTICES file installed with the app.
        </p>
      </div>
    </Dialog>
  )
}

function UpdateLine({ update }: { update: ReturnType<typeof useApp.getState>['update'] }) {
  if (!update || !update.enabled) return <span className="text-ink-2">{update?.message ?? 'Updates are checked in installed versions.'}</span>
  switch (update.status) {
    case 'checking':
      return <span className="text-ink-2">Checking for updates…</span>
    case 'none':
      return <span className="text-[#1f7a46]">Inkling is up to date.</span>
    case 'downloading':
      return <span className="text-ink-2">Downloading Inkling {update.version}…</span>
    case 'ready':
      return <span className="text-ink">Inkling {update.version} is ready to install.</span>
    case 'available':
      return <span className="text-ink">Inkling {update.version} is available.</span>
    case 'error':
      return <span className="text-[#9a6200]">{update.message}</span>
    default:
      return <span className="text-ink-2">Inkling checks for updates automatically.</span>
  }
}

function LinkButton({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-accent hover:bg-accent-softer">
      {icon} {children}
    </button>
  )
}

// ------------------------------------------------------------ update notice

function UpdateNotice() {
  const update = useApp((s) => s.update)
  const [hidden, setHidden] = useState<string | null>(null)
  if (!update?.enabled || !update.version || hidden === update.version) return null
  if (update.status !== 'ready' && update.status !== 'available') return null
  return (
    <div role="status" data-testid="update-notice" className="fixed bottom-4 left-4 z-40 flex max-w-[360px] items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-[13px] shadow-float">
      <Download size={16} className="shrink-0 text-accent" />
      <span className="flex-1">{update.status === 'ready' ? `Inkling ${update.version} is ready.` : `Inkling ${update.version} is available.`}</span>
      {update.status === 'ready' ? (
        <button type="button" onClick={() => void window.inkling.updates.install()} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 font-medium text-white">
          Restart to update
        </button>
      ) : (
        update.manualDownloadUrl && (
          <a href={update.manualDownloadUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg bg-accent px-2.5 py-1 font-medium text-white">
            Download
          </a>
        )
      )}
      <button type="button" onClick={() => setHidden(update.version!)} className="text-ink-3 hover:text-ink">
        Later
      </button>
    </div>
  )
}
