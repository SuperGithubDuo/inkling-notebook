import { useEffect, useRef } from 'react'
import { FolderOpen, Info, MessageSquare, ShieldCheck, X } from 'lucide-react'
import { BackupSettings } from '@/app/BackupSettings'
import { useApp } from '@/app/appStore'
import { useStore } from '@/store/store'
import { IconButton } from './ui/primitives'
import { AiSettings } from '@/ai/AiSettings'
import { useAi } from '@/ai/aiStore'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dataDir = useStore((s) => s.dataDir)
  const ref = useRef<HTMLDivElement>(null)
  const section = useApp((s) => s.settingsSection)
  useEffect(() => {
    ref.current?.focus()
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !useAi.getState().consentOpen) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, section])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1f2430]/25" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label="Settings" className="animate-pop thin-scroll max-h-[calc(100vh-48px)] w-[560px] max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto rounded-2xl bg-white p-6 shadow-pop outline-none">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold">Settings</h2>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <section className="mb-5" id="settings-storage">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Storage</h3>
          <p className="mb-2 text-[13.5px] text-ink-2">Notebooks are saved automatically as files on this computer.</p>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-[#fafafb] px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2" title={dataDir}>
              {dataDir}
            </code>
            <button
              type="button"
              onClick={() => void window.inkling.showDataFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] text-accent hover:bg-accent-softer"
            >
              <FolderOpen size={14} /> Open
            </button>
          </div>
          <BackupSettings />
        </section>

        <section id="settings-ai" className="mb-5">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">AI Tutor</h3>
          <AiSettings />
        </section>

        <section id="settings-privacy">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Privacy and help</h3>
          <div className="flex flex-wrap gap-1.5">
            <SettingsLink icon={<ShieldCheck size={14} />} onClick={() => useApp.getState().open('privacy')} testId="settings-privacy">
              How Inkling handles your data
            </SettingsLink>
            <SettingsLink icon={<MessageSquare size={14} />} onClick={() => void window.inkling.openFeedback()} testId="settings-feedback">
              Send feedback or report a problem
            </SettingsLink>
            <SettingsLink icon={<Info size={14} />} onClick={() => useApp.getState().open('about')} testId="settings-about">
              About Inkling
            </SettingsLink>
          </div>
        </section>
      </div>
    </div>
  )
}

function SettingsLink({ icon, children, onClick, testId }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-[#fafafb]">
      <span className="text-ink-3">{icon}</span> {children}
    </button>
  )
}
