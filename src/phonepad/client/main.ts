/**
 * The phone's writing surface (served by the desktop, runs in the phone's browser).
 *
 * - Infinite paper: the phone has its own camera over the page. Two fingers
 *   pan and zoom it instantly; the phone draws the paper itself in every
 *   direction and lays the desktop's picture of the page over it. The desktop
 *   is told where the phone is looking, and grows the page when ink goes past
 *   its edge.
 * - Ink: pointer events (coalesced for accuracy) are normalized to (u, v) on
 *   the surface, batched once per animation frame and sent with a per-stroke
 *   sequence number and the page rectangle the surface showed at pen-down.
 * - Delivery: ink and commands stay in an outbox until the desktop
 *   acknowledges them, and are resent after a reconnect.
 * - Pen: colour and size are the computer's pen settings; the pen card changes them.
 * - Once a stylus has been used, single fingers pan, so a resting palm doesn't
 *   draw. Plain finger writing has no palm rejection (it can't tell a palm).
 */
import { Outbox } from './outbox'
import { deviceLabel, normalize, randomId, secondFingerCancels, type Finger, type SurfaceRect } from './gestures'
import { LINED_MARGIN, fromRect, paperLines, panBy, pinch, toScreen, viewRect, zoomAt, type PageRect, type Paper, type PhoneCamera } from './camera'

type Tool = 'pen' | 'eraser'
type Conn = 'connecting' | 'live' | 'lost' | 'ended'
type Pt = [number, number, number] | [number, number, number, number]

interface Stroke {
  id: string
  tool: Tool
  pointerId: number
  pointer: 'touch' | 'pen' | 'mouse'
  rect: SurfaceRect
  /** The page rectangle the surface showed at pen-down (kept current through content moves). */
  view: PageRect
  start: number
  seq: number
  /** Points not yet sent. */
  batch: Pt[]
  /** All points, for drawing locally. */
  points: Pt[]
  /** Line width in page units, and colour, at pen-down. */
  width: number
  color: string
  ended: boolean
  endedAt: number
}

const PROTOCOL = 2
const ERASER_RADIUS_PX = 14
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const app = $('app')
const surface = $('surface')
const canvas = $<HTMLCanvasElement>('ink')
const ctx = canvas.getContext('2d')!
const connText = $('conn-text')
const toastEl = $('toast')
const card = $('card')

/** Inkling's paper colour, and the grey outside a fixed-size (PDF) page. */
const PAPER_FILL = '#fdfcfa'
const OUTSIDE_FILL = '#e9ebef'
/** The computer's pen presets, and a palette of everyday ink colours (the first three are the computer's). */
const SIZE_PRESETS = [2.5, 4, 6.5] as const
const PALETTE: [string, string][] = [
  ['#1f2430', 'Black'],
  ['#2563eb', 'Blue'],
  ['#e5484d', 'Red'],
  ['#16a34a', 'Green'],
  ['#f59e0b', 'Orange'],
  ['#7c3aed', 'Purple'],
  ['#db2777', 'Pink'],
  ['#6b7280', 'Grey']
]

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
let penSize = 4
/** A pen change made here wins over the computer's echo of the previous value for a moment. */
let penLocalUntil = 0

interface PageInfo {
  key: string
  width: number
  height: number
  paper: Paper
  growable: boolean
  epoch: number
  origin: [number, number]
}
let page: PageInfo | null = null
let cam: PhoneCamera | null = null
let camSentAt = 0
let camDirty = false

let picture: { img: HTMLImageElement; rect: PageRect; key: string } | null = null
const strokes: Stroke[] = []
let active: Stroke | null = null
const touches = new Map<number, Finger>()
let nav: { mid: Finger; spread: number } | null = null
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
      onStatus(m)
      return
    case 'goto':
      onGoto(m)
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

function isRect(v: unknown): v is PageRect {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v[2] > 0 && v[3] > 0
}

