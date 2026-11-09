/**
 * wisp-motion labels (research only — nothing here is used by the live app).
 *
 * Two kinds of label, kept apart on purpose:
 *  - Task A (tracking-error detection): per-frame "the tracked pen position is
 *    wrong here" spans. Sources, from weakest to strongest:
 *      'mark'      the writer pressed "Mark glitch" after seeing a stray line
 *                  (only says an error happened shortly BEFORE the mark);
 *      'manual'    someone scrubbed through the replay and marked the span;
 *      'synthetic' an error injected into a trace on purpose (exact, but the
 *                  error model is ours, not MediaPipe's).
 *  - Task B (trajectory reconstruction) needs reference pen paths from an
 *    independent sensor (see README); landmarks alone are never ground truth.
 */
import type { LandmarkTrace } from '../replay/trace'

export type LabelKind = 'tracking-error' | 'intended-ink' | 'no-ink' | 'unsure'
export type LabelSource = 'mark' | 'manual' | 'synthetic' | 'auto'

export interface Annotation {
  /** Inclusive span (trace ms). */
  t0: number
  t1: number
  label: LabelKind
  source: LabelSource
  note?: string
}

export const ANNOTATION_FORMAT = 'wisp.motion.annotations' as const

/** Annotations live in a sidecar file next to the trace, so traces stay immutable (and their hashes stable). */
export interface AnnotationFile {
  format: typeof ANNOTATION_FORMAT
  version: 1
  /** sha256 of the trace file these annotations describe. */
  trace: string
  annotations: Annotation[]
}

/**
 * "Mark glitch" presses → candidate error spans. A writer presses the button
 * after noticing the stray ink, typically 0.3–1.5 s later, so the span is
 * [t − windowMs, t] and the label is weak ('mark').
 */
export function marksToAnnotations(trace: LandmarkTrace, windowMs = 1500): Annotation[] {
  return (trace.events ?? [])
    .filter((e) => e.type === 'mark')
    .map((e) => ({ t0: e.t - windowMs, t1: e.t, label: (e.label as LabelKind) === 'tracking-error' || !e.label ? 'tracking-error' : (e.label as LabelKind), source: 'mark' as const }))
}

/** Per-frame labels: 1 inside a span of `kind`, 0 outside, null where an 'unsure' span covers the frame (excluded from metrics). */
export function frameLabels(trace: LandmarkTrace, annotations: readonly Annotation[], kind: LabelKind = 'tracking-error'): Array<0 | 1 | null> {
  return trace.frames.map((f) => {
    if (annotations.some((a) => a.label === 'unsure' && f.t >= a.t0 && f.t <= a.t1)) return null
    return annotations.some((a) => a.label === kind && f.t >= a.t0 && f.t <= a.t1) ? 1 : 0
  })
}

/** Checks an annotation file against its trace: spans inside the trace, ordered, known labels. */
export function validateAnnotations(file: unknown, trace: LandmarkTrace): string[] {
  const errors: string[] = []
  const f = file as Partial<AnnotationFile> | null
  if (!f || f.format !== ANNOTATION_FORMAT || f.version !== 1) return ['not a wisp.motion.annotations v1 file']
  if (!Array.isArray(f.annotations)) return ['annotations must be an array']
  const t0 = trace.frames[0]?.t ?? 0
  const t1 = trace.frames.at(-1)?.t ?? 0
  const kinds: ReadonlySet<string> = new Set(['tracking-error', 'intended-ink', 'no-ink', 'unsure'])
  const sources: ReadonlySet<string> = new Set(['mark', 'manual', 'synthetic', 'auto'])
  f.annotations.forEach((a, i) => {
    if (!Number.isFinite(a.t0) || !Number.isFinite(a.t1) || a.t1 < a.t0) errors.push(`annotation ${i}: invalid span`)
    else if (a.t1 < t0 - 2000 || a.t0 > t1 + 2000) errors.push(`annotation ${i}: outside the trace (${t0}–${t1} ms)`)
    if (!kinds.has(a.label)) errors.push(`annotation ${i}: unknown label "${String(a.label)}"`)
    if (!sources.has(a.source)) errors.push(`annotation ${i}: unknown source "${String(a.source)}"`)
  })
  return errors
}
