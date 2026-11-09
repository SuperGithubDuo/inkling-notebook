/**
 * The phone's writing surface (served by the desktop, runs in the phone's browser).
 *
 * - Ink: pointer events (coalesced for accuracy) are normalized to (u, v) on
 *   the surface rect frozen at pen-down, batched once per animation frame and
 *   sent with a per-stroke sequence number.
 * - Delivery: ink and commands stay in an outbox until the desktop
 *   acknowledges them, and are resent after a reconnect.
 * - Display: the desktop sends a picture of the writing area; the phone draws
 *   its own strokes on top until a picture containing them arrives.
 * - Navigation: two fingers pan and zoom the area on the computer. Once a
 *   stylus has been used, single fingers pan too, so a resting palm doesn't
 *   draw. Plain finger writing has no palm rejection (it can't tell a palm).
 */
import { Outbox } from './outbox'
import { deviceLabel, normalize, randomId, secondFingerCancels, twoFingerDelta, type Finger, type SurfaceRect } from './gestures'

type Tool = 'pen' | 'eraser'
type Conn = 'connecting' | 'live' | 'lost' | 'ended'
type Pt = [number, number, number] | [number, number, number, number]

interface Stroke {
  id: string
  tool: Tool
  pointerId: number
  pointer: 'touch' | 'pen' | 'mouse'
  rect: SurfaceRect
  start: number
  seq: number
  /** Points not yet sent. */
  batch: Pt[]
  /** All points, for drawing locally. */
  points: Pt[]
  /** Width of the drawn line in CSS px, and colour, at pen-down. */
  width: number
  color: string
  ended: boolean
  endedAt: number
}

const PROTOCOL = 1
const ERASER_RADIUS_PX = 14
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const app = $('app')
const surface = $('surface')
const canvas = $<HTMLCanvasElement>('ink')
const ctx = canvas.getContext('2d')!
const connText = $('conn-text')
const toastEl = $('toast')
const card = $('card')

// ---- Identity ---------------------------------------------------------------

function session(key: string, make: () => string | null): string | null {
  try {
    const v = sessionStorage.getItem(key) ?? make()
    if (v) sessionStorage.setItem(key, v)
    return v
  } catch {
    return make()
  }
}
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
let token = fromHash ?? session('inkling.pp.token', () => null)
if (fromHash) {
  try {
    sessionStorage.setItem('inkling.pp.token', fromHash)
  } catch {
    /* private mode: kept in memory */
  }
  // Keep the secret out of the address bar, screenshots and shared links.
  history.replaceState(null, '', location.pathname)
}
const clientId = session('inkling.pp.client', () => randomId(20))!
const device = deviceLabel(navigator.userAgent, navigator.maxTouchPoints)

// ---- State ------------------------------------------------------------------

let tool: Tool = 'pen'
let conn: Conn = 'connecting'
let ws: WebSocket | null = null
let welcomed = false
let retry = 0
let retryTimer = 0
let lastPong = Date.now()
let rtt = 0
let ended = false
const outbox = new Outbox()

let pageReady = false
let penColor = '#1f2430'
let penWidth = 0.004 // fraction of area width
let highlighter = false

let view: { img: HTMLImageElement; rect: [number, number, number, number] } | null = null
const strokes: Stroke[] = []
let active: Stroke | null = null
const touches = new Map<number, Finger>()
let nav: { last: [Finger, Finger] } | null = null
let pendingNav: { du: number; dv: number; factor: number; u: number; v: number } | null = null
let stylusSeen = false
let panPointer: { id: number; last: Finger } | null = null
let dirty = true

// ---- Connection -------------------------------------------------------------

function setConn(next: Conn): void {
  if (conn === 'live' && next === 'lost') toast('Connection lost. Keep writing: it’s sent when the phone reconnects.', 4000)
  if (conn === 'lost' && next === 'live') toast('Reconnected')
  conn = next
  app.dataset.conn = next
  connText.textContent = next === 'live' ? (rtt ? `Connected · ${rtt} ms` : 'Connected') : next === 'lost' ? 'Reconnecting…' : next === 'ended' ? 'Disconnected' : 'Connecting…'
}

