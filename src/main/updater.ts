/**
 * In-app updates from GitHub Releases (electron-updater).
 *
 * Open Inkling → the update downloads in the background → "Restart & Update" → done.
 *
 * - Checks 15 seconds after start and every 6 hours (and again 30 minutes after a failure).
 * - Channels: a copy follows `stable` or `beta` (Settings → Updates). The choice is saved on
 *   first start and never changes by itself; stable copies never see betas, and switching to
 *   stable never downgrades.
 * - Nothing unfinished is installed: GitHub never lists drafts, and an update is downloaded only
 *   when its release carries Inkling-<version>-update-approval.json, which the Release workflow
 *   writes after every build and test passed, listing the exact SHA-512 of each update file
 *   (scripts/release/rules.mjs, checkApproval). Deleting that file withdraws an update.
 * - Integrity: electron-updater checks every download against the SHA-512 in latest*.yml before
 *   it can be installed; on Windows a signed build also checks the publisher, and on macOS
 *   Squirrel only accepts an update signed with the same Developer ID.
 * - Differential: on Windows and macOS, electron-updater downloads only the blocks that changed
 *   (from the .blockmap files on both releases) and falls back to the full file.
 * - Never forced: "Later" leaves it for next time (nothing installs on quit). Restart & Update
 *   saves every notebook and takes a before-update snapshot first. Notebooks and settings live in
 *   the user's app-data folder, outside the app, so the installer never touches them.
 * - The first start after an update records whether the new version actually installed.
 *
 * Modes (updatePolicy.ts): `auto` on Windows and Developer-ID macOS builds; `notify` (points to
 * the release page) for ad-hoc signed macOS builds; `off` in development.
 */
import { app, net } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { UpdateChannel, UpdateState } from '@shared/ipc'
import { REPO_URL, RELEASES_URL } from '@shared/product'
import { approvalName, checkApproval } from '../../scripts/release/rules.mjs'
import { defaultChannel, friendlyError, installOutcome, parsePrefs, resolveMode, type UpdateMode, type UpdatePrefs } from './updatePolicy'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000
type AutoUpdater = typeof import('electron-updater').autoUpdater
type Info = { version: string; files: { url: string; sha512: string }[] }

export class Updater {
  private state: UpdateState
  private readonly mode: UpdateMode
  private readonly prefsPath: string
  private prefs: UpdatePrefs = {}
  private channel: UpdateChannel
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private updater: AutoUpdater | null = null
  private busy = false
  /** Only for the automated update test (INKLING_TEST_HOOKS=1): a local feed instead of GitHub. */
  private readonly testFeed: string | undefined

  constructor(
    private readonly opts: {
      configDir: string
      testHooks: boolean
      onState: (s: UpdateState) => void
      /** Saves notebooks and takes a snapshot before restarting into an update. */
      beforeInstall: () => Promise<boolean>
    }
  ) {
    this.mode = resolveMode({
      packaged: app.isPackaged,
      platform: process.platform,
      configured: import.meta.env.MAIN_VITE_INKLING_UPDATE_MODE,
      disabled: process.env.INKLING_DISABLE_UPDATES === '1',
      testHooks: opts.testHooks,
      appImage: !!process.env.APPIMAGE
    })
    this.testFeed = opts.testHooks ? process.env.INKLING_TEST_UPDATE_FEED : undefined
    this.prefsPath = join(opts.configDir, 'update-settings.json')
    this.channel = defaultChannel(app.getVersion())
    this.state =
      this.mode === 'off'
        ? { enabled: false, status: 'disabled', message: app.isPackaged ? 'Automatic updates are off in this build.' : 'Updates are checked only in installed builds.' }
        : { enabled: true, status: 'idle', channel: this.channel }
  }

  get current(): UpdateState {
    return this.state
  }

  private set(next: Omit<UpdateState, 'enabled' | 'channel'>): void {
    // What the last restart into an update did stays visible until the next one.
    const lastInstall = this.state.lastInstall
    this.state = { enabled: true, channel: this.channel, ...(lastInstall ? { lastInstall } : {}), ...next }
    this.opts.onState(this.state)
  }

  private async savePrefs(): Promise<void> {
    const tmp = `${this.prefsPath}.tmp`
    await fs.mkdir(this.opts.configDir, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(this.prefs, null, 2))
    await fs.rename(tmp, this.prefsPath)
  }

  /** Never throws: if the updater can't start, Settings says so and the app carries on. */
  async start(): Promise<void> {
    try {
      await this.startUpdater()
    } catch (err) {
      console.warn('updater did not start:', (err as Error)?.message ?? err)
      this.updater = null
      this.set({ status: 'error', message: 'Automatic updates couldn’t start. Download new versions from the Inkling website.' })
    }
  }

