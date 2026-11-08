/**
 * Landmark traces: a recording of what the hand tracker reported, frame by
 * frame. Landmarks only, never video. Replaying the same trace through
 * different settings lets us compare smoothing and gesture behaviour on
 * identical input.
 *
 * Format `wisp.landmarks` (v1, extended in v2 by WISP 0.1.2):
 *   { format, version, videoAspect, note?, settings?, frames, events?, strokes? }
 *   frames[]: { t, c, lm, d? }
 *     t  – ms (performance.now clock of the recording)
 *     c  – tracking confidence 0–1
 *     lm – 63 numbers (21 × x, y, z, camera space) or null when no hand.
 *          Includes the raw thumb tip (4) and index tip (8).
 *     d  – v2 diagnostics of what WISP computed for this frame (page space):
 *          mid  raw pen point (thumb–index midpoint, mapped)
 *          cur  filtered pen point (the cursor / live ink position)
 *          down pen state (1 = ink)
 *          r    raw pinch ratio,  rs smoothed,  b writing baseline,
 *          v    opening velocity (ratio/s),  s gesture state
 *   v3 (WISP 0.1.3) adds, per frame:
 *     w  – MediaPipe world landmarks (63 numbers, metres, origin at the hand
 *          centre, camera-aligned axes) or null
 *     d.r2, d.r3  2D and 3D pinch ratios;  d.n palm normal;  d.q tracking quality
 *     d.dt frame interval, d.inf inference time, d.age capture→update latency (ms)
 *   events[]:  { t, type: 'pen-down' | 'pen-up', reason? }
 *   strokes[]: the finished strokes, as in the stroke export (raw + processed points)
 * Replay uses t, c, lm, w and videoAspect, so v1–v3 traces all replay
 * (v1/v2 have no world landmarks and replay with the 2D pinch ratio).
 */
import type { Landmark } from '../tracking/landmarks'
import type { Stroke } from '../strokes/types'

export const TRACE_FORMAT = 'wisp.landmarks' as const

export interface FrameDiagnostics {
  mid?: [number, number] | null
  cur?: [number, number] | null
  down?: 0 | 1
  r?: number | null
  rs?: number | null
  b?: number | null
  v?: number
  s?: string
  /** v3: 2D and 3D pinch ratios (the one in use is `r`). */
  r2?: number | null
  r3?: number | null
  /** v3: palm normal (camera axes) and tracking quality. */
  n?: [number, number, number] | null
  q?: 'good' | 'reduced' | 'poor'
  /** v3: interval since the previous frame, inference time, capture-to-pen-update age (ms). */
  dt?: number
  inf?: number
  age?: number
}

export interface TraceFrame {
  t: number
  c: number
  lm: number[] | null
  /** v3: MediaPipe world landmarks (63 numbers, metres, origin at the hand centre), or null. */
  w?: number[] | null
  d?: FrameDiagnostics
}

export interface TraceEvent {
  t: number
  type: 'pen-down' | 'pen-up'
  reason?: string
}

export interface LandmarkTrace {
  format: typeof TRACE_FORMAT
  version: 1 | 2 | 3
  videoAspect: number
  /** Optional free-text label, e.g. "Hello World, defaults". */
  note?: string
  /** WISP settings when the trace was recorded. */
  settings?: Record<string, unknown>
  frames: TraceFrame[]
  events?: TraceEvent[]
  strokes?: Stroke[]
}

const r4 = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4)

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
  private events: TraceEvent[] = []
  private strokes: Stroke[] = []
  private aspect = 16 / 9
  recording = false
  static readonly MAX_FRAMES = 30 * 60 * 5 // five minutes at 30 fps

  start(): void {
    this.frames = []
    this.events = []
    this.strokes = []
    this.recording = true
  }

  add(t: number, lm: readonly Landmark[] | null, confidence: number, videoAspect: number, d?: FrameDiagnostics, world?: readonly Landmark[] | null): void {
    if (!this.recording) return
    this.aspect = videoAspect
    const f: TraceFrame = { t: Math.round(t * 10) / 10, c: Math.round(confidence * 1000) / 1000, lm: packLandmarks(lm), w: packLandmarks(world ?? null) }
    if (d) {
      f.d = {
        ...d,
        mid: d.mid ? [r4(d.mid[0])!, r4(d.mid[1])!] : null,
        cur: d.cur ? [r4(d.cur[0])!, r4(d.cur[1])!] : null,
        r: r4(d.r),
        rs: r4(d.rs),
        b: r4(d.b),
        v: Math.round((d.v ?? 0) * 100) / 100,
        r2: r4(d.r2),
        r3: r4(d.r3),
        n: d.n ? [r4(d.n[0])!, r4(d.n[1])!, r4(d.n[2])!] : null,
        dt: d.dt === undefined ? undefined : Math.round(d.dt * 10) / 10,
        inf: d.inf === undefined ? undefined : Math.round(d.inf * 10) / 10,
        age: d.age === undefined ? undefined : Math.round(d.age * 10) / 10
      }
    }
    this.frames.push(f)
    if (this.frames.length >= TraceRecorder.MAX_FRAMES) this.recording = false
  }

  addEvent(e: TraceEvent): void {
    if (this.recording) this.events.push({ ...e, t: Math.round(e.t * 10) / 10 })
  }

  addStroke(s: Readonly<Stroke>): void {
    if (this.recording) this.strokes.push({ ...s, points: s.points.slice() })
  }

  get length(): number {
    return this.frames.length
  }

  stop(note?: string, settings?: Record<string, unknown>): LandmarkTrace {
    this.recording = false
    const trace: LandmarkTrace = { format: TRACE_FORMAT, version: 3, videoAspect: this.aspect, frames: this.frames, events: this.events, strokes: this.strokes }
    if (note) trace.note = note
    if (settings) trace.settings = settings
    this.frames = []
    this.events = []
    this.strokes = []
    return trace
  }
}

export function parseTrace(data: unknown): LandmarkTrace {
  const d = data as Partial<LandmarkTrace> | null
  if (!d || d.format !== TRACE_FORMAT || ![1, 2, 3].includes(d.version as number) || !Array.isArray(d.frames)) {
    throw new Error('Not a WISP landmark trace (format "wisp.landmarks", version 1–3).')
  }
  const videoAspect = typeof d.videoAspect === 'number' && d.videoAspect > 0 ? d.videoAspect : 16 / 9
  const frames: TraceFrame[] = []
  for (const f of d.frames) {
    if (!f || typeof f.t !== 'number' || !Number.isFinite(f.t)) continue
    const ok = (a: unknown): a is number[] => Array.isArray(a) && a.length >= 63 && a.every((v) => typeof v === 'number' && Number.isFinite(v))
    const lm = ok(f.lm) ? f.lm : null
    const w = ok(f.w) ? f.w : null
    frames.push({ t: f.t, c: typeof f.c === 'number' ? f.c : 1, lm, w })
  }
  return {
    format: TRACE_FORMAT,
    version: d.version as 1 | 2 | 3,
    videoAspect,
    note: typeof d.note === 'string' ? d.note : undefined,
    settings: d.settings && typeof d.settings === 'object' ? d.settings : undefined,
    frames,
    events: Array.isArray(d.events) ? d.events : undefined,
    strokes: Array.isArray(d.strokes) ? d.strokes : undefined
  }
}
