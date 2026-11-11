/**
 * The updater's decisions, as pure functions (no Electron), so tests/unit/updater.test.ts can
 * cover them: which mode a build runs in, which channel it follows, what a previous restart into
 * an update achieved, and how errors are worded.
 */
import type { UpdateChannel } from '@shared/ipc'

export type UpdateMode = 'auto' | 'notify' | 'off'

/**
 * - Windows: `auto` (download in the background, then offer Restart & Update). electron-updater
 *   checks every download against the SHA-512 in latest.yml, and once builds are signed, that the
 *   new installer is signed by the same publisher.
 * - macOS: `notify` unless the build was made with a Developer ID (the release workflow then sets
 *   `auto`): Squirrel.Mac refuses to install updates into ad-hoc signed apps.
 * - Linux: only for the automated update test (AppImage), never for users.
 * - Development and unpackaged builds, or INKLING_DISABLE_UPDATES=1: `off`.
 */
export function resolveMode(o: { packaged: boolean; platform: string; configured?: string; disabled?: boolean; testHooks?: boolean; appImage?: boolean }): UpdateMode {
  if (!o.packaged || o.disabled) return 'off'
  const configured = o.configured === 'auto' || o.configured === 'notify' || o.configured === 'off' ? o.configured : undefined
  if (o.platform === 'win32') return configured ?? 'auto'
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
