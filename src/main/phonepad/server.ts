/**
 * The PhonePad session: a small HTTP + WebSocket server on the local network.
 *
 * - Serves one static page (the phone's writing surface) and one WebSocket.
 * - Listens only on a private LAN address the user picked (never 0.0.0.0),
 *   and refuses clients that aren't on a private network.
 * - Pairing needs the secret from the QR code (256 bits, in the URL fragment
 *   so it never appears in a request line) or the short code shown on screen.
 *   The first phone to pair owns the session; others are refused. The paired
 *   phone may reconnect (Wi-Fi blips, screen lock) with its own random id.
 * - Every message is size-limited, rate-limited and validated. Only ink,
 *   undo/redo/clear and view gestures are forwarded; the phone can't reach
 *   IPC, files or anything else in Inkling.
 * - Nothing secret is logged.
 *
 * The transport (WebSocket) is kept apart from the session logic in the
 * renderer, so another transport (e.g. Bluetooth) could feed the same events.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PHONEPAD_LIMITS,
  PHONEPAD_PROTOCOL,
  StrokeSequencer,
  isPrivateAddress,
  normalizePairingCode,
  phoneMessageSchema,
  type DesktopMessage,
  type InkMessage,
  type PhonePadAddress,
  type PhonePadErrorCode,
  type PhonePadEvent,
  type PhonePadOutgoing,
  type PhonePadStatus
} from '@shared/phonepad'
import { qrPath } from './qr'

export interface PhonePadServerOptions {
  /** The phone page: one HTML file with one inline <script> and one inline <style>. */
  html: string
  /** Addresses the phone could use, best first. */
  addresses: () => PhonePadAddress[]
  emit: (event: PhonePadEvent) => void
  /** Overridable for tests. */
  limits?: Partial<typeof PHONEPAD_LIMITS>
  /** Tests run on loopback; real sessions never listen there. */
  allowLoopback?: boolean
  now?: () => number
}

interface Pairing {
  token: string
  code: string
  expiresAt: number
  failures: number
}

interface Client {
  id: string
  device: string
  socket: WebSocket | null
  since: number
}

const HELLO_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = 15_000
const MAX_SOCKETS = 16