function onStatus(m: Record<string, unknown>): void {
  pageReady = m.ready === true
  const pen = m.pen as { color?: unknown; size?: unknown } | undefined
  if (pen && performance.now() > penLocalUntil) {
    if (typeof pen.color === 'string' && /^#[0-9a-f]{6}$/i.test(pen.color)) penColor = pen.color.toLowerCase()
    if (typeof pen.size === 'number' && pen.size > 0 && pen.size <= 100) penSize = pen.size
    showPen()
  }
  const next = m.page as PageInfo | null
  if (next && typeof next.key === 'string' && Array.isArray(next.origin)) {
    if (page && page.key === next.key) {
      // The page grew left or up: its content moved, so move the camera and local ink with it.
      const dx = next.origin[0] - page.origin[0]
      const dy = next.origin[1] - page.origin[1]
      if (dx || dy) shiftContent(dx, dy)
    } else {
      // Another page: start fresh there (the computer sends where to look).
      picture = null
      strokes.length = 0
      cam = null
    }
    page = { ...next, paper: { ...next.paper } }
    if (!cam) cam = fromRect([0, 0, page.width, page.width / Math.max(0.2, surfaceAspect())], surfaceSize().w, surfaceSize().h)
  } else page = null
  if (!pageReady) showCard('Open a page on your computer', 'PhonePad writes on the handwritten page that’s open in Inkling. Notes and the library can’t take ink.')
  else if (!card.querySelector('#code-form:not([hidden])')) hideCard()
  dirty = true
}

function onGoto(m: Record<string, unknown>): void {
  if (!page || m.key !== page.key || !isRect(m.rect)) return
  const { w, h } = surfaceSize()
  cam = fromRect(m.rect, w, h)
  camDirty = true
  dirty = true
}

function shiftContent(dx: number, dy: number): void {
  if (cam) cam = { ...cam, x: cam.x + dx, y: cam.y + dy }
  if (picture) picture.rect = [picture.rect[0] + dx, picture.rect[1] + dy, picture.rect[2], picture.rect[3]]
  for (const s of strokes) s.view = [s.view[0] + dx, s.view[1] + dy, s.view[2], s.view[3]]
  dirty = true
}

function onView(m: Record<string, unknown>): void {
  if (typeof m.image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(m.image) || !isRect(m.rect)) return
  // A picture from before a content move (or of another page) would be misplaced.
  if (!page || m.key !== page.key || m.epoch !== page.epoch) return
  const rect = m.rect
  const key = page.key
  const img = new Image()
  img.onload = () => {
    if (!page || page.key !== key) return
    picture = { img, rect: [...rect] as PageRect, key }
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

function surfaceSize(): { w: number; h: number } {
  const r = surface.getBoundingClientRect()
  return { w: Math.max(1, r.width), h: Math.max(1, r.height) }
}
const surfaceAspect = (): number => surfaceSize().w / surfaceSize().h

let surfaceTimer = 0
function sendSurface(): void {
  const r = surface.getBoundingClientRect()
  if (r.width < 50 || r.height < 50) return
  send({ type: 'surface', aspect: r.width / r.height, width: Math.round(r.width), height: Math.round(r.height), dpr: Math.min(5, Math.max(0.5, devicePixelRatio || 1)) })
  camDirty = true
}

let lastSize: { w: number; h: number } | null = null

function resize(): void {
  const r = surface.getBoundingClientRect()
  // Rotating keeps the middle of what you were looking at in the middle, at the same zoom.
  if (cam && lastSize && (lastSize.w !== r.width || lastSize.h !== r.height)) {
    cam = { ...cam, x: cam.x + (lastSize.w - r.width) / 2 / cam.scale, y: cam.y + (lastSize.h - r.height) / 2 / cam.scale }
    camDirty = true
  }
  lastSize = { w: r.width, h: r.height }
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

/** Tells the computer where the phone is looking (at most ~8 times a second while moving). */
function sendViewport(now: number): void {
  if (!camDirty || !cam || !page || !welcomed || now - camSentAt < 120) return
  camDirty = false
  camSentAt = now
  const { w, h } = surfaceSize()
  send({ type: 'viewport', rect: viewRect(cam, w, h), epoch: page.epoch })
}

function moveCamera(next: PhoneCamera): void {
  cam = next
  camDirty = true
  dirty = true
}

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
  // A tap on the paper while the pen card is open only closes the card.
  if (!penCard.hidden) {
    closePenCard()
    return
  }
  if (!pageReady || conn === 'ended' || !cam || !page) return
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
      nav = twoFingers()
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
  const view = viewRect(cam, rect.width, rect.height)
  const s: Stroke = {
    id: randomId(),
    tool: t,
    pointerId: e.pointerId,
    pointer: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'mouse' ? 'mouse' : 'touch',
    rect,
    view,
    start: e.timeStamp,
    seq: 0,
    batch: [],
    points: [],
    width: t === 'eraser' ? (ERASER_RADIUS_PX * 2) / cam.scale : penSize,
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
    view,
    epoch: page.epoch,
    color: penColor,
    size: penSize,
    ...(t === 'eraser' ? { radius: ERASER_RADIUS_PX / rect.width } : {})
  })
  dirty = true
})

surface.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY])
  if (nav && touches.size >= 2) {
    const next = twoFingers()
    const r = surfaceRect()
    if (cam) moveCamera(pinch(cam, [nav.mid[0] - r.left, nav.mid[1] - r.top], [next.mid[0] - r.left, next.mid[1] - r.top], nav.spread, next.spread, r.width, r.height, page ?? undefined))
    nav = next
    return
  }
  if (panPointer?.id === e.pointerId) {
    const r = surfaceRect()
    if (cam) moveCamera(panBy(cam, e.clientX - panPointer.last[0], e.clientY - panPointer.last[1], r.width, r.height, page ?? undefined))
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

function twoFingers(): { mid: Finger; spread: number } {
  const [a, b] = [...touches.values()] as [Finger, Finger]
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], spread: Math.hypot(a[0] - b[0], a[1] - b[1]) }
}

