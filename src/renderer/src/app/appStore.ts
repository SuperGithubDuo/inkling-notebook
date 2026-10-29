/**
 * App-level dialogs and state: welcome, About, privacy, backups and updates.
 * Menu commands from the main process arrive here.
 */
import { create } from 'zustand'
import type { AppCommand, AppInfo, UpdateState } from '@shared/ipc'
import { useAi } from '@/ai/aiStore'

export type AppDialog = 'welcome' | 'about' | 'privacy' | null
const WELCOMED_KEY = 'inkling.welcomed.v1'

interface AppState {
  dialog: AppDialog
  info: AppInfo | null
  update: UpdateState | null
  /** A settings section to scroll to when Settings opens. */
  settingsSection: 'storage' | 'ai' | 'privacy' | null
  open(dialog: AppDialog): void
  openSettings(section?: AppState['settingsSection']): void
  loadInfo(): Promise<AppInfo>
  setUpdate(u: UpdateState): void
  /** Shows the welcome the first time Inkling starts. */
  maybeWelcome(): void
  finishWelcome(): void
}

const readFlag = (): boolean => {
  try {
    return localStorage.getItem(WELCOMED_KEY) === '1'
  } catch {
    return false
  }
}

export const useApp = create<AppState>((set, get) => ({
  dialog: null,
  info: null,
  update: null,
  settingsSection: null,
  open(dialog) {
    set({ dialog })
  },
  openSettings(section = null) {
    set({ dialog: null, settingsSection: section })
    useAi.getState().openSettings(true)
  },
  async loadInfo() {
    const info = get().info ?? (await window.inkling.appInfo())
    set({ info })
    return info
  },
  setUpdate(update) {
    set({ update })
  },
  maybeWelcome() {
    if (readFlag()) return
    // Acceptance tests of other features start straight in the notebook (INKLING_SKIP_WELCOME=1).
    void get()
      .loadInfo()
      .then((info) => {
        if (!info.skipWelcome && !get().dialog) set({ dialog: 'welcome' })
      })
  },
  finishWelcome() {
    try {
      localStorage.setItem(WELCOMED_KEY, '1')
    } catch {
      /* not critical */
    }
    set({ dialog: null })
  }
}))

export function runCommand(command: AppCommand): void {
  const app = useApp.getState()
  switch (command) {
    case 'about':
    case 'welcome':
    case 'privacy':
      app.open(command)
      return
    case 'settings':
      app.openSettings()
      return
    case 'feedback':
      void window.inkling.openFeedback()
      return
    case 'backup':
      void window.inkling.backups.backupNow().then((r) => {
        if (r.saved) window.alert(`Backup saved to:\n${r.path}`)
        else if (r.error) window.alert(`The backup was not made: ${r.error}`)
      })
      return
    case 'restore':
      void window.inkling.backups.restore(null).then((r) => {
        if (!r.restored && r.error) window.alert(`Nothing was restored: ${r.error}`)
      })
      return
  }
}
