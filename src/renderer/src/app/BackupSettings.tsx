/** Settings → Storage → Backups: the automatic snapshots, Back up now, Restore. */
import { useEffect, useState } from 'react'
import { Archive, FolderOpen, RotateCcw } from 'lucide-react'
import type { BackupSummary } from '@shared/ipc'

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const KIND: Record<BackupSummary['kind'], string> = { auto: 'Daily', manual: 'Manual', 'before-restore': 'Before restore', 'before-update': 'Before update' }

export function BackupSettings() {
  const [backups, setBackups] = useState<BackupSummary[] | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => void window.inkling.backups.list().then((r) => setBackups(r.backups))
  useEffect(refresh, [])

  const backupNow = async (): Promise<void> => {
    setBusy(true)
    const r = await window.inkling.backups.backupNow()
    setBusy(false)
    if (r.saved) setMessage({ ok: true, text: `Saved a full copy to ${r.path}` })
    else if (r.error) setMessage({ ok: false, text: r.error })
  }
  const restore = async (path: string | null): Promise<void> => {
    setBusy(true)
    const r = await window.inkling.backups.restore(path)
    setBusy(false)
    if (!r.restored && r.error) setMessage({ ok: false, text: r.error })
  }

  const recent = (backups ?? []).slice(0, 5)
  return (
    <div className="mt-3 rounded-xl border border-line px-3 py-2.5" data-testid="backups">
      <div className="flex items-start gap-2.5">
        <Archive size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="font-medium">Backups</p>
          <p className="text-[12.5px] text-ink-2">
            Inkling keeps a copy of your whole library every day (the last 7 days), and before restoring or updating. Use <em>Back up now</em> to save a copy somewhere else, such as a USB drive.
          </p>
        </div>
      </div>
      {recent.length > 0 ? (
        <ul className="mt-2 space-y-1" data-testid="backup-list">
          {recent.map((b) => (
            <li key={b.path} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] hover:bg-[#fafafb]">
              <span className="w-[92px] shrink-0 text-ink-3">{KIND[b.kind]}</span>
              <span className="flex-1">{when(b.createdAt)}</span>
              <span className="text-ink-3">
                {b.notebooks} notebook{b.notebooks === 1 ? '' : 's'}, {b.pages} page{b.pages === 1 ? '' : 's'}
              </span>
              <button type="button" disabled={busy} onClick={() => void restore(b.path)} className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-accent-softer disabled:opacity-40">
                Restore
              </button>
            </li>
          ))}
        </ul>
      ) : (
        backups && <p className="mt-2 text-[12.5px] text-ink-3">The first daily backup is made a few seconds after Inkling starts.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" data-testid="backup-now" disabled={busy} onClick={() => void backupNow()} className="rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-medium hover:bg-[#fafafb] disabled:opacity-40">
          Back up now…
        </button>
        <button type="button" data-testid="backup-restore" disabled={busy} onClick={() => void restore(null)} className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-medium hover:bg-[#fafafb] disabled:opacity-40">
          <RotateCcw size={12} /> Restore from a backup…
        </button>
        <button type="button" onClick={() => void window.inkling.backups.showFolder()} className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-[#fafafb]">
          <FolderOpen size={12} /> Show backups
        </button>
      </div>
      {message && (
        <p className={message.ok ? 'mt-1.5 text-[12.5px] text-[#1f7a46]' : 'mt-1.5 text-[12.5px] text-[#c03a3e]'} data-testid="backup-message">
          {message.text}
        </p>
      )}
    </div>
  )
}
