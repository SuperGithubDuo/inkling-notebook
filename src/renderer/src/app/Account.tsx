/**
 * Account and sync: the Settings section (sign in, status, sign out), the
 * question asked before notebooks from before sign-in join the account, and
 * the list of earlier versions of a page.
 */
import { useEffect, useState } from 'react'
import { CloudOff, History, LoaderCircle, LogOut, Mail, RefreshCw, TriangleAlert, UserRound } from 'lucide-react'
import type { RemoteVersion } from '@shared/sync/engine'
import { parsePath } from '@shared/sync/docs'
import { displayTitle } from '@shared/library'
import { useStore } from '@/store/store'
import { Dialog } from './Dialog'
import { syncSummary, useAccount } from './accountStore'

const button = 'rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-medium hover:bg-[#fafafb] disabled:opacity-40'
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-strong disabled:opacity-50'
const web = (): boolean => window.inkling.platform === 'web'

/** A page's name for a sync path. */
function titleOf(path: string): string {
  const p = parsePath(path)
  if (!p || p.kind === 'library') return 'The notebook list'
  const nb = useStore.getState().library?.notebooks.find((n) => n.id === p.notebookId)
  const page = nb?.pages.find((x) => x.id === p.pageId)
  return nb && page ? displayTitle(nb, page) : 'A page'
}

export function AccountSettings() {
  const account = useAccount((s) => s.account)
  const [busy, setBusy] = useState(false)
  if (!account) return null
  if (!account.available) {
    return (
      <p className="text-[13px] text-ink-2" data-testid="account-unavailable">
        This copy of Inkling was built without a sync server, so notebooks stay {web() ? 'in this browser' : 'on this computer'}. Use <em>Back up now</em> below to keep a copy elsewhere.
      </p>
    )
  }
  if (!account.user) return <SignIn message={account.sync.message} />

  const summary = syncSummary(account)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await fn().catch(() => undefined)
    setBusy(false)
  }
  const signOut = (): void => {
    const pending = account.sync.pending
    const where = web() ? 'in this browser' : 'on this computer'
    const text = pending
      ? `${pending} change${pending === 1 ? ' has' : 's have'} not synced yet. If you sign out now ${pending === 1 ? 'it stays' : 'they stay'} ${where} and sync${pending === 1 ? 's' : ''} the next time you sign in to this account here.\n\nSign out anyway?`
      : web()
        ? 'Sign out? Your notebooks stay in your account and are removed from this browser.'
        : 'Sign out? Your notebooks stay on this computer and in your account; they stop syncing until you sign in again.'
    if (window.confirm(text)) void run(() => window.inkling.account.signOut())
  }
  return (
    <div className="space-y-2" data-testid="account-signed-in">
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-[#fafafb] px-3 py-2.5">
        <UserRound size={16} className="shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium" data-testid="account-email">{account.user.email ?? 'Signed in'}</div>
          <div className="text-[12.5px] text-ink-2" data-testid="sync-detail" data-state={summary.state}>{summary.detail}</div>
        </div>
        <button type="button" className={button} disabled={busy} onClick={() => void run(() => window.inkling.account.syncNow())} data-testid="sync-now">
          <RefreshCw size={12} className={busy || account.sync.state === 'syncing' ? 'mr-1 inline animate-spin' : 'mr-1 inline'} />
          Sync now
        </button>
        <button type="button" className={button} disabled={busy} onClick={signOut} data-testid="sign-out">
          <LogOut size={12} className="mr-1 inline" />
          Sign out
        </button>
      </div>
      {account.sync.conflicts.length > 0 && (
        <div className="rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-3 py-2.5 text-[12.5px]" data-testid="sync-conflicts">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert size={14} className="text-[#c27c0e]" /> Edited in two places at once
          </p>
          <p className="mt-0.5 text-ink-2">Where two devices changed the same thing, this device’s version is shown. The other version is kept: open it from “Earlier versions”.</p>
          <ul className="mt-1.5 space-y-1">
            {account.sync.conflicts.map((c) => (
              <li key={c.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{titleOf(c.path)}</span>
                <span className="text-ink-3">{new Date(c.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <button type="button" className={button} onClick={() => useAccount.getState().showHistory({ path: c.path, title: titleOf(c.path) })}>
                  Earlier versions
                </button>
                <button type="button" className={button} onClick={() => void window.inkling.account.dismissConflict(c.path)}>
                  Keep mine
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {account.sync.skipped > 0 && (
        <p className="flex items-start gap-1.5 text-[12.5px] text-ink-2" data-testid="sync-skipped">
          <CloudOff size={14} className="mt-0.5 shrink-0 text-ink-3" />
          {account.sync.skipped} file{account.sync.skipped === 1 ? ' is' : 's are'} over 50 MB and stay{account.sync.skipped === 1 ? 's' : ''} on this device only. The pages still sync; other devices show them without that PDF or image.
        </p>
      )}
    </div>
  )
}

function SignIn({ message }: { message?: string }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<{ ok: true } | { error: string }>, then?: () => void): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await fn().catch((err: Error) => ({ error: err.message }))
    setBusy(false)
    if ('error' in r) setError(r.error)
    else then?.()
  }
  return (
    <div className="space-y-2.5" data-testid="account-signed-out">
      <p className="text-[13.5px] text-ink-2">
        Sign in to keep your notebooks in sync between the web app and the desktop app, and backed up to your account. It’s optional: without an account everything stays {web() ? 'in this browser' : 'on this computer'}.
      </p>
      {message && <p className="text-[12.5px] text-[#c03a3e]" data-testid="account-message">{message}</p>}
      <button type="button" className={`${primary} flex w-full items-center justify-center gap-2`} disabled={busy} onClick={() => void run(() => window.inkling.account.signInWithGoogle())} data-testid="sign-in-google">
        {busy && !sent ? <LoaderCircle size={14} className="animate-spin" /> : null} Continue with Google
      </button>
      {!sent ? (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => window.inkling.account.signInWithEmail(email.trim()), () => setSent(true))
          }}
        >
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="sign-in-email"
            className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          <button type="submit" className={button} disabled={busy || !email.includes('@')} data-testid="sign-in-email-send">
            <Mail size={12} className="mr-1 inline" /> Email me a link
          </button>
        </form>
      ) : (
        <form
          className="space-y-1.5 rounded-xl border border-line px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => window.inkling.account.verifyEmailCode(email.trim(), code))
          }}
        >
          <p className="text-[13px]">
            We sent an email to <strong>{email}</strong>. {web() ? 'Open the link in it in this browser, or enter' : 'Enter'} the code from the email here.
          </p>
          <div className="flex gap-1.5">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code from the email"
              aria-label="Code from the email"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
              data-testid="sign-in-code"
              className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-[13px] tracking-widest outline-none focus:border-accent"
            />
            <button type="submit" className={button} disabled={busy || code.length < 6}>
              Sign in
            </button>
            <button type="button" className={button} onClick={() => (setSent(false), setCode(''))}>
              Back
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-[12.5px] text-[#c03a3e]" role="alert" data-testid="sign-in-error">{error}</p>}
    </div>
  )
}

/** Asked once after signing in on a device that already has notebooks. Nothing joins the account without a yes. */
export function MigrationDialog() {
  const pending = useAccount((s) => s.account?.pendingMigration ?? null)
  const email = useAccount((s) => s.account?.user?.email)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!pending) return null
  const answer = async (accept: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.inkling.account.confirmMigration(accept)
    } catch (err) {
      setError(`Your notebooks are safe in this browser, but they couldn’t all be added to your account: ${(err as Error).message} Try again.`)
    }
    setBusy(false)
  }
  const what = `${pending.notebooks} notebook${pending.notebooks === 1 ? '' : 's'} (${pending.pages} page${pending.pages === 1 ? '' : 's'})`
  return (
    <Dialog title="Add this device’s notebooks to your account?" onClose={() => void answer(false)} testId="migration-dialog" width={480}>
      <p className="text-[14px] text-ink-2">
        {web() ? 'This browser has' : 'This computer has'} <strong className="text-ink">{what}</strong> from before you signed in{email ? ` as ${email}` : ''}.
        {pending.otherAccount ? ' They were last synced with a different account.' : ''}
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
        <li>
          <strong className="text-ink">Add to my account</strong>: they are added next to the notebooks already in your account and sync to your other devices. Nothing in your account is replaced.
        </li>
        <li>
          <strong className="text-ink">{web() ? 'Keep them out' : 'Don’t sign in'}</strong>:{' '}
          {web() ? 'they stay in this browser, untouched, and are here again when you sign out.' : 'you stay signed out and they stay on this computer, untouched.'}
        </li>
      </ul>
      {error && <p className="mt-2 text-[12.5px] text-[#c03a3e]" role="alert">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void answer(false)} data-testid="migration-decline">
          {web() ? 'Keep them out' : 'Don’t sign in'}
        </button>
        <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)} data-testid="migration-accept">
          {busy ? 'Adding…' : 'Add to my account'}
        </button>
      </div>
    </Dialog>
  )
}

