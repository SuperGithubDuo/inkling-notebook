/**
 * Pure helpers for the phone's writing surface: normalized coordinates and
 * two-finger navigation. Unit-tested.
 */
export interface SurfaceRect {
  left: number
  top: number
  width: number
  height: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const round = (v: number, d: number): number => Math.round(v * d) / d

/** Screen point → (u, v) on a surface rect, clamped and rounded for the wire. */
export function normalize(rect: SurfaceRect, x: number, y: number): [number, number] {
  return [round(clamp01((x - rect.left) / rect.width), 1e5), round(clamp01((y - rect.top) / rect.height), 1e5)]
}

export type Finger = [number, number]

/**
 * Two fingers moved from `a` to `b`. Returns how the writing area should move:
 * the area pans opposite to the fingers (the paper follows them) and zooms in
 * when they spread (the area gets smaller, so writing is magnified).
 */
export function twoFingerDelta(rect: SurfaceRect, a: [Finger, Finger], b: [Finger, Finger]): { du: number; dv: number; factor: number; u: number; v: number } {
  const mid = (p: [Finger, Finger]): Finger => [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]
  const dist = (p: [Finger, Finger]): number => Math.max(1, Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]))
  const ma = mid(a)
  const mb = mid(b)
  const [u, v] = normalize(rect, mb[0], mb[1])
  return {
    du: -(mb[0] - ma[0]) / rect.width,
    dv: -(mb[1] - ma[1]) / rect.height,
    factor: dist(b) / dist(a),
    u,
    v
  }
}

/** Should a second finger turn a just-started stroke into a pinch/pan? */
export function secondFingerCancels(strokeAgeMs: number, strokePoints: number): boolean {
  return strokeAgeMs < 250 && strokePoints < 12
}

/** Short, non-identifying label for the desktop: "iPhone · Safari". */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Phone'
  const browser = /SamsungBrowser/.test(ua)
    ? 'Samsung Internet'
    : /FxiOS|Firefox/.test(ua)
      ? 'Firefox'
      : /EdgiOS|EdgA|Edg\//.test(ua)
        ? 'Edge'
        : /CriOS|Chrome/.test(ua)
          ? 'Chrome'
          : /Safari/.test(ua)
            ? 'Safari'
            : ''
  return browser ? `${device} · ${browser}` : device
}

/** Random id for strokes, commands and this phone. */
export function randomId(length = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}