function connect(): void {
  if (ended || !token) return
  clearTimeout(retryTimer)
  welcomed = false
  const sock = new WebSocket(`ws://${location.host}/ws`)
  ws = sock
  sock.onopen = () => send({ type: 'hello', v: PROTOCOL, token, client: clientId, device }, sock)
  sock.onmessage = (e) => {
    let m: { type?: unknown } & Record<string, unknown>
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return
    }
    onMessage(m)
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    if (ended) return
    setConn(welcomed || conn === 'live' ? 'lost' : conn === 'ended' ? 'ended' : 'lost')
    // Quick at first (Wi-Fi blips), then every few seconds.
    const delay = Math.min(3000, 250 * 2 ** retry++)
    retryTimer = window.setTimeout(connect, delay)
  }
}

function send(m: object, sock = ws): boolean {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false
  sock.send(JSON.stringify(m))
  return true
}

/** Messages sent on the current connection (after a reconnect, the backlog is resent first). */
let sentOnSocket = new WeakSet<object>()
let syncing = false
const RESEND_PER_FRAME = 5

/** Ink and commands: queued until acknowledged, sent now if possible (in order, behind any backlog). */
function sendReliable(id: string, seq: number, m: object): void {
  outbox.push(id, seq, m)
  if (welcomed && !syncing && send(m)) sentOnSocket.add(m)
}

/** After a reconnect: resend unacknowledged messages a few per frame, under the computer's rate limit. */
function resendBacklog(): void {
  if (!syncing || !welcomed) return
  const batch = outbox.unsent(sentOnSocket, RESEND_PER_FRAME)
  for (const m of batch) {
    if (!send(m)) return
    sentOnSocket.add(m)
  }
  if (batch.length < RESEND_PER_FRAME) syncing = false
}

function onMessage(m: Record<string, unknown>): void {
  switch (m.type) {
    case 'welcome':
      welcomed = true
      retry = 0
      lastPong = Date.now()
      setConn('live')
      hideCard()
      sendSurface()
      sentOnSocket = new WeakSet()
      syncing = outbox.size > 0
      return
    case 'ack':
      outbox.ack(String(m.id), Number(m.seq))
      return
    case 'pong':
      lastPong = Date.now()
      rtt = Math.max(1, Math.round(Date.now() - Number(m.at)))
      if (conn === 'live') setConn('live')
      return
    case 'status':
      pageReady = m.page === 'ready'
      if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) penColor = m.color
      if (typeof m.width === 'number' && m.width > 0) penWidth = m.width
      highlighter = m.highlighter === true
      document.documentElement.style.setProperty('--nib', penColor)
      if (!pageReady) showCard('Open a page on your computer', 'PhonePad writes on the handwritten page that’s open in Inkling. Notes and the library can’t take ink.')
      else hideCard()
      dirty = true
      return
    case 'view':
      onView(m)
      return
    case 'error':
      onError(String(m.code), String(m.message ?? ''))
      return
    case 'bye':
      ended = true
      setConn('ended')
      ws?.close()
      if (m.reason === 'replaced') showCard('PhonePad is open in another tab', 'Only one tab can write at a time. Use the other tab, or reload this one to take over.')
      else showCard('Disconnected', 'PhonePad was turned off on your computer. To write again, choose Connect phone in Inkling and scan the new code.')
      return
  }
}

function onError(code: string, message: string): void {
  if (code === 'bad-token' || code === 'expired') {
    try {
      sessionStorage.removeItem('inkling.pp.token')
    } catch {
      /* ignore */
    }
    token = null
    ended = true
    setConn('ended')
    showCodeEntry(code === 'expired' ? 'That code has expired' : 'That code didn’t work', message)
    return
  }
  ended = true
  setConn('ended')
  showCard(code === 'already-paired' ? 'Another phone is connected' : 'Can’t connect', message)
}

function onView(m: Record<string, unknown>): void {
  const rect = m.rect
  if (typeof m.image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(m.image) || !Array.isArray(rect) || rect.length !== 4) return
  const img = new Image()
  img.onload = () => {
    view = { img, rect: rect.map(Number) as [number, number, number, number] }
    // Strokes now part of the picture no longer need drawing here.
    const done = new Set(Array.isArray(m.strokes) ? m.strokes.map(String) : [])
    for (let i = strokes.length - 1; i >= 0; i--) if (done.has(strokes[i]!.id)) strokes.splice(i, 1)
    dirty = true
  }
  img.src = m.image
}

// Liveness: a socket can die silently when Wi-Fi drops; notice within a few seconds.
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !welcomed) return
  if (Date.now() - lastPong > 6000) {
    ws.close()
    return
  }
  send({ type: 'ping', at: Date.now() })
}, 2000)

