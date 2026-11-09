import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PhonePadServer } from '../../src/main/phonepad/server'
import { lanAddresses } from '../../src/main/phonepad/network'
import { qrPath } from '../../src/main/phonepad/qr'
import type { DesktopMessage, PhonePadEvent, PhonePadStatus } from '@shared/phonepad'

const HTML = '<!doctype html><html><head><style>body{margin:0}</style></head><body><script>window.ok=1</script></body></html>'

let server: PhonePadServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

async function startServer(limits = {}) {
  const events: PhonePadEvent[] = []
  server = new PhonePadServer({ html: HTML, addresses: () => [{ host: '127.0.0.1', label: 'test' }], emit: (e) => events.push(e), allowLoopback: true, limits })
  const status = await server.start()
  if (status.state !== 'pairing') throw new Error(`not pairing: ${status.state}`)
  const token = status.url.split('#t=')[1]!
  return { events, status, token, origin: status.manualUrl }
}

type Phone = { ws: WebSocket; inbox: DesktopMessage[]; next: (type: string) => Promise<DesktopMessage>; closed: Promise<number> }
function connect(origin: string, originHeader = origin): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: originHeader } })
    const inbox: DesktopMessage[] = []
    const waiters: { type: string; resolve: (m: DesktopMessage) => void }[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as DesktopMessage
      const w = waiters.findIndex((x) => x.type === m.type)
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m)
      else inbox.push(m)
    })
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    const next = (type: string): Promise<DesktopMessage> => {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]!)
      return new Promise((r) => waiters.push({ type, resolve: r }))
    }
    ws.on('open', () => resolve({ ws, inbox, next, closed }))
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', reject)
  })
}
const send = (p: Phone, m: unknown): void => p.ws.send(JSON.stringify(m))
const hello = (p: Phone, token: string, client = 'phone-abc-123') => send(p, { type: 'hello', v: 2, token, client, device: 'Test · Browser' })
const ink = (stroke: string, seq: number, phase: string, points: number[][], extra = {}) => ({ type: 'ink', stroke, seq, phase, points, ...extra })
const down = (stroke: string, u = 0.1, v = 0.1) => ink(stroke, 0, 'down', [[u, v, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 800, 400], epoch: 0 })
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const inkEvents = (events: PhonePadEvent[]) => events.filter((e) => e.type === 'ink').map((e) => (e.type === 'ink' ? `${e.message.stroke}:${e.message.seq}:${e.message.phase}` : ''))

