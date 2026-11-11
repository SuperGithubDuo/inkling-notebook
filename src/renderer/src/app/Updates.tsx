/**
 * Updates in the interface: the small notice (download progress, "Restart & Update" / "Later"),
 * Settings → Updates, and the status line About shares.
 *
 * Never interrupts writing: the notice appears only after a few seconds without pen, mouse or
 * keyboard input, never takes focus, and nothing restarts unless the user clicks.
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, X } from 'lucide-react'
import type { UpdateChannel, UpdateState } from '@shared/ipc'
import { useApp } from './appStore'

const IDLE_MS = 4000

/** True once there has been no pointer or key input for `ms`. */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), ms)
    const busy = (e: Event): void => {
      if (e.type === 'pointermove' && !(e as PointerEvent).buttons) return
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), ms)
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    for (const t of events) window.addEventListener(t, busy, { capture: true, passive: true })
    return () => {
      clearTimeout(timer)
      for (const t of events) window.removeEventListener(t, busy, { capture: true })
    }
  }, [ms])
  return idle
}

/** Restart & Update. If it can't go ahead (backup, saving, approval), the returned state says why. */
const install = (): void => void window.inkling.updates.install().then((u) => useApp.getState().setUpdate(u))

export function UpdateNotice() {
  const update = useApp((s) => s.update)
  const idle = useIdle(IDLE_MS)
  // What the user put off ("Later" / ×), by status and version, for this session.
  const [dismissed, setDismissed] = useState<string[]>([])
  const [shown, setShown] = useState<string | null>(null)
  const key = noticeKey(update)
  // Appear only while the user isn't writing; once visible, stay put until dismissed.
  useEffect(() => {
    if (key && idle && !dismissed.includes(key)) setShown(key)
    if (!key) setShown(null)
  }, [key, idle, dismissed])
  // "Updated" confirmations fade by themselves.
  useEffect(() => {
    if (shown?.startsWith('installed:')) {
      const t = setTimeout(() => setDismissed((d) => [...d, shown]), 10_000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [shown])
  if (!update || !key || shown !== key || dismissed.includes(key)) return null
  const later = (): void => setDismissed((d) => [...d, key])

  let body: React.ReactNode
  if (update.status === 'downloading') {
    body = (
      <>
        <Download size={14} className="shrink-0 text-ink-3" />
        <span className="flex-1 text-ink-2">
          Downloading Inkling {update.version}… {update.percent ?? 0}%
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[#eef0f4]">
            <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${update.percent ?? 0}%` }} />
          </span>
        </span>
        <Close onClick={later} />
      </>
    )
  } else if (update.status === 'ready') {
    body = (
      <>
        <Download size={16} className={`shrink-0 ${update.installError ? 'text-[#9a6200]' : 'text-accent'}`} />
        <span className="flex-1">
          Inkling {update.version} is ready.
          {update.installError && (
            <span className="mt-0.5 block text-[12px] text-[#9a6200]" data-testid="update-install-error">
              {update.installError}
            </span>
          )}
        </span>
        <button type="button" data-testid="update-restart" disabled={update.installing} onClick={install} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 font-medium text-white disabled:opacity-60">
          {update.installing ? 'Restarting…' : update.installError ? 'Try again' : 'Restart & Update'}
        </button>
        {!update.installing && (
          <button type="button" data-testid="update-later" onClick={later} className="shrink-0 text-ink-3 hover:text-ink">
            Later
          </button>
        )}
      </>
    )
  } else if (update.status === 'available') {
    body = (
      <>
        <Download size={16} className="shrink-0 text-accent" />
        <span className="flex-1">Inkling {update.version} is available.</span>
        {update.manualDownloadUrl && (
          <a href={update.manualDownloadUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg bg-accent px-2.5 py-1 font-medium text-white">
            Download
          </a>
        )}
        <button type="button" data-testid="update-later" onClick={later} className="shrink-0 text-ink-3 hover:text-ink">
          Later
        </button>
      </>
    )
  } else if (update.lastInstall?.ok) {
    body = (
      <>
        <CheckCircle2 size={16} className="shrink-0 text-[#1f7a46]" />
        <span className="flex-1">Updated to Inkling {update.lastInstall.version}.</span>
        <Close onClick={later} />
      </>
    )
  } else if (update.lastInstall) {
    body = (
      <>
        <Download size={16} className="shrink-0 text-[#9a6200]" />
        <span className="flex-1">The update to Inkling {update.lastInstall.version} didn’t finish installing. Your notebooks weren’t changed; Inkling will offer it again.</span>
        <Close onClick={later} />
      </>
    )
  }
  return (
    <div role="status" data-testid="update-notice" data-status={update.status} className="fixed bottom-4 left-4 z-40 flex max-w-[380px] items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-[13px] shadow-float">
      {body}
    </div>
  )
}

/** Which notice applies now, as a key the user can dismiss ("Later"), or null. */
function noticeKey(u: UpdateState | null): string | null {
  if (!u?.enabled) return null
  if (u.version && (u.status === 'ready' || u.status === 'available' || u.status === 'downloading')) return `${u.status}:${u.version}`
  if (u.lastInstall && (u.status === 'idle' || u.status === 'checking' || u.status === 'none' || u.status === 'error')) return `${u.lastInstall.ok ? 'installed' : 'failed'}:${u.lastInstall.version}`
  return null
}

function Close({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Hide" data-testid="update-later" onClick={onClick} className="shrink-0 text-ink-3 hover:text-ink">
      <X size={14} />
    </button>
  )
}

export function UpdateLine({ update }: { update: UpdateState | null }) {
  if (!update || !update.enabled) return <span className="text-ink-2">{update?.message ?? 'Updates are checked in installed versions.'}</span>
  switch (update.status) {
    case 'checking':
      return <span className="text-ink-2">Checking for updates…</span>
    case 'none':
      return <span className="text-[#1f7a46]">Inkling is up to date.</span>
    case 'downloading':
      return (
        <span className="text-ink-2">
          Downloading Inkling {update.version}… {update.percent ?? 0}%
        </span>
      )
    case 'ready':
      return <span className="text-ink">Inkling {update.version} is ready to install.</span>
    case 'available':
      return <span className="text-ink">Inkling {update.version} is available.</span>
    case 'error':
      return <span className="text-[#9a6200]">{update.message}</span>
    default:
      return <span className="text-ink-2">{update.message ?? 'Inkling checks for updates automatically.'}</span>
  }
}

/** Settings → Updates. */
export function UpdateSettings() {
  const update = useApp((s) => s.update)
  const info = useApp((s) => s.info)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void useApp.getState().loadInfo()
  }, [])
  const run = async (fn: () => Promise<UpdateState>): Promise<void> => {
    setBusy(true)
    useApp.getState().setUpdate(await fn())
    setBusy(false)
  }
  const enabled = !!update?.enabled
  const working = busy || update?.status === 'checking' || update?.status === 'downloading'
  const setChannel = (c: UpdateChannel): void => void run(() => window.inkling.updates.setChannel(c))
  return (
    <div className="rounded-xl border border-line px-3 py-2.5 text-[13px]" data-testid="update-settings">
      <p>
        Version <strong data-testid="update-version">{info?.version ?? '…'}</strong>
        <span className="mx-1.5 text-ink-3">·</span>
        <span data-testid="update-status">
          <UpdateLine update={update} />
        </span>
      </p>
      {update?.status === 'downloading' && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-[#eef0f4]">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${update.percent ?? 0}%` }} />
        </span>
      )}
      {update?.status === 'ready' && update.installError && <p className="mt-1 text-[12.5px] text-[#9a6200]">{update.installError}</p>}
      {update?.lastInstall && !update.lastInstall.ok && (
        <p className="mt-1 text-[12.5px] text-[#9a6200]">The last update ({update.lastInstall.version}) didn’t finish installing. Your notebooks weren’t changed.</p>
      )}
      {enabled && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {update?.status === 'ready' ? (
              <button type="button" disabled={update.installing} onClick={install} className="rounded-lg bg-accent px-2.5 py-1 text-[12.5px] font-medium text-white disabled:opacity-60">
                {update.installing ? 'Restarting…' : update.installError ? 'Try again' : 'Restart & Update'}
              </button>
            ) : (
              <button
                type="button"
                data-testid="update-check"
                disabled={working}
                onClick={() => void run(() => window.inkling.updates.check())}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-medium hover:bg-[#fafafb] disabled:opacity-50"
              >
                <RefreshCw size={12} className={working ? 'animate-spin' : ''} /> Check for Updates
              </button>
            )}
            <span className="ml-auto text-[12.5px] text-ink-3">Release channel</span>
            <div role="radiogroup" aria-label="Release channel" className="flex rounded-lg border border-line p-0.5">
              {(['stable', 'beta'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={update?.channel === c}
                  data-testid={`update-channel-${c}`}
                  disabled={working}
                  onClick={() => setChannel(c)}
                  className={`rounded-md px-2 py-0.5 text-[12.5px] disabled:opacity-50 ${update?.channel === c ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-[#fafafb]'}`}
                >
                  {c === 'stable' ? 'Stable' : 'Beta'}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {update?.channel === 'beta'
              ? 'Beta gets new features first, and stable releases too. '
              : 'Stable gets tested releases only. Switching from beta keeps your version until a newer stable one is out. '}
            Updates download in the background and install only when you choose Restart &amp; Update. Your notebooks and settings are never touched.
          </p>
          {update?.publisherVerified === false && (
            <p className="mt-1 text-[12px] text-ink-3" data-testid="update-unsigned">
              This is an unsigned test build: updates are checked against the published checksums, but your computer can’t confirm they come from Inkling’s publisher. Signed releases add that check.
            </p>
          )}
        </>
      )}
    </div>
  )
}
