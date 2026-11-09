/**
 * PhonePad: a phone used as a wireless writing tablet for the open page.
 *
 * This file is the wire contract between the phone's web page and the desktop
 * app, plus the events the main process forwards to the renderer. The phone
 * talks only to the main process; the main process validates every message
 * with these schemas and forwards nothing but ink and a few commands.
 *
 * Coordinates on the wire are normalized: (u, v) in [0, 1] across the phone's
 * writing surface, whatever its pixel size. The desktop maps them onto a
 * rectangle of the page with the same aspect ratio, so ink never stretches.
 */
import { z } from 'zod'

export const PHONEPAD_PROTOCOL = 1

export const PHONEPAD_LIMITS = {
  /** Largest WebSocket message accepted from the phone (bytes). */
  maxMessageBytes: 256 * 1024,
  /** Points in one ink message (a frame's worth is usually 1–8). */
  maxPointsPerMessage: 512,
  /** Points kept for one stroke (matches the page schema's limit). */
  maxPointsPerStroke: 20000,
  /** Invalid messages tolerated on one connection before it is closed. */
  maxInvalidMessages: 20,
  /** Messages per second from one phone before it is throttled. */
  maxMessagesPerSecond: 400,
  /** An unused pairing code/QR is replaced after this long. */
  pairingTtlMs: 5 * 60_000,
  /** A paired phone that stays away this long ends the session. */
  absentTimeoutMs: 10 * 60_000,
  /** A stroke left unfinished by a vanished phone is kept after this long. */
  orphanStrokeMs: 15_000,
  /** Failed pairing attempts before the code is replaced. */
  maxPairingFailures: 8
} as const

const finite = z.number().finite()
const unit = finite.min(0).max(1)

/** Phone-generated ids: strokes, commands, the phone itself. */
export const phoneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,48}$/)

/** [u, v, t] or [u, v, t, pressure]: t is milliseconds since the stroke began. */
export const inkPointSchema = z.union([
  z.tuple([unit, unit, finite.min(0).max(3_600_000)]),
  z.tuple([unit, unit, finite.min(0).max(3_600_000), unit])
])

export const POINTER_KINDS = ['touch', 'pen', 'mouse'] as const
export const PHONE_TOOLS = ['pen', 'eraser'] as const

const inkSchema = z
  .object({
    type: z.literal('ink'),
    stroke: phoneIdSchema,
    /** Per-stroke sequence number, from 0 (the `down`). Used to drop duplicates after a resend. */
    seq: z.number().int().min(0).max(1_000_000),
    phase: z.enum(['down', 'move', 'up', 'cancel']),
    points: z.array(inkPointSchema).max(PHONEPAD_LIMITS.maxPointsPerMessage),
    /** Only on `down`: */
    tool: z.enum(PHONE_TOOLS).optional(),
    pointer: z.enum(POINTER_KINDS).optional(),
    /** Writing surface width ÷ height when the stroke began. */
    aspect: finite.min(0.15).max(8).optional(),
    /** Eraser radius as a fraction of the surface width. */
    radius: finite.min(0.001).max(0.5).optional()
  })
  .superRefine((m, ctx) => {
    if (m.phase === 'down' && (m.seq !== 0 || !m.tool || !m.pointer || m.aspect === undefined || !m.points.length)) {
      ctx.addIssue({ code: 'custom', message: 'down needs seq 0, tool, pointer, aspect and a point' })
    }
    if (m.phase === 'down' && m.tool === 'eraser' && m.radius === undefined) ctx.addIssue({ code: 'custom', message: 'eraser needs radius' })
    if (m.phase !== 'down' && m.seq === 0) ctx.addIssue({ code: 'custom', message: 'only down has seq 0' })
  })

export const phoneMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    v: z.literal(PHONEPAD_PROTOCOL),
    /** The secret from the QR code, or the short code typed by hand. */
    token: z.string().min(6).max(128),
    /** Random id the phone keeps for this tab; reconnecting with it resumes the session. */
    client: phoneIdSchema,
    /** A short, non-identifying description such as "iPhone · Safari". */
    device: z.string().max(60).optional()
  }),
  z.object({
    type: z.literal('surface'),
    aspect: finite.min(0.15).max(8),
    /** CSS pixels of the writing surface, for the preview image's resolution. */
    width: finite.min(50).max(8000),
    height: finite.min(50).max(8000),
    dpr: finite.min(0.5).max(5)
  }),
  inkSchema,
  z.object({ type: z.literal('command'), id: phoneIdSchema, action: z.enum(['undo', 'redo', 'clear']) }),
  /** Two-finger gestures move the writing area: pan by (du, dv) of the area, zoom by `factor` around (u, v). */
  z.object({ type: z.literal('pan'), du: finite.min(-4).max(4), dv: finite.min(-4).max(4) }),
  z.object({ type: z.literal('zoom'), factor: finite.min(0.2).max(5), u: unit, v: unit }),
  z.object({ type: z.literal('ping'), at: finite })
])

export type PhoneMessage = z.infer<typeof phoneMessageSchema>
export type InkMessage = Extract<PhoneMessage, { type: 'ink' }>
export type InkPoint = z.infer<typeof inkPointSchema>
export type PhoneCommand = Extract<PhoneMessage, { type: 'command' }>['action']

