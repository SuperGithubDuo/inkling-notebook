/**
 * Landmark traces: a recording of what the hand tracker reported, frame by
 * frame. Landmarks only, never video. Replaying the same trace through
 * different settings lets us compare smoothing and gesture behaviour on
 * identical input.
 *
 * Format `wisp.landmarks` v1:
 *   { format, version, videoAspect, frames: [{ t, c, lm }] }
 *   t  – ms (performance.now clock of the recording)
 *   c  – tracking confidence 0–1
 *   lm – 63 numbers (21 × x, y, z, camera space) or null when no hand
 */
import type { Landmark } from '../tracking/landmarks'

export const TRACE_FORMAT = 'wisp.landmarks' as const

export interface TraceFrame {
  t: number
  c: number
  lm: number[] | null
}

export interface LandmarkTrace {
  format: typeof TRACE_FORMAT
  version: 1
  videoAspect: number
  /** Optional free-text label, e.g. "Hello World, defaults". */
  note?: string
  frames: TraceFrame[]
}

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5

export function packLandmarks(lm: readonly Landmark[] | null): number[] | null {
  if (!lm) return null
  const out: number[] = []
  for (const p of lm) out.push(r5(p.x), r5(p.y), r5(p.z))
  return out
}

export function unpackLandmarks(a: readonly number[] | null): Landmark[] | null {
  if (!a || a.length < 63) return null
  const out: Landmark[] = []
  for (let i = 0; i < 21; i++) out.push({ x: a[i * 3]!, y: a[i * 3 + 1]!, z: a[i * 3 + 2]! })
  return out
}

/** Records frames in memory. Bounded so a forgotten recording can't eat memory. */
export class TraceRecorder {
  private frames: TraceFrame[] = []
  private aspect = 16 / 9
  recording = false
  static readonly MAX_FRAMES = 30 * 60 * 5 // five minutes at 30 fps

  start(): void {
    this.frames = []
    this.recording = true
  }

  add(t: number, lm: readonly Landmark[] | null, confidence: number, videoAspect: number): void {
    if (!this.recording) return
    this.aspect = videoAspect
    this.frames.push({ t: Math.round(t * 10) / 10, c: Math.round(confidence * 1000) / 1000, lm: packLandmarks(lm) })
    if (this.frames.length >= TraceRecorder.MAX_FRAMES) this.recording = false
  }

  get length(): number {
    return this.frames.length
  }

  stop(note?: string): LandmarkTrace {
    this.recording = false
    const trace: LandmarkTrace = { format: TRACE_FORMAT, version: 1, videoAspect: this.aspect, frames: this.frames }
    if (note) trace.note = note
    this.frames = []
    return trace
  }
}

export function parseTrace(data: unknown): LandmarkTrace {
  const d = data as Partial<LandmarkTrace> | null
  if (!d || d.format !== TRACE_FORMAT || d.version !== 1 || !Array.isArray(d.frames)) {
    throw new Error('Not a WISP landmark trace (format "wisp.landmarks", version 1).')
  }
  const videoAspect = typeof d.videoAspect === 'number' && d.videoAspect > 0 ? d.videoAspect : 16 / 9
  const frames: TraceFrame[] = []
  for (const f of d.frames) {
    if (!f || typeof f.t !== 'number' || !Number.isFinite(f.t)) continue
    const lm = Array.isArray(f.lm) && f.lm.length >= 63 && f.lm.every((v) => typeof v === 'number' && Number.isFinite(v)) ? f.lm : null
    frames.push({ t: f.t, c: typeof f.c === 'number' ? f.c : 1, lm })
  }
  return { format: TRACE_FORMAT, version: 1, videoAspect, note: typeof d.note === 'string' ? d.note : undefined, frames }
}