document.addEventListener('visibilitychange', () => {
  // Coming back from a locked screen: reconnect at once instead of waiting.
  if (document.visibilityState === 'visible' && !ended && (!ws || ws.readyState > WebSocket.OPEN)) {
    retry = 0
    connect()
  }
})

// ---- Surface size -----------------------------------------------------------

let surfaceTimer = 0
function sendSurface(): void {
  const r = surface.getBoundingClientRect()
  if (r.width < 50 || r.height < 50) return
  send({ type: 'surface', aspect: r.width / r.height, width: Math.round(r.width), height: Math.round(r.height), dpr: Math.min(5, Math.max(0.5, devicePixelRatio || 1)) })
}

function resize(): void {
  const r = surface.getBoundingClientRect()
  const dpr = Math.min(3, devicePixelRatio || 1)
  canvas.width = Math.round(r.width * dpr)
  canvas.height = Math.round(r.height * dpr)
  // Rotating mid-stroke would bend it: end the stroke where it is.
  if (active) endStroke(active, 'up')
  dirty = true
  clearTimeout(surfaceTimer)
  surfaceTimer = window.setTimeout(sendSurface, 120)
  updatePortraitHint()
}
window.addEventListener('resize', resize)
screen.orientation?.addEventListener?.('change', resize)

// ---- Input ------------------------------------------------------------------

function surfaceRect(): SurfaceRect {
  const r = surface.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function point(s: Stroke, e: PointerEvent): Pt {
  const [u, v] = normalize(s.rect, e.clientX, e.clientY)
  const t = Math.max(0, Math.round(e.timeStamp - s.start))
  return s.pointer === 'pen' && e.pressure > 0 ? [u, v, t, Math.round(e.pressure * 1000) / 1000] : [u, v, t]
}

surface.addEventListener('pointerdown', (e) => {
  if (!pageReady || conn === 'ended') return
  try {
    surface.setPointerCapture(e.pointerId)
  } catch {
    /* capture is a nicety: moves still arrive while over the surface */
  }
  if (e.pointerType === 'pen') stylusSeen = true
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, [e.clientX, e.clientY])
    if (touches.size === 2) {
      // A second finger: navigation. Drop a stroke that has barely started.
      if (active && active.pointer === 'touch') {
        if (secondFingerCancels(e.timeStamp - active.start, active.points.length)) endStroke(active, 'cancel')
        else return
      }
      panPointer = null
      const [a, b] = [...touches.values()]
      nav = { last: [a!, b!] }
      return
    }
    if (touches.size > 2 || nav) return
    // With a stylus in use, a finger moves the page instead of writing (palm rejection).
    if (stylusSeen) {
      panPointer = { id: e.pointerId, last: [e.clientX, e.clientY] }
      return
    }
  }
  if (active) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  // The stylus eraser end (or barrel button) erases.
  const t: Tool = e.pointerType === 'pen' && (e.buttons & 32) !== 0 ? 'eraser' : tool
  const rect = surfaceRect()
  const s: Stroke = {
    id: randomId(),
    tool: t,
    pointerId: e.pointerId,
    pointer: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'mouse' ? 'mouse' : 'touch',
    rect,
    start: e.timeStamp,
    seq: 0,
    batch: [],
    points: [],
    width: t === 'eraser' ? ERASER_RADIUS_PX * 2 : Math.max(1, penWidth * rect.width),
    color: penColor,
    ended: false,
    endedAt: 0
  }
  const p = point(s, e)
  s.points.push(p)
  active = s
  strokes.push(s)
  sendReliable(s.id, 0, {
    type: 'ink',
    stroke: s.id,
    seq: 0,
    phase: 'down',
    points: [p],
    tool: t,
    pointer: s.pointer,
    aspect: rect.width / rect.height,
    ...(t === 'eraser' ? { radius: ERASER_RADIUS_PX / rect.width } : {})
  })
  dirty = true
})