// Mouse wheel and trackpads (a phone browser rarely has one; handy on a tablet with a keyboard).
surface.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (!cam || active) return
    const r = surfaceRect()
    if (e.ctrlKey) moveCamera(zoomAt(cam, Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top, r.width, r.height, page ?? undefined))
    else moveCamera(panBy(cam, -e.deltaX, -e.deltaY, r.width, r.height, page ?? undefined))
  },
  { passive: false }
)

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

// ---- Pen colour and size ------------------------------------------------------

const penCard = $('pen-card')
const swatch = $('swatch')
const sizeInput = $<HTMLInputElement>('size')
const colorsEl = $('colors')
const sizesEl = $('sizes')

for (const [color, name] of PALETTE) {
  const b = document.createElement('button')
  b.type = 'button'
  b.setAttribute('role', 'radio')
  b.setAttribute('aria-label', name)
  b.dataset.color = color
  const dot = document.createElement('span')
  dot.style.setProperty('--c', color)
  b.append(dot)
  // Picking a colour is the common quick change: it applies and closes the card.
  b.addEventListener('click', () => {
    setPen(color, penSize, true)
    closePenCard()
  })
  colorsEl.append(b)
}
for (const [i, size] of SIZE_PRESETS.entries()) {
  const b = document.createElement('button')
  b.type = 'button'
  b.setAttribute('role', 'radio')
  b.setAttribute('aria-label', ['Fine', 'Medium', 'Bold'][i]!)
  b.dataset.size = String(size)
  const dot = document.createElement('span')
  dot.style.width = dot.style.height = `${6 + i * 5}px`
  b.append(dot)
  b.addEventListener('click', () => {
    setPen(penColor, size, true)
    closePenCard()
  })
  sizesEl.append(b)
}
sizeInput.addEventListener('input', () => setPen(penColor, Number(sizeInput.value)))

let penSendTimer = 0
function sendPen(): void {
  clearTimeout(penSendTimer)
  penSendTimer = 0
  if (welcomed) send({ type: 'pen', color: penColor, size: penSize })
}
/** `now`: a single pick (colour, preset) goes at once; the slider sends at most every 100 ms. */
function setPen(color: string, size: number, now = false): void {
  penColor = color
  penSize = Math.min(16, Math.max(1, size))
  penLocalUntil = performance.now() + 800
  if (tool !== 'pen') setTool('pen')
  showPen()
  if (now) sendPen()
  else if (!penSendTimer) penSendTimer = window.setTimeout(sendPen, 100)
}

/** Reflects the pen in the dock, the card and the preview: colour, and size as it will look at this zoom. */
function showPen(): void {
  document.documentElement.style.setProperty('--nib', penColor)
  const onScreen = penSize * (cam?.scale ?? 1)
  // The swatch dot grows with the size (8–20 px, inside its 26 px well), so the choice is visible at a glance.
  swatch.style.setProperty('--dot', `${Math.round(8 + ((penSize - 1) / 15) * 12)}px`)
  penCard.style.setProperty('--preview-width', `${Math.max(1, Math.min(24, onScreen))}px`)
  sizeInput.value = String(penSize)
  for (const b of colorsEl.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.color === penColor))
  for (const b of sizesEl.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === penSize))
}

