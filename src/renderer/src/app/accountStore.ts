/** The account and sync status, as the platform reports it (web: Supabase in the page; desktop: the main process). */
import { create } from 'zustand'
import type { AccountState } from '@shared/ipc'

interface Store {
  account: AccountState | null
  /** The page whose earlier versions are being shown (a sync path), or null. */
  historyOf: { path: string; title: string } | null
  showHistory(target: Store['historyOf']): void
}

export const useAccount = create<Store>((set) => ({
  account: null,
  historyOf: null,
  showHistory: (historyOf) => set({ historyOf })
}))

let started = false
/** Starts following the account state (once per window). */
export function watchAccount(): void {
  if (started) return
  started = true
  const apply = (account: AccountState): void => useAccount.setState({ account })
  window.inkling.account.onState(apply)
  void window.inkling.account.state().then(apply)
}

/** One line describing where the notes are, for the top bar. */
export function syncSummary(a: AccountState | null): { state: 'local' | 'synced' | 'syncing' | 'offline' | 'error'; text: string; detail: string } {
  const here = window.inkling.platform === 'web' ? 'in this browser' : 'on this computer'
  if (!a?.user) return { state: 'local', text: 'Saved', detail: `All changes saved ${here}` }
  const s = a.sync
  const waiting = s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'} waiting to sync` : ''
  if (s.conflicts.length) return { state: 'error', text: 'Review', detail: 'Changes from another device overlapped with yours. Open Settings → Account to review.' }
  if (s.state === 'syncing') return { state: 'syncing', text: 'Syncing…', detail: waiting || 'Checking for changes' }
  if (s.state === 'error') return { state: 'error', text: 'Sync problem', detail: s.message ?? 'Sync failed; it will be retried.' }
  if (s.state === 'off') return { state: 'offline', text: 'Not syncing', detail: s.message ?? `Saved ${here}. Sign in again to sync.` }
  if (s.state === 'offline' || s.pending) return { state: 'offline', text: s.state === 'offline' ? 'Offline' : 'Saved', detail: `Saved ${here}. ${waiting || 'Sync resumes when you are back online.'}` }
  return { state: 'synced', text: 'Synced', detail: `Saved ${here} and synced to ${a.user.email ?? 'your account'}` }
}