/** Earlier versions of one page kept by the account; restoring one is an ordinary, synced edit. */
export function VersionHistory() {
  const target = useAccount((s) => s.historyOf)
  const [versions, setVersions] = useState<RemoteVersion[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setVersions(null)
    setMessage(null)
    if (!target) return
    void window.inkling.account.versions(target.path).then((r) => ('error' in r ? setMessage(r.error) : setVersions(r)))
  }, [target])
  if (!target) return null
  const close = (): void => useAccount.getState().showHistory(null)
  const restore = async (v: RemoteVersion): Promise<void> => {
    if (!window.confirm('Replace the current page with this earlier version? The current one is kept as an earlier version too, so you can go back.')) return
    setBusy(true)
    const r = await window.inkling.account.restoreVersion(target.path, v.id)
    setBusy(false)
    if (r.status === 'saved') close()
    else setMessage(r.status === 'error' ? r.message : 'The page was changed by another program.')
  }
  return (
    <Dialog title="Earlier versions" onClose={close} testId="version-history" width={460}>
      <p className="mb-3 text-[13px] text-ink-2">
        <History size={13} className="mr-1 inline text-ink-3" />
        <strong className="text-ink">{target.title}</strong>. Your account keeps up to 20 earlier versions of each page: before changes from another device, when two devices disagreed, and every ten minutes while you work.
      </p>
      {message && <p className="text-[13px] text-[#c03a3e]" role="alert">{message}</p>}
      {!versions && !message && <LoaderCircle className="animate-spin text-ink-3" size={18} />}
      {versions?.length === 0 && <p className="text-[13px] text-ink-3" data-testid="no-versions">No earlier versions yet.</p>}
      <ul className="space-y-1">
        {versions?.map((v) => (
          <li key={v.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[#fafafb]" data-testid="version-row">
            <span className="flex-1">{new Date(v.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="text-[12px] text-ink-3">{v.device?.startsWith('web') ? 'web app' : v.device ? 'desktop app' : ''}</span>
            <button type="button" className={button} disabled={busy} onClick={() => void restore(v)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