function openPenCard(): void {
  showPen()
  penCard.hidden = false
  swatch.setAttribute('aria-expanded', 'true')
}
function closePenCard(): void {
  penCard.hidden = true
  swatch.setAttribute('aria-expanded', 'false')
}
swatch.addEventListener('click', () => (penCard.hidden ? openPenCard() : closePenCard()))
document.addEventListener('keydown', (e) => e.key === 'Escape' && closePenCard())

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
  if (!cam || !page) {
    ctx.fillStyle = PAPER_FILL
    ctx.fillRect(0, 0, w, h)
    for (const s of strokes) drawStroke(s)
    return
  }
  const c = cam
  // Paper everywhere (growable pages); grey around a fixed-size PDF page.
  ctx.fillStyle = page.growable ? PAPER_FILL : OUTSIDE_FILL
  ctx.fillRect(0, 0, w, h)
  const [px, py] = toScreen(c, 0, 0)
  const pw = page.width * c.scale
  const ph = page.height * c.scale
  if (!page.growable) {
    ctx.fillStyle = PAPER_FILL
    ctx.fillRect(px, py, pw, ph)
  }
  drawPaper(c, w, h)
  if (picture) {
    const [x, y, rw, rh] = picture.rect
    const [sx, sy] = toScreen(c, x, y)
    ctx.drawImage(picture.img, sx, sy, rw * c.scale, rh * c.scale)
  }
  if (!page.growable) {
    ctx.strokeStyle = 'rgba(31, 36, 48, 0.18)'
    ctx.lineWidth = 1
    ctx.strokeRect(px - 0.5, py - 0.5, pw + 1, ph + 1)
  }
  for (const s of strokes) drawStroke(s)
}

/** The page's paper pattern across the screen, at the positions Inkling's own paper uses. */
function drawPaper(c: PhoneCamera, w: number, h: number): void {
  if (!page) return
  const paper = page.paper
  const s = paper.spacing * c.scale
  // Too dense to see: plain paper (also keeps zoomed-out panning fast).
  if (paper.type === 'blank' || s < 5) return
  const x0 = c.x
  const y0 = c.y
  const x1 = c.x + w / c.scale
  const y1 = c.y + h / c.scale
  // Off a fixed page there is no paper to draw.
  const clipX0 = page.growable ? x0 : Math.max(0, x0)
  const clipY0 = page.growable ? y0 : Math.max(0, y0)
  const clipX1 = page.growable ? x1 : Math.min(page.width, x1)
  const clipY1 = page.growable ? y1 : Math.min(page.height, y1)
  if (clipX1 <= clipX0 || clipY1 <= clipY0) return
  const line = Math.max(1 / (canvas.width / Math.max(1, canvas.clientWidth)), c.scale)
  const sx = (x: number): number => (x - c.x) * c.scale
  const sy = (y: number): number => (y - c.y) * c.scale
  ctx.fillStyle = paper.color
  if (paper.type === 'dotted') {
    const r = Math.max(0.6, 1.5 * c.scale)
    for (const x of paperLines(paper, clipX0, clipX1, 'x'))
      for (const y of paperLines(paper, clipY0, clipY1, 'y')) ctx.fillRect(sx(x) - r, sy(y) - r, 2 * r, 2 * r)
    return
  }
  for (const x of paperLines(paper, clipX0, clipX1, 'x')) ctx.fillRect(sx(x), sy(clipY0), line, (clipY1 - clipY0) * c.scale)
  for (const y of paperLines(paper, clipY0, clipY1, 'y')) ctx.fillRect(sx(clipX0), sy(y), (clipX1 - clipX0) * c.scale, line)
  if (paper.type === 'lined' && LINED_MARGIN >= clipX0 && LINED_MARGIN <= clipX1) {
    ctx.fillStyle = '#f3c6c6'
    ctx.fillRect(sx(LINED_MARGIN), sy(clipY0), line, (clipY1 - clipY0) * c.scale)
  }
}

function drawStroke(s: Stroke): void {
  const pts = s.points
  if (!pts.length || !cam) return
  const c = cam
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, s.width * c.scale)
  ctx.strokeStyle = s.tool === 'eraser' ? 'rgba(253, 252, 250, 0.92)' : s.color
  ctx.beginPath()
  // Points are (u, v) across the view the stroke began in; place them through the current camera.
  const [vx, vy, vw, vh] = s.view
  const x = (p: Pt): number => (vx + p[0] * vw - c.x) * c.scale
  const y = (p: Pt): number => (vy + p[1] * vh - c.y) * c.scale
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
  sendViewport(performance.now())
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
showPen()
resize()
if (token) connect()
else showCodeEntry('Connect to Inkling', 'In Inkling on your computer, choose Connect phone. Scan the QR code, or type the code shown under it.')
requestAnimationFrame(frame)