surface.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY])
  if (nav && touches.size >= 2) {
    const [a, b] = [...touches.values()]
    const now: [Finger, Finger] = [a!, b!]
    const d = twoFingerDelta(surfaceRect(), nav.last, now)
    nav.last = now
    queueNav(d)
    return
  }
  if (panPointer?.id === e.pointerId) {
    const r = surfaceRect()
    queueNav({ du: -(e.clientX - panPointer.last[0]) / r.width, dv: -(e.clientY - panPointer.last[1]) / r.height, factor: 1, u: 0.5, v: 0.5 })
    panPointer.last = [e.clientX, e.clientY]
    return
  }
  const s = active
  if (!s || s.pointerId !== e.pointerId) return
  const samples = e.getCoalescedEvents?.() ?? []
  for (const ev of samples.length ? samples : [e]) {
    const p = point(s, ev)
    const last = s.points[s.points.length - 1]!
    // Skip repeats of the same spot; they add bytes and nothing else.
    if (p[0] === last[0] && p[1] === last[1]) continue
    s.points.push(p)
    s.batch.push(p)
  }
  dirty = true
})

function lift(e: PointerEvent): void {
  if (e.pointerType === 'touch') touches.delete(e.pointerId)
  if (nav && touches.size < 2) nav = null
  if (panPointer?.id === e.pointerId) panPointer = null
  // A cancelled pointer (system gesture, rotation) keeps what was written.
  if (active && active.pointerId === e.pointerId) {
    if (e.type === 'pointerup') {
      const p = point(active, e)
      const last = active.points[active.points.length - 1]!
      if (p[0] !== last[0] || p[1] !== last[1]) {
        active.points.push(p)
        active.batch.push(p)
      }
    }
    endStroke(active, 'up')
  }
}
surface.addEventListener('pointerup', lift)
surface.addEventListener('pointercancel', lift)

function flushBatch(s: Stroke, phase: 'move' | 'up' | 'cancel'): void {
  if (phase === 'move' && !s.batch.length) return
  // Long batches (a slow frame) are split to stay under the message limit.
  do {
    const chunk = s.batch.splice(0, 400)
    const last = !s.batch.length
    const ph = last ? phase : 'move'
    if (ph === 'move' && !chunk.length) break
    s.seq++
    sendReliable(s.id, s.seq, { type: 'ink', stroke: s.id, seq: s.seq, phase: ph, points: ph === 'cancel' ? [] : chunk })
  } while (s.batch.length)
}

function endStroke(s: Stroke, phase: 'up' | 'cancel'): void {
  if (s.ended) return
  flushBatch(s, phase)
  s.ended = true
  s.endedAt = performance.now()
  if (active === s) active = null
  if (phase === 'cancel') strokes.splice(strokes.indexOf(s), 1)
  dirty = true
}

function queueNav(d: { du: number; dv: number; factor: number; u: number; v: number }): void {
  if (!pendingNav) pendingNav = { ...d }
  else {
    pendingNav.du += d.du
    pendingNav.dv += d.dv
    pendingNav.factor *= d.factor
    pendingNav.u = d.u
    pendingNav.v = d.v
  }
}

function flushNav(): void {
  const n = pendingNav
  pendingNav = null
  if (!n || !welcomed) return
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  if (Math.abs(n.factor - 1) > 0.002) send({ type: 'zoom', factor: clamp(n.factor, 0.2, 5), u: n.u, v: n.v })
  if (Math.abs(n.du) > 1e-4 || Math.abs(n.dv) > 1e-4) send({ type: 'pan', du: clamp(n.du, -4, 4), dv: clamp(n.dv, -4, 4) })
}

// iOS: no page zoom or callouts from gestures on the writing surface.
for (const type of ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu']) document.addEventListener(type, (e) => e.preventDefault())
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })

// ---- Toolbar ----------------------------------------------------------------

function setTool(t: Tool): void {
  tool = t
  app.dataset.tool = t
  $('tool-pen').setAttribute('aria-pressed', String(t === 'pen'))
  $('tool-eraser').setAttribute('aria-pressed', String(t === 'eraser'))
}
$('tool-pen').addEventListener('click', () => setTool('pen'))
$('tool-eraser').addEventListener('click', () => setTool('eraser'))

function command(action: 'undo' | 'redo' | 'clear'): void {
  const id = randomId()
  sendReliable(id, 0, { type: 'command', id, action })
}
$('undo').addEventListener('click', () => command('undo'))
$('redo').addEventListener('click', () => command('redo'))

