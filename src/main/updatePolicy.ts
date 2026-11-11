/**
 * The updater's decisions, as pure functions (no Electron), so tests/unit/updater.test.ts can
 * cover them: which mode a build runs in, which channel it follows, what a previous restart into
 * an update achieved, and how errors are worded.
 */
import type { UpdateChannel } from '@shared/ipc'

export type UpdateMode = 'auto' | 'notify' | 'off'

/**
 * Two different guarantees, kept apart:
 * - Integrity: electron-updater checks every download against the SHA-512 in latest*.yml, and
 *   Inkling only downloads files whose SHA-512 the release's update approval lists. That catches
 *   corrupted or swapped files, but both come from the same GitHub release, so it can't tell
 *   whether that release was published by Inkling's maintainers (e.g. a stolen GitHub token).
 * - Authentication: only a code signature does that. A signed Windows build records its
 *   publisher, and electron-updater then refuses any update not signed by the same publisher;
 *   Squirrel.Mac requires the same Developer ID.
 *
 * Modes:
 * - Windows, signed (`signed`): `auto` (download in the background, Restart & Update).
 * - Windows, unsigned: `auto` only for beta/test builds (a prerelease version), which testers
 *   install knowing they are unsigned; an unsigned stable build only says a new version exists
 *   (`notify`), whatever the build asked for. The Release workflow also refuses to make one.
 * - macOS: `notify` unless the build is Developer-ID signed and the workflow set `auto`
 *   (Squirrel.Mac refuses updates to ad-hoc signed apps).
 * - Linux: only for the automated update test (AppImage), never for users.
 * - Development and unpackaged builds, or INKLING_DISABLE_UPDATES=1: `off`.
 */
export function resolveMode(o: {
  packaged: boolean
  platform: string
  version: string
  configured?: string
  signed?: boolean
  disabled?: boolean
  testHooks?: boolean
  appImage?: boolean
}): UpdateMode {
  if (!o.packaged || o.disabled) return 'off'
  const configured = o.configured === 'auto' || o.configured === 'notify' || o.configured === 'off' ? o.configured : undefined
  if (configured === 'off') return 'off'
  const prerelease = o.version.includes('-')
  if (o.platform === 'win32') {
    if (o.signed) return configured ?? 'auto'
    return prerelease ? (configured ?? 'auto') : 'notify'
  }
  if (o.platform === 'darwin') return configured ?? 'notify'
  if (o.platform === 'linux' && o.testHooks && o.appImage) return configured ?? 'auto'
  return 'off'
}

/** A beta build starts on the beta channel, a stable build on stable. */
export function defaultChannel(version: string): UpdateChannel {
  return version.includes('-') ? 'beta' : 'stable'
}

export interface UpdatePrefs {
  /**
   * Saved on first start, so the channel never changes by itself: a beta tester who updates to a
   * stable release stays on beta and still gets the next beta.
   */
  channel?: UpdateChannel
  /** Written just before restarting into an update, read on the next start. */
  pending?: { from: string; to: string; at: string }
  /** The outcome of the last Restart & Update, kept for support. */
  lastInstall?: { from: string; to: string; ok: boolean; at: string }
}

export function parsePrefs(text: string | null): UpdatePrefs {
  if (!text) return {}
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    const out: UpdatePrefs = {}
    if (v.channel === 'stable' || v.channel === 'beta') out.channel = v.channel
    const p = v.pending as Record<string, unknown> | undefined
    if (p && typeof p.from === 'string' && typeof p.to === 'string' && typeof p.at === 'string') out.pending = { from: p.from, to: p.to, at: p.at }
    const l = v.lastInstall as Record<string, unknown> | undefined
    if (l && typeof l.from === 'string' && typeof l.to === 'string' && typeof l.ok === 'boolean' && typeof l.at === 'string') out.lastInstall = { from: l.from, to: l.to, ok: l.ok, at: l.at }
    return out
  } catch {
    return {}
  }
}

