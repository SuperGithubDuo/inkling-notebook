/**
 * SYNTHETIC labelled traces for wisp-motion: clean modelled writing with
 * tracking faults injected on purpose, so every corrupted frame is known
 * exactly. Use them to test the tooling and to sanity-check detectors.
 *
 * They are NOT evidence about real webcams: both the hand/noise model and
 * the fault model are ours. Manifests built from them say source: 'synthetic'.
 */
import { SCENARIOS, setNoiseProfile } from '../replay/scenarios'
import { rng } from '../replay/synth'
import type { LandmarkTrace, TraceFrame } from '../replay/trace'
import type { Annotation } from './labels'

export type FaultKind = 'tip-glitch' | 'hand-jump' | 'hand-swap' | 'scale-jump' | 'dropout-relocate'

export interface InjectedFault {
  kind: FaultKind
  /** Frame indices whose landmarks were corrupted (the per-frame truth). */
  frames: number[]
  t0: number
  t1: number
}

const shift = (lm: number[], dx: number, dy: number, only?: number[]): number[] =>
  lm.map((v, j) => {
    const k = Math.floor(j / 3)
    if (only && !only.includes(k)) return v
    return j % 3 === 0 ? v + dx : j % 3 === 1 ? v + dy : v
  })

const scaleAbout = (lm: number[], s: number): number[] => {
  let cx = 0, cy = 0
  for (let k = 0; k < 21; k++) (cx += lm[k * 3]! / 21), (cy += lm[k * 3 + 1]! / 21)
  return lm.map((v, j) => (j % 3 === 0 ? cx + (v - cx) * s : j % 3 === 1 ? cy + (v - cy) * s : v))
}

/**
 * Injects `count` transient faults into a copy of `trace` at random tracked
 * frames (seeded). A fault corrupts a run of frames and then tracking
 * returns to the true hand. 'dropout-relocate' removes the hand for a few
 * frames and brings it back offset for a few more (labelled: the offset frames).
 */
export function injectFaults(trace: LandmarkTrace, seed: number, count = 4, kinds: FaultKind[] = ['tip-glitch', 'hand-jump', 'hand-swap', 'scale-jump', 'dropout-relocate'], eligible?: readonly number[]): { trace: LandmarkTrace; faults: InjectedFault[] } {
  const r = rng(seed)
  const frames: TraceFrame[] = trace.frames.map((f) => ({ ...f, lm: f.lm ? f.lm.slice() : null }))
  const faults: InjectedFault[] = []
  const used = new Set<number>()
  const allowed = eligible ? new Set(eligible) : null
  const tracked = frames.map((f, i) => (f.lm && (!allowed || allowed.has(i)) ? i : -1)).filter((i) => i > 10)
  // Up to 4 attempts per fault (a candidate overlapping an earlier fault is skipped).
  for (let n = 0, tries = 0; n < count && tracked.length && tries < count * 4; tries++) {
    const kind = kinds[Math.floor(r() * kinds.length)]!
    const len = kind === 'tip-glitch' ? 1 + Math.floor(r() * 6) : kind === 'hand-swap' ? 3 + Math.floor(r() * 8) : 2 + Math.floor(r() * 6)
    const start = tracked[Math.floor(r() * tracked.length)]!
    const span: number[] = []
    for (let i = start; i < Math.min(frames.length, start + len + (kind === 'dropout-relocate' ? 3 : 0)); i++) span.push(i)
    if (span.some((i) => used.has(i) || used.has(i - 3) || used.has(i + 3) || !frames[i]!.lm)) continue
    const a = 2 * Math.PI * r()
    const mag = kind === 'tip-glitch' ? 0.05 + 0.1 * r() : kind === 'hand-jump' ? 0.08 + 0.15 * r() : kind === 'hand-swap' ? 0.25 + 0.2 * r() : 0.06 + 0.08 * r()
    const corrupted: number[] = []
    span.forEach((i, k) => {
      const f = frames[i]!
      used.add(i)
      if (kind === 'dropout-relocate' && k < 3) {
        f.lm = null
        f.w = null
        f.c = 0
        return
      }
      const lm = f.lm!
      if (kind === 'tip-glitch') f.lm = shift(lm, mag * Math.cos(a), mag * Math.sin(a), [4, 8])
      else if (kind === 'scale-jump') f.lm = shift(scaleAbout(lm, 1.35), mag * Math.cos(a), mag * Math.sin(a))
      else f.lm = shift(lm, mag * Math.cos(a), mag * Math.sin(a))
      if (kind === 'hand-swap') f.h = 'Other'
      corrupted.push(i)
    })
    if (corrupted.length) {
      faults.push({ kind, frames: corrupted, t0: frames[corrupted[0]!]!.t, t1: frames[corrupted.at(-1)!]!.t })
      n++
    }
  }
  return { trace: { ...trace, frames }, faults }
}

export function faultAnnotations(faults: readonly InjectedFault[]): Annotation[] {
  return faults.map((f) => ({ t0: f.t0, t1: f.t1, label: 'tracking-error' as const, source: 'synthetic' as const, note: f.kind }))
}

export interface SyntheticItem {
  file: string
  participant: string
  session: string
  task: string
  trace: LandmarkTrace
  faults: InjectedFault[]
}

/**
 * A small synthetic "dataset": `participants` simulated writers (different
 * noise seeds), each writing the writing-group scenarios in `sessions`
 * sessions, with faults injected. Handedness is set to 'Right' on every
 * tracked frame (faults may change it).
 */
export function syntheticDataset(participants = 6, sessions = 2, faultsPerTrace = 4): SyntheticItem[] {
  setNoiseProfile('webcam')
  const tasks = SCENARIOS.filter((s) => ['A-slow-line', 'A3-fast-line', 'G-circle', 'F3-dashes', 'B-hello', 'C-math', 'S3-hello-3x'].includes(s.id))
  const out: SyntheticItem[] = []
  for (let p = 1; p <= participants; p++)
    for (let s = 1; s <= sessions; s++)
      tasks.forEach((task, k) => {
        const seed = p * 1000 + s * 100 + k
        const { trace } = task.build(seed)
        const withHand: LandmarkTrace = { ...trace, version: 4, frames: trace.frames.map((f) => (f.lm ? { ...f, h: 'Right' } : f)) }
        const { trace: bad, faults } = injectFaults(withHand, seed + 7, faultsPerTrace)
        const participant = `SYN-P${String(p).padStart(2, '0')}`
        const session = `${participant}-S${s}`
        out.push({ file: `${session}/${task.id}.json`, participant, session, task: task.id, trace: { ...bad, meta: { participant, session, task: task.id, device: 'synthetic', wispVersion: '0.1.5', consent: true } }, faults })
      })
  return out
}