// Clear asks once: the first tap arms it, a second tap within 3 s clears (undoable on the computer).
const clearBtn = $('clear')
let clearTimer = 0
clearBtn.addEventListener('click', () => {
  if (clearBtn.classList.contains('arm')) {
    clearBtn.classList.remove('arm')
    clearTimeout(clearTimer)
    command('clear')
    toast('Cleared. Undo brings it back.')
    return
  }
  clearBtn.classList.add('arm')
  clearTimer = window.setTimeout(() => clearBtn.classList.remove('arm'), 3000)
})

const fsBtn = $('fullscreen')
if (document.fullscreenEnabled) {
  fsBtn.hidden = false
  fsBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        // Landscape gives the most writing room; not every browser allows locking it.
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined)
      }
    } catch {
      /* not allowed here */
    }
  })
}

// ---- Messages on screen -----------------------------------------------------

let toastTimer = 0
function toast(text: string, ms = 2600): void {
  toastEl.textContent = text
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms)
}

let portraitHinted = false
function updatePortraitHint(): void {
  if (!portraitHinted && innerHeight > innerWidth * 1.15 && pageReady) {
    portraitHinted = true
    toast('Turn your phone sideways for more room to write.', 4000)
  }
}

function showCard(title: string, text: string): void {
  $('card-title').textContent = title
  $('card-text').textContent = text
  $('code-form').hidden = true
  card.hidden = false
}
function hideCard(): void {
  card.hidden = true
}
function showCodeEntry(title: string, text: string): void {
  showCard(title, text)
  $('code-form').hidden = false
}

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $<HTMLInputElement>('code')
  const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code.length !== 8) {
    input.focus()
    return
  }
  input.blur()
  token = code
  try {
    sessionStorage.setItem('inkling.pp.token', code)
  } catch {
    /* ignore */
  }
  ended = false
  retry = 0
  hideCard()
  setConn('connecting')
  connect()
})
$<HTMLInputElement>('code').addEventListener('input', (e) => {
  const el = e.currentTarget as HTMLInputElement
  const raw = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  el.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
})

// ---- Drawing ----------------------------------------------------------------

function render(): void {
  const dpr = canvas.width / Math.max(1, canvas.clientWidth)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (view) {
    const [u0, v0, u1, v1] = view.rect
    ctx.drawImage(view.img, u0 * w, v0 * h, (u1 - u0) * w, (v1 - v0) * h)
  }
  for (const s of strokes) drawStroke(s, w, h)
}

function drawStroke(s: Stroke, w: number, h: number): void {
  const pts = s.points
  if (!pts.length) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.width
  if (s.tool === 'eraser') {
    ctx.strokeStyle = 'rgba(253, 252, 250, 0.92)'
  } else {
    ctx.strokeStyle = s.color
    if (highlighter) ctx.globalAlpha = 0.45
  }
  ctx.beginPath()
  const x = (p: Pt): number => p[0] * w
  const y = (p: Pt): number => p[1] * h
  ctx.moveTo(x(pts[0]!), y(pts[0]!))
  if (pts.length === 1) ctx.lineTo(x(pts[0]!) + 0.01, y(pts[0]!))
  // Midpoint quadratic curves: smooth without lagging behind the finger.
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    ctx.quadraticCurveTo(x(a), y(a), (x(a) + x(b)) / 2, (y(a) + y(b)) / 2)
  }
  if (pts.length > 1) ctx.lineTo(x(pts[pts.length - 1]!), y(pts[pts.length - 1]!))
  ctx.stroke()
  if (s.tool === 'eraser' && !s.ended) {
    const p = pts[pts.length - 1]!
    ctx.beginPath()
    ctx.arc(x(p), y(p), ERASER_RADIUS_PX, 0, Math.PI * 2)
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(74, 80, 96, 0.6)'
    ctx.stroke()
  }
  ctx.restore()
}

function frame(): void {
  resendBacklog()
  if (active) flushBatch(active, 'move')
  flushNav()
  // A finished stroke whose picture never came back (e.g. desktop busy) fades out after a while.
  const now = performance.now()
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!
    if (s.ended && now - s.endedAt > 8000 && !outbox.has(s.id)) {
      strokes.splice(i, 1)
      dirty = true
    }
  }
  if (dirty) {
    dirty = false
    render()
  }
  requestAnimationFrame(frame)
}

// ---- Start ------------------------------------------------------------------

setTool('pen')
resize()
if (token) connect()
else showCodeEntry('Connect to Inkling', 'In Inkling on your computer, choose Connect phone. Scan the QR code, or type the code shown under it.')
requestAnimationFrame(frame)