/**
 * What the last Restart & Update did, judged on the next start:
 * - running the new version → it installed;
 * - still the old version → the installer didn't finish (nothing about the notebooks changed:
 *   they live outside the app, and a before-update snapshot was taken);
 * - anything else (e.g. the user installed another version by hand) → nothing to say.
 */
export function installOutcome(pending: UpdatePrefs['pending'], running: string): { ok: boolean; version: string } | null {
  if (!pending) return null
  if (running === pending.to) return { ok: true, version: pending.to }
  if (running === pending.from) return { ok: false, version: pending.to }
  return null
}

export function friendlyError(err: unknown, phase: 'check' | 'download'): string {
  const msg = String((err as Error)?.message ?? err)
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update failed its integrity check and was discarded. Inkling will try again later.'
  if (/signature|code sign|not signed|publisher/i.test(msg)) return 'The update’s signature couldn’t be verified, so it wasn’t installed.'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|net::|aborted|premature/i.test(msg))
    return phase === 'download' ? 'The download was interrupted. Inkling will try again later.' : 'Couldn’t check for updates (no connection). Inkling will try again later.'
  if (/ENOSPC/i.test(msg)) return 'Not enough disk space to download the update.'
  return phase === 'download' ? 'The update couldn’t be downloaded. Inkling will try again later.' : 'Couldn’t check for updates. Inkling will try again later.'
}

export type InstallFailure = { ok: false; step: 'withdrawn' | 'unverified' | 'save' | 'backup' | 'record'; message: string }

/**
 * Everything that must succeed before Inkling quits to install an update, in order. The first
 * failure stops it: nothing restarts, nothing is installed, and the message says what to do.
 *
 * 1. revalidate: the release's update approval is fetched again for exactly the downloaded files,
 *    so an update withdrawn after it was downloaded is never installed (false = withdrawn; a
 *    throw = couldn't confirm, e.g. offline: fail closed).
 * 2. save: every pending edit reaches the disk.
 * 3. backup: a complete before-update snapshot exists.
 * 4. record: the pending-update record is written, so the next start can tell whether the
 *    installer finished.
 */
export async function prepareInstall(version: string, steps: {
  revalidate(): Promise<boolean>
  save(): Promise<{ ok: boolean; message?: string }>
  backup(): Promise<void>
  record(): Promise<void>
}): Promise<{ ok: true } | InstallFailure> {
  const why = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200)
  try {
    if (!(await steps.revalidate()))
      return { ok: false, step: 'withdrawn', message: `Inkling ${version} is no longer offered, so it won’t be installed. Nothing was changed; you don’t need to do anything.` }
  } catch (err) {
    console.warn('update approval could not be re-checked:', why(err))
    return { ok: false, step: 'unverified', message: `Inkling couldn’t confirm that ${version} is still approved, so it didn’t restart. Nothing was changed. Check your connection and try again.` }
  }
  let saved: { ok: boolean; message?: string }
  try {
    saved = await steps.save()
  } catch (err) {
    saved = { ok: false, message: why(err) }
  }
  if (!saved.ok) {
    if (saved.message) console.warn('save before update failed:', saved.message)
    return { ok: false, step: 'save', message: 'Inkling couldn’t save your latest changes, so it didn’t restart. Try again in a moment.' }
  }
  try {
    await steps.backup()
  } catch (err) {
    console.warn('before-update backup failed:', why(err))
    return { ok: false, step: 'backup', message: 'Inkling couldn’t make its backup before updating, so it didn’t restart. Your notebooks weren’t changed. Check that the disk has free space, then try again.' }
  }
  try {
    await steps.record()
  } catch (err) {
    console.warn('pending-update record not saved:', why(err))
    return { ok: false, step: 'record', message: 'Inkling couldn’t prepare the update, so it didn’t restart. Your notebooks weren’t changed. Try again.' }
  }
  return { ok: true }
}