export class PhonePadServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private host = ''
  private port = 0
  private pairing: Pairing | null = null
  private client: Client | null = null
  private sequencer = new StrokeSequencer()
  private commandsSeen = new Set<string>()
  private commandOrder: string[] = []
  /** Replayed to a phone that (re)connects: the page status and the latest picture. */
  private lastOutgoing: { status?: PhonePadOutgoing; view?: PhonePadOutgoing } = {}
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private pairingTimer: ReturnType<typeof setTimeout> | null = null
  private absentTimer: ReturnType<typeof setTimeout> | null = null
  private orphanTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private current: PhonePadStatus = { state: 'off' }
  private readonly limits: typeof PHONEPAD_LIMITS
  private readonly now: () => number
  private readonly csp: string

  constructor(private readonly options: PhonePadServerOptions) {
    this.limits = { ...PHONEPAD_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    const hash = (tag: string): string => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(options.html)
      if (!m) throw new Error(`PhonePad page needs one inline <${tag}>`)
      return `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`
    }
    // connect-src is filled in per request (it names this server's own address).
    this.csp = `default-src 'none'; script-src ${hash('script')}; style-src ${hash('style')}; img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  }

  status(): PhonePadStatus {
    return this.current
  }

  /** Starts (or restarts on another address) and shows a fresh pairing code. */
  async start(preferredHost?: string): Promise<PhonePadStatus> {
    const addresses = this.options.addresses()
    const host = addresses.find((a) => a.host === preferredHost)?.host ?? addresses[0]?.host
    if (!host) {
      await this.stop('disconnected')
      return this.setStatus({
        state: 'error',
        message: 'This computer isn’t connected to a local network. Connect it to the same Wi-Fi as your phone, then try again.'
      })
    }
    if (this.http && this.host === host && this.client) return this.current
    await this.stop('disconnected')
    try {
      await this.listen(host)
    } catch (err) {
      await this.stop('disconnected')
      const code = (err as NodeJS.ErrnoException).code
      return this.setStatus({
        state: 'error',
        message: code === 'EADDRNOTAVAIL' ? 'That network is no longer available. Try again.' : 'PhonePad couldn’t start its local connection. Try again.'
      })
    }
    this.newPairing()
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS)
    return this.current
  }

  /** Ends the session: tells the phone, closes every socket and the server. */
  async stop(reason: Extract<DesktopMessage, { type: 'bye' }>['reason'] = 'disconnected'): Promise<void> {
    const sock = this.client?.socket
    if (sock && sock.readyState === sock.OPEN) {
      this.sendTo(sock, { type: 'bye', reason })
      sock.close(1000, 'bye')
    }
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const t of [this.pairingTimer, this.absentTimer, this.orphanTimer]) if (t) clearTimeout(t)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.pairingTimer = this.absentTimer = this.orphanTimer = null
    this.heartbeat = null
    // Strokes left half-finished keep what was written.
    this.abandonOpenStrokes()
    this.wss?.clients.forEach((c) => c.terminate())
    this.wss?.close()
    const http = this.http
    this.http = null
    this.wss = null
    this.pairing = null
    this.client = null
    this.sequencer = new StrokeSequencer()
    this.lastOutgoing = {}
    if (http) {
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
    if (this.current.state !== 'off') this.setStatus({ state: 'off' })
  }

  /** From the renderer: page status or a picture of the writing area. */
  send(message: PhonePadOutgoing): void {
    if (message.type === 'status' || message.type === 'view') this.lastOutgoing[message.type] = message
    const sock = this.client?.socket
    if (sock && sock.readyState === sock.OPEN) this.sendTo(sock, message)
  }

  // ---- HTTP ------------------------------------------------------------------

  private listen(host: string): Promise<void> {
    const http = createServer((req, res) => this.serve(req, res))
    http.headersTimeout = 10_000
    http.requestTimeout = 15_000
    // Before anything reaches HTTP or WebSocket handling, drop clients outside the local network.
    let open = 0
    http.on('connection', (socket) => {
      // One phone needs one or two sockets; a flood of them is refused.
      if (!this.allowedRemote(socket.remoteAddress) || open >= MAX_SOCKETS) return void socket.destroy()
      open++
      socket.once('close', () => open--)
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxMessageBytes, perMessageDeflate: false })
    http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    wss.on('connection', (ws, req) => this.onSocket(ws, req))
    this.http = http
    this.wss = wss
    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen({ host, port: 0, exclusive: true }, () => {
        http.off('error', reject)
        http.on('error', () => undefined)
        this.host = host
        this.port = (http.address() as { port: number }).port
        resolve()
      })
    })
  }

  private origin(): string {
    return `http://${this.host}:${this.port}`
  }

  private allowedRemote(address: string | undefined): boolean {
    if (!address) return false
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    if (loopback) return !!this.options.allowLoopback || this.host === '127.0.0.1'
    return isPrivateAddress(address)
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY'
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers).end()
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/' || path === '/index.html') {
      const ws = `ws://${this.host}:${this.port}`
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `${this.csp}; connect-src ${ws}`
      })
      res.end(req.method === 'HEAD' ? undefined : this.options.html)
      return
    }
    if (path === '/favicon.ico') {
      res.writeHead(204, headers).end()
      return
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found')
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (code: number): void => {
      socket.end(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
    }
    if ((req.url ?? '').split('?')[0] !== '/ws') return refuse(404)
    // Only our own page may connect: blocks other websites open on the phone or the LAN.
    if (req.headers.origin !== this.origin()) return refuse(403)
    if (!this.allowedRemote(req.socket.remoteAddress)) return refuse(403)
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.wss?.emit('connection', ws, req))
  }

  // ---- WebSocket -------------------------------------------------------------

  private onSocket(ws: WebSocket, _req: IncomingMessage): void {
    let authed = false
    let invalid = 0
    let windowStart = this.now()
    let windowCount = 0
    let alive = true
    ;(ws as WebSocket & { inklingAlive?: () => boolean }).inklingAlive = () => alive
    ws.on('pong', () => (alive = true))
    ;(ws as WebSocket & { markDead?: () => void }).markDead = () => (alive = false)

    const helloTimer = this.timer(() => {
      if (!authed) ws.close(1008, 'no hello')
    }, HELLO_TIMEOUT_MS)

    const bad = (): void => {
      invalid++
      if (invalid > this.limits.maxInvalidMessages) ws.close(1008, 'invalid')
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      alive = true
      const t = this.now()
      if (t - windowStart >= 1000) {
        windowStart = t
        windowCount = 0
      }
      // Too fast: close rather than drop (a dropped ink message would leave a gap). The phone
      // reconnects and resends everything unacknowledged, so nothing is lost.
      if (++windowCount > this.limits.maxMessagesPerSecond) return void ws.close(1013, 'too fast')
      if (isBinary) return bad()
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return bad()
      }
      const result = phoneMessageSchema.safeParse(parsed)
      if (!result.success) return bad()
      const msg = result.data

      if (!authed) {
        if (msg.type !== 'hello') return void ws.close(1008, 'hello first')
        clearTimeout(helloTimer)
        this.timers.delete(helloTimer)
        const outcome = this.authenticate(msg.token, msg.client)
        if (outcome !== 'ok') {
          this.sendTo(ws, { type: 'error', code: outcome, message: ERROR_TEXT[outcome] })
          ws.close(1008, outcome)
          return
        }
        authed = true
        this.attach(ws, msg.client, sanitizeDevice(msg.device))
        return
      }
      // Only the session's current socket may act.
      if (this.client?.socket !== ws) return void ws.close(1008, 'replaced')
      this.handle(ws, msg)
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      this.timers.delete(helloTimer)
      if (this.client?.socket === ws) this.detach()
    })
    ws.on('error', () => undefined)
  }

  private authenticate(token: string, clientId: string): 'ok' | PhonePadErrorCode {
    const p = this.pairing
    if (!p) return 'expired'
    const tokenOk = safeEqual(token, p.token) || (normalizePairingCode(token) !== null && safeEqual(normalizePairingCode(token)!, p.code))
    if (this.client) {
      // Already paired: only the same phone (same tab id) may come back.
      if (!tokenOk || !safeEqual(clientId, this.client.id)) return tokenOk ? 'already-paired' : 'bad-token'
      return 'ok'
    }
    if (this.now() > p.expiresAt) return 'expired'
    if (!tokenOk) {
      if (++p.failures >= this.limits.maxPairingFailures) this.newPairing()
      return 'bad-token'
    }
    return 'ok'
  }

  private attach(ws: WebSocket, clientId: string, device: string): void {
    const previous = this.client?.socket
    if (previous && previous !== ws && previous.readyState === previous.OPEN) {
      this.sendTo(previous, { type: 'bye', reason: 'replaced' })
      previous.close(1000, 'replaced')
    }
    if (!this.client) {
      this.client = { id: clientId, device, socket: ws, since: this.now() }
      // Paired: the QR can't be used by anyone else, so stop refreshing it.
      if (this.pairingTimer) clearTimeout(this.pairingTimer)
      this.pairingTimer = null
    } else {
      this.client.socket = ws
      if (device) this.client.device = device
    }
    if (this.absentTimer) clearTimeout(this.absentTimer)
    if (this.orphanTimer) clearTimeout(this.orphanTimer)
    this.absentTimer = this.orphanTimer = null
    this.sendTo(ws, { type: 'welcome', v: PHONEPAD_PROTOCOL })
    if (this.lastOutgoing.status) this.sendTo(ws, this.lastOutgoing.status)
    if (this.lastOutgoing.view) this.sendTo(ws, this.lastOutgoing.view)
    this.setStatus({ state: 'connected', device: this.client.device, host: this.host, since: this.client.since })
  }

  private detach(): void {
    if (!this.client) return
    this.client.socket = null
    this.setStatus({ state: 'reconnecting', device: this.client.device, host: this.host, since: this.client.since })
    // A stroke cut off mid-way is kept if the phone doesn't come back to finish it.
    this.orphanTimer = this.timer(() => this.abandonOpenStrokes(), this.limits.orphanStrokeMs)
    this.absentTimer = this.timer(() => void this.stop('expired'), this.limits.absentTimeoutMs)
  }

  private handle(ws: WebSocket, msg: ReturnType<typeof phoneMessageSchema.parse>): void {
    switch (msg.type) {
      case 'hello':
        return
      case 'ping':
        return this.sendTo(ws, { type: 'pong', at: msg.at })
      case 'surface':
        return this.options.emit({ type: 'surface', aspect: msg.aspect, width: msg.width, height: msg.height, dpr: msg.dpr })
      case 'viewport':
        return this.options.emit({ type: 'viewport', rect: msg.rect, epoch: msg.epoch })
      case 'pen':
        return this.options.emit({ type: 'pen', color: msg.color.toLowerCase(), size: msg.size })
      case 'command': {
        if (!this.commandsSeen.has(msg.id)) {
          this.commandsSeen.add(msg.id)
          this.commandOrder.push(msg.id)
          while (this.commandOrder.length > 256) this.commandsSeen.delete(this.commandOrder.shift()!)
          this.options.emit({ type: 'command', action: msg.action })
        }
        return this.sendTo(ws, { type: 'ack', id: msg.id, seq: 0 })
      }
      case 'ink': {
        for (const m of this.sequencer.accept(msg)) this.options.emit({ type: 'ink', message: m })
        const acked = this.sequencer.acked(msg.stroke)
        if (acked >= 0) this.sendTo(ws, { type: 'ack', id: msg.stroke, seq: Math.min(acked, 1_000_000) })
        return
      }
    }
  }

  private abandonOpenStrokes(): void {
    for (const stroke of this.sequencer.open()) {
      const seq = this.sequencer.acked(stroke) + 1
      const end: InkMessage = { type: 'ink', stroke, seq, phase: 'up', points: [] }
      for (const m of this.sequencer.accept(end)) this.options.emit({ type: 'ink', message: m })
    }
  }

  private checkAlive(): void {
    const ws = this.client?.socket as (WebSocket & { inklingAlive?: () => boolean; markDead?: () => void }) | null | undefined
    if (!ws) return
    // No traffic or pong since the last check: the phone went away without closing (Wi-Fi drop).
    if (!ws.inklingAlive?.()) {
      ws.terminate()
      return
    }
    ws.markDead?.()
    ws.ping()
  }

  // ---- Pairing ---------------------------------------------------------------

  private newPairing(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    let code = ''
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
    this.pairing = { token: randomBytes(32).toString('base64url'), code, expiresAt: this.now() + this.limits.pairingTtlMs, failures: 0 }
    // An unused code is replaced before it expires, so the QR on screen always works.
    this.pairingTimer = setTimeout(() => {
      if (!this.client && this.http) this.newPairing()
    }, this.limits.pairingTtlMs - 1000)
    if (!this.client) this.publishPairing()
  }

  private publishPairing(): void {
    const p = this.pairing!
    const url = `${this.origin()}/#t=${p.token}`
    this.setStatus({
      state: 'pairing',
      url,
      qr: qrPath(url),
      code: `${p.code.slice(0, 4)}-${p.code.slice(4)}`,
      manualUrl: this.origin(),
      addresses: this.options.addresses(),
      host: this.host,
      expiresAt: p.expiresAt
    })
  }

  // ---- Helpers ---------------------------------------------------------------

  private setStatus(status: PhonePadStatus): PhonePadStatus {
    this.current = status
    this.options.emit({ type: 'status', status })
    return status
  }

  private sendTo(ws: WebSocket, message: DesktopMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
  }

  private timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
    return t
  }
}

const ERROR_TEXT: Record<PhonePadErrorCode, string> = {
  'bad-token': 'That code isn’t right. Scan the QR code on your computer again.',
  'already-paired': 'Another phone is already connected. Disconnect it on your computer first.',
  expired: 'This code has expired. Scan the new QR code on your computer.',
  version: 'Reload this page to update PhonePad.',
  invalid: 'Something went wrong. Reload this page.'
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function sanitizeDevice(device: string | undefined): string {
  const clean = (device ?? '').replace(/[^\p{L}\p{N} ·.,()_-]/gu, '').trim().slice(0, 40)
  return clean || 'Phone'
}
