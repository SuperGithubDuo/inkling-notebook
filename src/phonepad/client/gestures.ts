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