/** Messages from the desktop to the phone. The phone treats them as data only. */
export type DesktopMessage =
  | { type: 'welcome'; v: typeof PHONEPAD_PROTOCOL }
  | { type: 'error'; code: PhonePadErrorCode; message: string }
  /** What the phone writes onto right now. */
  | { type: 'status'; page: 'ready' | 'none'; title: string; color: string; highlighter: boolean; /** Pen width as a fraction of the area's width. */ width: number }
  /** Everything up to and including `seq` of stroke `id` has arrived (commands: `id` is the command id, `seq` 0). */
  | { type: 'ack'; id: string; seq: number }
  /** A picture of the writing area. `rect` is where the picture sits, in area coordinates. `strokes` lists phone strokes it already contains. */
  | { type: 'view'; rev: number; image: string; rect: [number, number, number, number]; strokes: string[] }
  | { type: 'pong'; at: number }
  | { type: 'bye'; reason: 'disconnected' | 'replaced' | 'expired' | 'quit' }

export type PhonePadErrorCode = 'bad-token' | 'already-paired' | 'expired' | 'version' | 'invalid'

// ---- Main ⇄ renderer --------------------------------------------------------

export interface PhonePadAddress {
  /** The interface address, e.g. 192.168.1.23. */
  host: string
  /** Interface name, for telling Wi-Fi from Ethernet when there are several. */
  label: string
}

export type PhonePadStatus =
  | { state: 'off' }
  | { state: 'error'; message: string }
  | {
      state: 'pairing'
      url: string
      /** The QR code as an SVG path in a `size`×`size` module grid (no quiet zone). */
      qr: { size: number; path: string }
      /** For typing in by hand: the short code and the address without it. */
      code: string
      manualUrl: string
      addresses: PhonePadAddress[]
      host: string
      expiresAt: number
    }
  | { state: 'connected' | 'reconnecting'; device: string; host: string; since: number }

/** What the renderer is told about the phone, already validated and de-duplicated. */
export type PhonePadEvent =
  | { type: 'status'; status: PhonePadStatus }
  | { type: 'surface'; aspect: number; width: number; height: number; dpr: number }
  | { type: 'ink'; message: InkMessage }
  | { type: 'command'; action: PhoneCommand }
  | { type: 'pan'; du: number; dv: number }
  | { type: 'zoom'; factor: number; u: number; v: number }

/** What the renderer sends the phone. */
export type PhonePadOutgoing = Extract<DesktopMessage, { type: 'status' } | { type: 'view' }>

export const phonePadOutgoingSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    page: z.enum(['ready', 'none']),
    title: z.string().max(200),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    highlighter: z.boolean(),
    width: finite.min(0).max(1)
  }),
  z.object({
    type: z.literal('view'),
    rev: z.number().int().min(0),
    image: z.string().max(4_000_000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/),
    rect: z.tuple([finite, finite, finite, finite]),
    strokes: z.array(phoneIdSchema).max(500)
  })
])

// ---- Ordering ---------------------------------------------------------------

/**
 * Puts each stroke's messages in order exactly once. After a reconnect the
 * phone resends everything not yet acknowledged, so duplicates are normal;
 * a gap (a later message before an earlier one) is held until it fills.
 */
export class StrokeSequencer {
  private next = new Map<string, number>()
  private held = new Map<string, Map<number, InkMessage>>()
  private finished = new Set<string>()
  private finishedOrder: string[] = []

  constructor(private readonly memory = 1024) {}

  /** Returns the messages that can be applied now, in order (possibly none). */
  accept(m: InkMessage): InkMessage[] {
    if (this.finished.has(m.stroke)) return []
    const expected = this.next.get(m.stroke) ?? 0
    if (m.seq < expected) return []
    if (m.seq > expected) {
      const held = this.held.get(m.stroke) ?? new Map<number, InkMessage>()
      if (held.size < 256) held.set(m.seq, m)
      this.held.set(m.stroke, held)
      return []
    }
    const out: InkMessage[] = [m]
    let seq = m.seq + 1
    const held = this.held.get(m.stroke)
    while (held?.has(seq)) {
      out.push(held.get(seq)!)
      held.delete(seq)
      seq++
    }
    this.next.set(m.stroke, seq)
    if (out.some((o) => o.phase === 'up' || o.phase === 'cancel')) this.finish(m.stroke)
    return out
  }

  /** Highest sequence number applied for a stroke, or -1. */
  acked(stroke: string): number {
    if (this.finished.has(stroke)) return Number.MAX_SAFE_INTEGER
    return (this.next.get(stroke) ?? 0) - 1
  }

  isFinished(stroke: string): boolean {
    return this.finished.has(stroke)
  }

  /** Strokes that started but have not ended. */
  open(): string[] {
    return [...this.next.keys()]
  }

  /** Marks a stroke done (ended, cancelled or abandoned); later messages for it are ignored. */
  finish(stroke: string): void {
    this.next.delete(stroke)
    this.held.delete(stroke)
    if (this.finished.has(stroke)) return
    this.finished.add(stroke)
    this.finishedOrder.push(stroke)
    while (this.finishedOrder.length > this.memory) this.finished.delete(this.finishedOrder.shift()!)
  }
}

/** Short pairing codes avoid look-alike characters (no 0/O, 1/I/L). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8

/** "ABCD-EFGH" → "ABCDEFGH"; anything else → null. */
export function normalizePairingCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length !== PAIRING_CODE_LENGTH) return null
  for (const ch of clean) if (!PAIRING_ALPHABET.includes(ch)) return null
  return clean
}

/** True for addresses a phone on the same home or office network would have. */
export function isPrivateAddress(address: string): boolean {
  const a = address.startsWith('::ffff:') ? address.slice(7) : address
  if (a === '127.0.0.1' || a === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])]
    return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254) || o1 === 127
  }
  const lower = a.toLowerCase()
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower)
}