  private async startUpdater(): Promise<void> {
    if (this.mode === 'off') return
    this.prefs = parsePrefs(await fs.readFile(this.prefsPath, 'utf8').catch(() => null))
    const outcome = installOutcome(this.prefs.pending, app.getVersion())
    const firstRun = !this.prefs.channel
    this.channel = this.prefs.channel ?? defaultChannel(app.getVersion())
    if (firstRun || this.prefs.pending) {
      const pending = this.prefs.pending
      this.prefs = {
        channel: this.channel,
        ...(pending && outcome ? { lastInstall: { from: pending.from, to: pending.to, ok: outcome.ok, at: new Date().toISOString() } } : this.prefs.lastInstall ? { lastInstall: this.prefs.lastInstall } : {})
      }
      await this.savePrefs().catch((err) => console.warn('update settings not saved:', (err as Error).message))
    }
    this.state = { enabled: true, status: 'idle', channel: this.channel, ...(outcome ? { lastInstall: outcome } : {}) }
    if (outcome && !outcome.ok) {
      this.state.message = `The update to Inkling ${outcome.version} didn’t finish installing. Your notebooks weren’t changed. Inkling will offer it again.`
    }

    // electron-updater is CommonJS and exports `autoUpdater` as a lazy getter, which an ESM import
    // doesn't see as a named export: take it from the default export. (Before 0.2.0-beta.4 this
    // was read as a named export, came back undefined, and those builds never checked.)
    const mod = (await import('electron-updater')) as unknown as { autoUpdater?: AutoUpdater; default?: { autoUpdater?: AutoUpdater } }
    const autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater
    if (!autoUpdater) throw new Error('electron-updater did not load')
    this.updater = autoUpdater
    autoUpdater.autoDownload = false // only after the release's approval has been checked
    autoUpdater.autoInstallOnAppQuit = false // "Later" never installs behind the user's back
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = this.channel === 'beta'
    if (this.testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: this.testFeed })
    let lastPercent = -1
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent)
      if (percent === lastPercent || this.state.status !== 'downloading') return
      lastPercent = percent
      this.set({ status: 'downloading', version: this.state.version, percent })
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }))
    this.opts.onState(this.state)
    setTimeout(() => void this.check(), Number(process.env.INKLING_UPDATE_CHECK_DELAY_MS) || 15_000)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<UpdateState> {
    const u = this.updater
    if (!u || this.busy || this.state.status === 'ready') return this.state
    this.busy = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    let phase: 'check' | 'download' = 'check'
    try {
      this.set({ status: 'checking' })
      const result = await u.checkForUpdates()
      const info = result?.updateInfo as Info | undefined
      if (!result?.isUpdateAvailable || !info) {
        this.set({ status: 'none' })
        return this.state
      }
      const approved = await this.approved(info)
      if (!approved) {
        // Published without a verified build (or withdrawn): as far as users are concerned, there is no update.
        this.set({ status: 'none' })
        return this.state
      }
      if (this.mode === 'notify') {
        this.set({ status: 'available', version: info.version, manualDownloadUrl: `${RELEASES_URL}/tag/v${info.version}` })
        return this.state
      }
      phase = 'download'
      this.set({ status: 'downloading', version: info.version, percent: 0 })
      await u.downloadUpdate()
      this.set({ status: 'ready', version: info.version })
    } catch (err) {
      const code = String((err as { code?: string })?.code ?? '')
      if (phase === 'check' && /ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS)/.test(code)) {
        this.set({ status: 'none' }) // e.g. the stable channel before the first stable release
      } else {
        console.warn(`update ${phase} failed:`, (err as Error)?.message ?? err)
        this.set({ status: 'error', message: friendlyError(err, phase) })
        this.retry = setTimeout(() => void this.check(), RETRY_AFTER_ERROR_MS)
      }
    } finally {
      this.busy = false
    }
    return this.state
  }

  /** Whether the release carries an approval for exactly these files. Throws when it can't be fetched (offline). */
  private async approved(info: Info): Promise<boolean> {
    const name = approvalName(info.version)
    const url = this.testFeed ? `${this.testFeed.replace(/\/$/, '')}/${name}` : `${REPO_URL}/releases/download/v${info.version}/${name}`
    const res = await net.fetch(url, { signal: AbortSignal.timeout(30_000), cache: 'no-store' })
    if (res.status === 404) {
      console.warn(`update ${info.version}: no ${name} on the release; not offered`)
      return false
    }
    if (!res.ok) throw new Error(`approval request failed: network status ${res.status}`)
    const verdict = checkApproval(await res.json().catch(() => null), info)
    if (!verdict.ok) console.warn(`update ${info.version} not offered: ${verdict.reason}`)
    return verdict.ok
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    if (this.mode === 'off' || channel === this.channel || this.busy) return this.state
    this.channel = channel
    this.prefs.channel = channel
    await this.savePrefs()
    if (this.updater) this.updater.allowPrerelease = channel === 'beta'
    // Whatever was found or downloaded belonged to the other channel.
    this.set({ status: 'idle' })
    return this.check()
  }

  async install(): Promise<void> {
    const u = this.updater
    const version = this.state.version
    if (!u || this.state.status !== 'ready' || !version) return
    if (!(await this.opts.beforeInstall())) return
    this.prefs.pending = { from: app.getVersion(), to: version, at: new Date().toISOString() }
    await this.savePrefs().catch((err) => console.warn('update settings not saved:', (err as Error).message))
    this.stop()
    // Windows: the installer runs silently (no wizard) and starts the new version when done.
    u.quitAndInstall(true, true)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
  }
}