describe('PhonePad server', () => {
  it('serves the phone page with a strict CSP naming its own WebSocket', async () => {
    const { origin } = await startServer()
    const res = await fetch(origin + '/')
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
    expect(csp).toContain(`connect-src ${origin.replace('http', 'ws')}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(HTML)
    expect((await fetch(origin + '/../etc/passwd')).status).toBe(404)
    expect((await fetch(origin + '/', { method: 'POST' })).status).toBe(405)
  })

  it('pairing status carries a QR, a short code and the URL with the secret only in the fragment', async () => {
    const { status } = await startServer()
    if (status.state !== 'pairing') throw new Error()
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43}$/)
    expect(status.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(status.qr.size).toBeGreaterThanOrEqual(21)
    expect(status.qr.path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
  })

  it('refuses WebSockets from another origin', async () => {
    const { origin } = await startServer()
    await expect(connect(origin, 'http://evil.example')).rejects.toThrow('HTTP 403')
  })

  it('refuses a wrong token and anything before hello', async () => {
    const { origin } = await startServer()
    const a = await connect(origin)
    hello(a, 'x'.repeat(43))
    expect(await a.next('error')).toMatchObject({ code: 'bad-token' })
    expect(await a.closed).toBe(1008)
    const b = await connect(origin)
    send(b, down('stroke-0001'))
    expect(await b.closed).toBe(1008)
  })

  it('pairs with the QR secret or the short code, then refuses a second phone', async () => {
    const { origin, token, status, events } = await startServer()
    const a = await connect(origin)
    hello(a, token)
    expect(await a.next('welcome')).toMatchObject({ v: 2 })
    expect(server!.status()).toMatchObject({ state: 'connected', device: 'Test · Browser' })
    expect(events.some((e) => e.type === 'status' && e.status.state === 'connected')).toBe(true)

    const b = await connect(origin)
    hello(b, token, 'another-phone-99')
    expect(await b.next('error')).toMatchObject({ code: 'already-paired' })

    // Short code works too (fresh session).
    await server!.stop()
    const second = await startServer()
    const code = (second.status as Extract<PhonePadStatus, { state: 'pairing' }>).code.toLowerCase()
    const c = await connect(second.origin)
    hello(c, code)
    expect(await c.next('welcome')).toBeTruthy()
    void status
  })

  it('locks the code after repeated wrong guesses', async () => {
    const { origin, token } = await startServer({ maxPairingFailures: 3 })
    for (let i = 0; i < 3; i++) {
      const p = await connect(origin)
      hello(p, 'ZZZZ-ZZZZ')
      await p.next('error')
    }
    const p = await connect(origin)
    hello(p, token)
    expect(await p.next('error')).toMatchObject({ code: 'bad-token' })
  })

  it('forwards ink in order exactly once, acknowledges it, and drops resent duplicates', async () => {
    const { origin, token, events } = await startServer()
    const p = await connect(origin)
    hello(p, token)
    await p.next('welcome')
    send(p, down('stroke-0001'))
    send(p, ink('stroke-0001', 2, 'move', [[0.3, 0.3, 32]])) // arrives before seq 1
    send(p, ink('stroke-0001', 1, 'move', [[0.2, 0.2, 16]]))
    send(p, ink('stroke-0001', 1, 'move', [[0.2, 0.2, 16]])) // duplicate
    send(p, ink('stroke-0001', 3, 'up', [[0.4, 0.4, 48]]))
    send(p, ink('stroke-0001', 3, 'up', [[0.4, 0.4, 48]])) // duplicate after end
    await tick(80)
    expect(inkEvents(events)).toEqual(['stroke-0001:0:down', 'stroke-0001:1:move', 'stroke-0001:2:move', 'stroke-0001:3:up'])
    const acks = p.inbox.filter((m) => m.type === 'ack')
    expect(acks.at(-1)).toMatchObject({ id: 'stroke-0001' })
    expect((acks.at(-1) as { seq: number }).seq).toBeGreaterThanOrEqual(3)
  })

  it('drops invalid messages and closes a connection that keeps sending them', async () => {
    const { origin, token, events } = await startServer({ maxInvalidMessages: 3 })
    const p = await connect(origin)
    hello(p, token)
    await p.next('welcome')
    send(p, ink('stroke-0002', 0, 'down', [[2, 0.1, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 800, 400], epoch: 0 })) // u out of range
    send(p, { type: 'ink', stroke: 'bad id!', seq: 0, phase: 'down', points: [] })
    p.ws.send('not json')
    expect(inkEvents(events)).toEqual([])
    send(p, { type: 'command', id: 'x', action: 'format-disk' })
    expect(await p.closed).toBe(1008)
  })

  it('closes (instead of silently dropping) a connection that sends too fast, so the phone resends', async () => {
    const { origin, token } = await startServer({ maxMessagesPerSecond: 5 })
    const p = await connect(origin)
    hello(p, token)
    await p.next('welcome')
    for (let i = 0; i < 10; i++) send(p, { type: 'ping', at: i })
    expect(await p.closed).toBe(1013)
  })

  it('refuses a flood of sockets', async () => {
    const { origin } = await startServer()
    const socks = await Promise.allSettled(Array.from({ length: 20 }, () => connect(origin)))
    expect(socks.filter((r) => r.status === 'rejected').length).toBeGreaterThan(0)
    socks.forEach((r) => r.status === 'fulfilled' && r.value.ws.terminate())
  })

  it('forwards where the phone looks and its pen choice; never replays a goto on reconnect', async () => {
    const { origin, token, events } = await startServer()
    const a = await connect(origin)
    hello(a, token)
    await a.next('welcome')
    send(a, { type: 'viewport', rect: [-500, 120, 800, 370], epoch: 3 })
    send(a, { type: 'pen', color: '#16A34A', size: 6.5 })
    send(a, { type: 'pen', color: '#16a34a', size: 99 }) // out of range: dropped
    await tick(60)
    expect(events.filter((e) => e.type === 'viewport' || e.type === 'pen')).toEqual([
      { type: 'viewport', rect: [-500, 120, 800, 370], epoch: 3 },
      { type: 'pen', color: '#16a34a', size: 6.5 }
    ])
    server!.send({ type: 'goto', key: 'page-1', epoch: 0, rect: [0, 0, 800, 370] })
    expect(await a.next('goto')).toMatchObject({ key: 'page-1' })
    a.ws.terminate()
    await tick(50)
    const b = await connect(origin)
    hello(b, token)
    await b.next('welcome')
    await tick(60)
    expect(b.inbox.some((m) => m.type === 'goto')).toBe(false) // the phone keeps its own place
  })

  it('runs each command once even when resent, and acknowledges it', async () => {
    const { origin, token, events } = await startServer()
    const p = await connect(origin)
    hello(p, token)
    await p.next('welcome')
    send(p, { type: 'command', id: 'cmd-00000001', action: 'undo' })
    send(p, { type: 'command', id: 'cmd-00000001', action: 'undo' })
    await p.next('ack')
    await p.next('ack')
    expect(events.filter((e) => e.type === 'command')).toHaveLength(1)
  })

  it('lets the paired phone reconnect mid-stroke and finish it; replays the latest view', async () => {
    const { origin, token, events } = await startServer()
    const a = await connect(origin)
    hello(a, token)
    await a.next('welcome')
    server!.send({ type: 'status', ready: true, title: 'p', pen: { color: '#1f2430', size: 4 }, page: null })
    send(a, down('stroke-0003'))
    send(a, ink('stroke-0003', 1, 'move', [[0.2, 0.2, 16]]))
    await a.next('ack')
    a.ws.terminate()
    await tick(50)
    expect(server!.status().state).toBe('reconnecting')

    const b = await connect(origin)
    hello(b, token) // same client id
    await b.next('welcome')
    expect(await b.next('status')).toMatchObject({ ready: true })
    // The phone resends what wasn't acknowledged plus the rest.
    send(b, ink('stroke-0003', 1, 'move', [[0.2, 0.2, 16]]))
    send(b, ink('stroke-0003', 2, 'up', [[0.3, 0.3, 32]]))
    await tick(50)
    expect(inkEvents(events)).toEqual(['stroke-0003:0:down', 'stroke-0003:1:move', 'stroke-0003:2:up'])
    expect(server!.status().state).toBe('connected')
  })

  it('keeps a stroke the phone never finished, and ends the session when the phone stays away', async () => {
    const { origin, token, events } = await startServer({ orphanStrokeMs: 60, absentTimeoutMs: 150 })
    const a = await connect(origin)
    hello(a, token)
    await a.next('welcome')
    send(a, down('stroke-0004'))
    await a.next('ack')
    a.ws.terminate()
    await tick(120)
    expect(inkEvents(events)).toEqual(['stroke-0004:0:down', 'stroke-0004:1:up'])
    await tick(120)
    expect(server!.status().state).toBe('off')
  })

  it('a new socket from the same phone replaces the old one', async () => {
    const { origin, token } = await startServer()
    const a = await connect(origin)
    hello(a, token)
    await a.next('welcome')
    const b = await connect(origin)
    hello(b, token)
    await b.next('welcome')
    expect(await a.next('bye')).toMatchObject({ reason: 'replaced' })
  })

  it('stop() says goodbye and frees the port', async () => {
    const { origin, token } = await startServer()
    const a = await connect(origin)
    hello(a, token)
    await a.next('welcome')
    await server!.stop()
    expect(await a.next('bye')).toMatchObject({ reason: 'disconnected' })
    await expect(fetch(origin + '/')).rejects.toThrow()
    expect(server!.status()).toEqual({ state: 'off' })
  })

  it('reports a clear error when there is no local network', async () => {
    server = new PhonePadServer({ html: HTML, addresses: () => [], emit: () => undefined })
    expect(await server.start()).toMatchObject({ state: 'error' })
  })
})

describe('PhonePad network choice', () => {
  const iface = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null })
  it('prefers real Wi-Fi over virtual adapters and never offers public addresses', () => {
    const list = lanAddresses({
      lo: [iface('127.0.0.1', true)],
      'vEthernet (WSL)': [iface('172.24.160.1')],
      docker0: [iface('172.17.0.1')],
      'Wi-Fi': [iface('192.168.1.23')],
      Ethernet: [iface('10.0.0.5')],
      wan: [iface('8.8.8.8')],
      linklocal: [iface('169.254.3.4')]
    })
    expect(list.map((a) => a.host)).toEqual(['192.168.1.23', '10.0.0.5', '172.24.160.1', '172.17.0.1'])
    expect(list[0]!.label).toBe('Wi-Fi')
  })
  it('treats macOS en0 as the primary port', () => {
    expect(lanAddresses({ en5: [iface('10.1.1.1')], en0: [iface('10.2.2.2')] })[0]!.host).toBe('10.2.2.2')
  })
})

describe('PhonePad QR', () => {
  it('encodes a typical pairing URL in a small, scannable symbol', () => {
    const { size, path } = qrPath(`http://192.168.100.200:54321/#t=${'A'.repeat(43)}`)
    expect(size).toBeLessThanOrEqual(41) // version 6 or lower
    expect(path.length).toBeGreaterThan(100)
  })
})
