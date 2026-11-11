/** The updater's decisions (src/main/updatePolicy.ts). The real download/install path runs in tests/e2e/update.e2e.mjs. */
import { describe, expect, it } from 'vitest'
import { defaultChannel, friendlyError, installOutcome, parsePrefs, prepareInstall, resolveMode } from '../../src/main/updatePolicy'

describe('update mode: integrity is not authentication', () => {
  const beta = { packaged: true, platform: 'win32', version: '0.2.0-beta.4' }
  const stable = { ...beta, version: '0.2.0' }
  it('signed Windows builds install updates themselves (publisher checked by electron-updater)', () => {
    expect(resolveMode({ ...stable, signed: true })).toBe('auto')
    expect(resolveMode({ ...beta, signed: true })).toBe('auto')
  })
  it('unsigned Windows builds install updates themselves only as betas (testers)', () => {
    expect(resolveMode(beta)).toBe('auto')
    expect(resolveMode({ ...beta, configured: 'notify' })).toBe('notify')
  })
  it('an unsigned stable Windows build only announces updates, even if built with auto', () => {
    expect(resolveMode(stable)).toBe('notify')
    expect(resolveMode({ ...stable, configured: 'auto' })).toBe('notify')
  })
  it('macOS only says a new version exists unless the build is Developer ID signed (workflow sets auto)', () => {
    expect(resolveMode({ ...beta, platform: 'darwin' })).toBe('notify')
    expect(resolveMode({ ...beta, platform: 'darwin', configured: 'auto', signed: true })).toBe('auto')
  })
  it('off in development, when disabled, and on Linux outside the update test', () => {
    expect(resolveMode({ ...beta, packaged: false })).toBe('off')
    expect(resolveMode({ ...beta, disabled: true })).toBe('off')
    expect(resolveMode({ ...beta, configured: 'off' })).toBe('off')
    expect(resolveMode({ ...beta, platform: 'linux' })).toBe('off')
    expect(resolveMode({ ...beta, platform: 'linux', testHooks: true })).toBe('off')
    expect(resolveMode({ ...beta, platform: 'linux', testHooks: true, appImage: true })).toBe('auto')
  })
  it('ignores an unknown configured mode', () => {
    expect(resolveMode({ ...beta, configured: 'yes' })).toBe('auto')
  })
})

describe('Restart & Update goes ahead only when everything before it succeeded', () => {
  const V = '0.2.0-beta.4'
  function steps(fail?: 'withdrawn' | 'offline' | 'save' | 'saveThrows' | 'backup' | 'record') {
    const done: string[] = []
    return {
      done,
      s: {
        async revalidate() {
          done.push('revalidate')
          if (fail === 'offline') throw new Error('net::ERR_INTERNET_DISCONNECTED')
          return fail !== 'withdrawn'
        },
        async save() {
          done.push('save')
          if (fail === 'saveThrows') throw new Error('renderer gone')
          return fail === 'save' ? { ok: false, message: 'Saving took too long.' } : { ok: true }
        },
        async backup() {
          done.push('backup')
          if (fail === 'backup') throw new Error("ENOTDIR: not a directory, mkdir '/x/Backups/2026 before-update.partial'")
        },
        async record() {
          done.push('record')
          if (fail === 'record') throw new Error('EACCES: permission denied, rename update-settings.json.tmp')
        }
      }
    }
  }
  it('all steps succeed, in order: re-check approval, save, back up, record', async () => {
    const t = steps()
    expect(await prepareInstall(V, t.s)).toEqual({ ok: true })
    expect(t.done).toEqual(['revalidate', 'save', 'backup', 'record'])
  })
  it('a failed backup stops the update before anything is recorded or installed (regression)', async () => {
    const t = steps('backup')
    const r = await prepareInstall(V, t.s)
    expect(r).toMatchObject({ ok: false, step: 'backup' })
    expect(!r.ok && r.message).toMatch(/couldn’t make its backup.*didn’t restart.*notebooks weren’t changed.*try again/i)
    expect(t.done).toEqual(['revalidate', 'save', 'backup'])
  })
  it('a pending-update record that cannot be saved stops the update', async () => {
    const t = steps('record')
    const r = await prepareInstall(V, t.s)
    expect(r).toMatchObject({ ok: false, step: 'record' })
    expect(!r.ok && r.message).toMatch(/didn’t restart.*Try again/)
  })
  it('unsaved changes stop the update, whether saving reports a failure or throws', async () => {
    for (const f of ['save', 'saveThrows'] as const) {
      const t = steps(f)
      expect(await prepareInstall(V, t.s)).toMatchObject({ ok: false, step: 'save' })
      expect(t.done).toEqual(['revalidate', 'save'])
    }
  })
  it('an update withdrawn after it was downloaded is not installed, and nothing else runs', async () => {
    const t = steps('withdrawn')
    const r = await prepareInstall(V, t.s)
    expect(r).toMatchObject({ ok: false, step: 'withdrawn' })
    expect(!r.ok && r.message).toMatch(/no longer offered/)
    expect(t.done).toEqual(['revalidate'])
  })
  it('if the approval cannot be re-checked (offline), it fails closed', async () => {
    const t = steps('offline')
    expect(await prepareInstall(V, t.s)).toMatchObject({ ok: false, step: 'unverified' })
    expect(t.done).toEqual(['revalidate'])
  })
})

describe('release channel', () => {
  it('starts from the version that was installed', () => {
    expect(defaultChannel('0.2.0-beta.3')).toBe('beta')
    expect(defaultChannel('0.2.0')).toBe('stable')
  })
  it('a saved channel is read back; anything else is ignored', () => {
    expect(parsePrefs('{"channel":"beta"}')).toEqual({ channel: 'beta' })
    expect(parsePrefs('{"channel":"nightly"}')).toEqual({})
    expect(parsePrefs('not json')).toEqual({})
    expect(parsePrefs(null)).toEqual({})
  })
})

describe('after Restart & Update', () => {
  const pending = { from: '0.2.0-beta.3', to: '0.2.0-beta.4', at: '2026-11-10T00:00:00Z' }
  it('running the new version: installed', () => {
    expect(installOutcome(pending, '0.2.0-beta.4')).toEqual({ ok: true, version: '0.2.0-beta.4' })
  })
  it('still the old version: the installer did not finish', () => {
    expect(installOutcome(pending, '0.2.0-beta.3')).toEqual({ ok: false, version: '0.2.0-beta.4' })
  })
  it('another version (installed by hand) or nothing pending: nothing to report', () => {
    expect(installOutcome(pending, '0.2.0-beta.5')).toBeNull()
    expect(installOutcome(undefined, '0.2.0-beta.4')).toBeNull()
    expect(parsePrefs(JSON.stringify({ channel: 'stable', pending })).pending).toEqual(pending)
  })
})

describe('error messages', () => {
  it('names integrity, signature, connection and disk problems', () => {
    expect(friendlyError(new Error('sha512 checksum mismatch, expected x'), 'download')).toMatch(/integrity/)
    expect(friendlyError(new Error('New version is not signed by the application owner: publisherNames'), 'download')).toMatch(/signature/)
    expect(friendlyError(new Error('net::ERR_CONNECTION_RESET'), 'download')).toMatch(/interrupted/)
    expect(friendlyError(new Error('getaddrinfo ENOTFOUND github.com'), 'check')).toMatch(/no connection/)
    expect(friendlyError(new Error('ENOSPC: no space left'), 'download')).toMatch(/disk space/)
    expect(friendlyError(new Error('weird'), 'check')).toMatch(/try again later/)
  })
})
