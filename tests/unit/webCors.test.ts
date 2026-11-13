/** The AI server answers browsers only from the Inkling web app's own origin. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadServer, startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'

const APP = 'https://inkling.example'
const INSTALL = 'inst_abcdefghijklmnopqrstuvwxyz012345'
let server: BetaServer

beforeAll(async () => {
  server = await startBetaServer({ allowedOrigins: [APP] })
})
afterAll(() => server.close())

const call = (path: string, init: RequestInit & { origin?: string } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'x-inkling-install': INSTALL, 'x-inkling-notice': '99', ...(init.origin ? { origin: init.origin } : {}), ...(init.headers ?? {}) } })

describe('web app access to the AI server', () => {
  it('answers the web app’s preflight and adds CORS headers to its requests', async () => {
    const pre = await call('/v1/tutor', { method: 'OPTIONS', origin: APP })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(APP)
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-inkling-install')
    const status = await call('/v1/status', { origin: APP })
    expect(status.status).toBe(200)
    expect(status.headers.get('access-control-allow-origin')).toBe(APP)
    expect(status.headers.get('access-control-allow-credentials')).toBeNull()
    expect(((await status.json()) as { quota?: unknown }).quota).toBeTruthy()
  })

  it('gives other sites no CORS headers, so their browsers refuse the call', async () => {
    const pre = await call('/v1/tutor', { method: 'OPTIONS', origin: 'https://evil.example' })
    expect(pre.status).toBe(405)
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('/v1/status', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('/v1/status', { origin: `${APP}.evil.example` })).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never opens the admin API to browsers, and leaves desktop apps (no Origin) as before', async () => {
    const admin = await call('/admin/summary', { origin: APP })
    expect(admin.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('/admin/summary', { method: 'OPTIONS', origin: APP })).headers.get('access-control-allow-origin')).toBeNull()
    const desktop = await call('/v1/status')
    expect(desktop.status).toBe(200)
    expect(desktop.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('accepts only exact https origins in WEB_ORIGINS', async () => {
    const { config } = await loadServer()
    expect(config.webOrigins('https://a.example, http://localhost:5174 ,*, https://b.example/path, http://c.example,null')).toEqual(['https://a.example', 'http://localhost:5174'])
    expect(config.webOrigins(undefined)).toEqual([])
  })
})
