/** User-adjustable WISP settings. Persisted to localStorage (settings only, never camera data). */
import type { WritingRegion } from '../strokes/coordinates'

export type PenPoint = 'index' | 'pinch'

export interface WispSettings {
  /** Selfie-style preview and movement (move right → cursor right). */
  mirror: boolean
  /** 0.5–2. Higher = less hand movement to cover the page. */
  writingSensitivity: number
  /** 0–1. One Euro smoothing strength. */
  smoothing: number
  /** 0.5–2. Higher = looser pinches count. */
  pinchSensitivity: number
  showPreview: boolean
  showLandmarks: boolean
  showDiagnostics: boolean
  /** Which point writes: the index fingertip, or the midpoint of the thumb and index tips. */
  penPoint: PenPoint
  /** Calibrated writing area in view space; null = automatic. */
  region: WritingRegion | null
}

export const DEFAULT_SETTINGS: WispSettings = {
  mirror: true,
  writingSensitivity: 1,
  smoothing: 0.5,
  pinchSensitivity: 1,
  showPreview: true,
  showLandmarks: true,
  showDiagnostics: false,
  penPoint: 'index',
  region: null
}

const KEY = 'wisp.settings.v1'

const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function sanitizeSettings(raw: unknown): WispSettings {
  const d = DEFAULT_SETTINGS
  if (typeof raw !== 'object' || raw === null) return { ...d }
  const r = raw as Record<string, unknown>
  let region: WritingRegion | null = null
  const rg = r.region as Record<string, unknown> | null | undefined
  if (rg && [rg.x0, rg.y0, rg.x1, rg.y1].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const c = rg as unknown as WritingRegion
    if (c.x1 - c.x0 > 0.05 && c.y1 - c.y0 > 0.05) region = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }
  }
  return {
    mirror: bool(r.mirror, d.mirror),
    writingSensitivity: num(r.writingSensitivity, 0.5, 2, d.writingSensitivity),
    smoothing: num(r.smoothing, 0, 1, d.smoothing),
    pinchSensitivity: num(r.pinchSensitivity, 0.5, 2, d.pinchSensitivity),
    showPreview: bool(r.showPreview, d.showPreview),
    showLandmarks: bool(r.showLandmarks, d.showLandmarks),
    showDiagnostics: bool(r.showDiagnostics, d.showDiagnostics),
    penPoint: r.penPoint === 'pinch' ? 'pinch' : 'index',
    region
  }
}

export function loadSettings(): WispSettings {
  try {
    const s = localStorage.getItem(KEY)
    return sanitizeSettings(s ? JSON.parse(s) : null)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: WispSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable: settings last for this session */
  }
}
