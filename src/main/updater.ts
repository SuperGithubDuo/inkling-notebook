/**
 * Updates from GitHub Releases (electron-updater).
 *
 * Integrity: every download is checked against the SHA-512 in the release's
 * `latest*.yml` before it can be installed; on Windows a signed build also
 * checks that the new installer is signed by the same publisher, and on
 * macOS the update framework only accepts an update signed with the same
 * Developer ID. Updates are never installed silently: Inkling says an update
 * is ready and restarts into it only when the user clicks.
 *
 * Mode (set when building, MAIN_VITE_INKLING_UPDATE_MODE):
 * - `auto`: download in the background, then offer "Restart to update".
 *   Only for signed builds; the release workflow sets it when signing
 *   credentials are present.
 * - `notify` (default): check, and if there is a newer version, point to the
 *   release page. Used for unsigned betas, where a self-installing update
 *   could not be verified against a publisher.
 * - `off`: no checks (also in development and unpackaged builds).
 */
import { app } from 'electron'
import type { UpdateState } from '@shared/ipc'
import { RELEASES_URL } from '@shared/product'

type Mode = 'auto' | 'notify' | 'off'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export class Updater {
  private state: UpdateState
  private readonly mode: Mode
  private timer: ReturnType<typeof setInterval> | null = null
  private updater: typeof import('electron-updater').autoUpdater | null = null

  constructor(
    private readonly opts: {
      onState: (s: UpdateState) => void
      /** Saves notebooks and takes a snapshot before restarting into an update. */
      beforeInstall: () => Promise<boolean>
    }
  ) {
    const configured = (import.meta.env.MAIN_VITE_INKLING_UPDATE_MODE ?? 'notify') as Mode
    this.mode = !app.isPackaged || process.env.INKLING_DISABLE_UPDATES === '1' || !['win32', 'darwin'].includes(process.platform) ? 'off' : configured
    this.state =
      this.mode === 'off'
        ? { enabled: false, status: 'disabled', message: app.isPackaged ? 'Automatic updates are off in this build.' : 'Updates are checked only in installed builds.' }
        : { enabled: true, status: 'idle' }
  }

  get current(): UpdateState {
    return this.state
  }

  private set(next: UpdateState): void {
    this.state = next
    this.opts.onState(next)
  }

  async start(): Promise<void> {
    if (this.mode === 'off') return
    const { autoUpdater } = await import('electron-updater')
    this.updater = autoUpdater
    autoUpdater.autoDownload = this.mode === 'auto'
    autoUpdater.autoInstallOnAppQuit = false
    // Beta builds (e.g. 0.2.0-beta.3) follow pre-releases; stable builds don't.
    autoUpdater.allowPrerelease = app.getVersion().includes('-')
    autoUpdater.on('checking-for-update', () => this.set({ enabled: true, status: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ enabled: true, status: 'none' }))
    autoUpdater.on('update-available', (info) =>
      this.set({
        enabled: true,
        status: this.mode === 'auto' ? 'downloading' : 'available',
        version: info.version,
        ...(this.mode === 'auto' ? {} : { manualDownloadUrl: `${RELEASES_URL}/tag/v${info.version}` })
      })
    )
    autoUpdater.on('update-downloaded', (info) => this.set({ enabled: true, status: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => this.set({ enabled: true, status: 'error', message: friendly(err) }))
    setTimeout(() => void this.check(), 15_000)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    try {
      await this.updater.checkForUpdates()
    } catch (err) {
      this.set({ enabled: true, status: 'error', message: friendly(err) })
    }
    return this.state
  }

  async install(): Promise<void> {
    if (!this.updater || this.state.status !== 'ready') return
    if (!(await this.opts.beforeInstall())) return
    this.updater.quitAndInstall(false, true)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

function friendly(err: unknown): string {
  const msg = String((err as Error)?.message ?? err)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|net::/i.test(msg)) return 'Couldn’t check for updates (no connection). Inkling will try again later.'
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update failed its integrity check and was discarded.'
  if (/signature|code sign|not signed/i.test(msg)) return 'The update’s signature couldn’t be verified, so it wasn’t installed.'
  return 'Couldn’t check for updates. Inkling will try again later.'
}
