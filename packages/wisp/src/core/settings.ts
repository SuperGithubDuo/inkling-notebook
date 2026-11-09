/** User-adjustable WISP settings. Persisted to localStorage (settings only, never camera data). */
import type { WritingRegion } from '../strokes/coordinates'

export type PenPoint = 'midpoint' | 'index'
/** Natural Writing follows the hand faithfully; Writing Assist adds a steady writing scale and layout help (v0.1.4). */
export type WritingMode = 'natural' | 'assist'
/** Writing scale presets: values of writingSensitivity (hand movement → page movement gain). */
export const WRITING_SCALES = { small: 0.8, medium: 1, large: 1.25 } as const
export type WritingScalePreset = keyof typeof WRITING_SCALES | 'custom'
export function scalePreset(v: number): WritingScalePreset {
  for (const [k, s] of Object.entries(WRITING_SCALES)) if (Math.abs(v - s) < 1e-6) return k as WritingScalePreset
  return 'custom'
}
/** Which pinch distance lifts and lowers the pen (v0.1.3); see input/handFrameProcessor.ts. */
export type PinchMetric = 'auto' | '3d' | '2d'

export interface WispSettings {
  /** Selfie-style preview and movement (move right → cursor right). */
  mirror: boolean
  /**
   * Writing scale, 0.5–2 (Small 0.8, Medium 1, Large 1.25): how far the pen
   * moves on the page for a given hand movement. Higher = bigger writing.
   */
  writingSensitivity: number
  /** v0.1.4: Natural Writing (default) or Writing Assist. */
  writingMode: WritingMode
  /** v0.1.4 writing guides (page overlay only; never exported). */
  showGuides: boolean
  guideBaseline: boolean
  guideXHeight: boolean
  guideCapHeight: boolean
  guideLineSpacing: boolean
  /** Ghost Whiteboard (display only): 'standard' page, or the page as translucent glass over the webcam. */
  viewMode: 'standard' | 'ghost'
  /** Ghost Whiteboard: how much of the webcam shows through the board (0.03–0.5; board opacity = 1 − this). */
  ghostVisibility: number
  /** v0.1.5: distance between guide lines relative to the writing size (0.6–2; 1 = normal). */
  lineSpacing: number
  /**
   * v0.1.5 stroke protection: never connect ink across tracking glitches,
   * jumps or gaps (strokes/continuity.ts). On by default.
   */
  strokeProtection: boolean
  /**
   * Developer comparison: run the exact v0.1.4 pipeline (no Smart Ink:
   * no continuity guard, v0.1.4 mapping lock). For A/B testing on a real webcam.
   */
  legacyPipeline: boolean
  /** 0–1. One Euro smoothing strength. */
  smoothing: number
  /** 0–1. Stabilizer (lazy-pen radius) for webcam input. */
  stabilizer: number
  /** Zero-lag re-smoothing of each webcam stroke at pen-up. */
  refine: boolean
  /** 0.5–2. Higher = looser pinches start a stroke. */
  pinchSensitivity: number
  /** 0.5–2. Higher = a smaller or slower finger opening lifts the pen. */
  releaseSensitivity: number
  showPreview: boolean
  showLandmarks: boolean
  showDiagnostics: boolean
  /** Which point writes: between thumb and index tips (default), or the index fingertip. */
  penPoint: PenPoint
  /** Pinch measurement: '2d' (default, v0.1.2 behaviour); 'auto' blends in 3D as the hand turns (experimental). */
  pinchMetric: PinchMetric
  /** Calibrated writing area in view space; null = automatic. */
  region: WritingRegion | null
}

export const DEFAULT_SETTINGS: WispSettings = {
  mirror: true,
  writingSensitivity: 1,
  writingMode: 'natural',
  showGuides: false,
  guideBaseline: true,
  guideXHeight: true,
  guideCapHeight: false,
  guideLineSpacing: false,
  viewMode: 'standard',
  ghostVisibility: 0.12,
  lineSpacing: 1,
  strokeProtection: true,
  legacyPipeline: false,
  smoothing: 0.5,
  stabilizer: 0.25,
  refine: true,
  pinchSensitivity: 1,
  releaseSensitivity: 1,
  showPreview: true,
  showLandmarks: true,
  showDiagnostics: false,
  penPoint: 'midpoint',
  pinchMetric: '2d',
  region: null
}

/**
 * v2 (WISP 0.1.1): smoothing values mean something different, the pen
 * point default moved to the midpoint, and release detection changed. Old
 * v1 tuning values are not carried over (they were tuned against the old
 * behaviour); display preferences and the calibrated region are kept.
 */
const KEY = 'wisp.settings.v2'
const LEGACY_KEY = 'wisp.settings.v1'

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
    writingMode: r.writingMode === 'assist' ? 'assist' : 'natural',
    showGuides: bool(r.showGuides, d.showGuides),
    guideBaseline: bool(r.guideBaseline, d.guideBaseline),
    guideXHeight: bool(r.guideXHeight, d.guideXHeight),
    guideCapHeight: bool(r.guideCapHeight, d.guideCapHeight),
    guideLineSpacing: bool(r.guideLineSpacing, d.guideLineSpacing),
    viewMode: r.viewMode === 'ghost' ? 'ghost' : 'standard',
    ghostVisibility: num(r.ghostVisibility, 0.03, 0.5, d.ghostVisibility),
    lineSpacing: num(r.lineSpacing, 0.6, 2, d.lineSpacing),
    strokeProtection: bool(r.strokeProtection, d.strokeProtection),
    legacyPipeline: bool(r.legacyPipeline, d.legacyPipeline),
    smoothing: num(r.smoothing, 0, 1, d.smoothing),
    stabilizer: num(r.stabilizer, 0, 1, d.stabilizer),
    refine: bool(r.refine, d.refine),
    pinchSensitivity: num(r.pinchSensitivity, 0.5, 2, d.pinchSensitivity),
    releaseSensitivity: num(r.releaseSensitivity, 0.5, 2, d.releaseSensitivity),
    showPreview: bool(r.showPreview, d.showPreview),
    showLandmarks: bool(r.showLandmarks, d.showLandmarks),
    showDiagnostics: bool(r.showDiagnostics, d.showDiagnostics),
    penPoint: r.penPoint === 'index' ? 'index' : 'midpoint',
    pinchMetric: r.pinchMetric === 'auto' || r.pinchMetric === '3d' ? r.pinchMetric : '2d',
    region
  }
}

/** Keeps display preferences and calibration from v1 settings; tuning values reset to v0.1.1 defaults. */
export function migrateV1(raw: unknown): WispSettings {
  const old = sanitizeSettings(raw)
  return {
    ...DEFAULT_SETTINGS,
    mirror: old.mirror,
    writingSensitivity: old.writingSensitivity,
    showPreview: old.showPreview,
    showLandmarks: old.showLandmarks,
    showDiagnostics: old.showDiagnostics,
    region: old.region
  }
}

export function loadSettings(): WispSettings {
  try {
    const s = localStorage.getItem(KEY)
    if (s) return sanitizeSettings(JSON.parse(s))
    const legacy = localStorage.getItem(LEGACY_KEY)
    return legacy ? migrateV1(JSON.parse(legacy)) : { ...DEFAULT_SETTINGS }
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
