/** The updater's decisions (src/main/updatePolicy.ts). The real download/install path runs in tests/e2e/update.e2e.mjs. */
import { describe, expect, it } from 'vitest'
import { defaultChannel, friendlyError, installOutcome, parsePrefs, resolveMode } from '../../src/main/updatePolicy'

describe('update mode', () => {
  const base = { packaged: true, platform: 'win32' }
  it('Windows installs updates itself, signed or not', () => {
    expect(resolveMode(base)).toBe('auto')
    expect(resolveMode({ ...base, configured: 'auto' })).toBe('auto')
  })
  it('macOS only says a new version exists unless the build is Developer ID signed (workflow sets auto)', () => {
    expect(resolveMode({ ...base, platform: 'darwin' })).toBe('notify')
    expect(resolveMode({ ...base, platform: 'darwin', configured: 'auto' })).toBe('auto')
  })
  it('off in development, when disabled, and on Linux outside the update test', () => {
    expect(resolveMode({ ...base, packaged: false })).toBe('off')
    expect(resolveMode({ ...base, disabled: true })).toBe('off')
    expect(resolveMode({ ...base, platform: 'linux' })).toBe('off')
    expect(resolveMode({ ...base, platform: 'linux', testHooks: true })).toBe('off')
    expect(resolveMode({ ...base, platform: 'linux', testHooks: true, appImage: true })).toBe('auto')
  })
  it('ignores an unknown configured mode', () => {
    expect(resolveMode({ ...base, configured: 'yes' })).toBe('auto')
    expect(resolveMode({ ...base, configured: 'off' })).toBe('off')
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
