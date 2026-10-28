import { useEffect, useRef } from 'react'
import { FolderOpen, Sparkles, X } from 'lucide-react'
import { useStore } from '@/store/store'
import { IconButton } from './ui/primitives'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dataDir = useStore((s) => s.dataDir)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1f2430]/25" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label="Settings" className="animate-pop w-[520px] rounded-2xl bg-white p-6 shadow-pop outline-none">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold">Settings</h2>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <section className="mb-5">
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
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">AI Tutor</h3>
          <div className="rounded-xl border border-[#e4e2fb] bg-lav-softer p-4">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              <Sparkles size={15} className="text-lav" /> Anthropic Claude — not configured
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              API key, model choice and context permissions will live here once the AI connection is implemented. Keys
              will be stored by the desktop process, never in page files or the interface.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
