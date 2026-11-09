/**
 * Task A baselines: how well do simple, non-learned detectors find frames
 * whose tracked pen position is wrong? Any future model must beat these on
 * HELD-OUT PARTICIPANTS before it may touch the live pipeline.
 *
 * Detectors (each returns one flag per frame; untracked frames are skipped):
 *  - 'gate-v0.1.4'   the v0.1.4 OutlierGate (page units, centred region);
 *  - 'guard-v0.1.5'  the v0.1.5 ContinuityGuard: a frame is flagged when it
 *                    was never inked (dropped, held and discarded, suppressed);
 *  - 'speed'         pen speed above a fixed limit (a naïve reference).
 *
 * Metrics: frame-level precision / recall / F1; event recall (share of
 * labelled error spans with at least one flagged frame); false alarms per
 * minute (flagged runs outside every error span, ±2 frames).
 */
import { ContinuityGuard } from '../strokes/continuity'
import { OutlierGate } from '../strokes/smoothing'
import { cameraToPage, defaultRegion } from '../strokes/coordinates'
import { motionFrame } from '../input/handFrameProcessor'
import { handPose, validLandmarks } from '../tracking/landmarks'
import { unpackLandmarks, type LandmarkTrace } from '../replay/trace'

export type Detector = (trace: LandmarkTrace) => boolean[]

export const DETECTORS: Record<string, Detector> = {
  'gate-v0.1.4': (trace) => {
    const gate = new OutlierGate()
    const region = defaultRegion(trace.videoAspect, 1.6, 0.7)
    return trace.frames.map((f) => {
      const lm = unpackLandmarks(f.lm)
      if (!validLandmarks(lm)) return false
      const pen = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 }
      const p = cameraToPage(pen, { mirror: false, region })
      return p ? gate.check(p, f.t) !== 'accept' : false
    })
  },
  'guard-v0.1.5': (trace) => {
    const guard = new ContinuityGuard<number>()
    const inked = new Set<number>()
    const out = trace.frames.map(() => false)
    trace.frames.forEach((f, i) => {
      const lm = unpackLandmarks(f.lm)
      if (!validLandmarks(lm)) return
      const pen = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 }
      const mf = motionFrame(f.t, lm, pen, false, trace.videoAspect, handPose(unpackLandmarks(f.w ?? null)), f.h ?? null)
      for (const op of guard.ink(mf, i)) if (op.op === 'ink') inked.add(op.item)
    })
    for (const op of guard.penUp()) if (op.op === 'ink') inked.add(op.item)
    trace.frames.forEach((f, i) => (out[i] = !!f.lm && !inked.has(i)))
    return out
  },
  speed: (trace) => {
    let prev: { t: number; x: number; y: number } | null = null
    return trace.frames.map((f) => {
      const lm = unpackLandmarks(f.lm)
      if (!validLandmarks(lm)) return false
      const ar = trace.videoAspect
      const p = { t: f.t, x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 / ar }
      const flag = prev !== null && Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(0.001, (p.t - prev.t) / 1000) > 1.5 // frame widths / s
      prev = p
      return flag
    })
  }
}

export interface DetectionScore {
  framesLabelled: number
  errorFrames: number
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
  events: number
  eventRecall: number
  falseAlarmsPerMin: number
}

export function scoreDetection(items: ReadonlyArray<{ trace: LandmarkTrace; labels: ReadonlyArray<0 | 1 | null> }>, detector: Detector): DetectionScore {
  let tp = 0, fp = 0, fn = 0, n = 0, pos = 0, events = 0, hit = 0, alarms = 0, minutes = 0
  for (const { trace, labels } of items) {
    const flags = detector(trace)
    const tracked = trace.frames.map((f) => !!f.lm)
    minutes += (trace.frames.filter((f) => f.lm).length * (1000 / 30)) / 60000
    for (let i = 0; i < flags.length; i++) {
      const y = labels[i]
      if (y === null || !tracked[i]) continue
      n++
      if (y === 1) pos++
      if (flags[i] && y === 1) tp++
      else if (flags[i] && y === 0) fp++
      else if (!flags[i] && y === 1) fn++
    }
    // Events: maximal runs of label 1.
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== 1 || labels[i - 1] === 1) continue
      let j = i
      while (labels[j + 1] === 1) j++
      events++
      // A detection up to 2 frames after the span still counts (a jump is often only provable when the next frame arrives).
      let found = false
      for (let k = i; k <= Math.min(flags.length - 1, j + 2); k++) if (flags[k]) found = true
      if (found) hit++
    }
    // False alarms: runs of flags with no error label within ±2 frames.
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i] || flags[i - 1]) continue
      let j = i
      while (flags[j + 1]) j++
      let near = false
      for (let k = Math.max(0, i - 2); k <= Math.min(labels.length - 1, j + 2); k++) if (labels[k] === 1) near = true
      if (!near) alarms++
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  return {
    framesLabelled: n,
    errorFrames: pos,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    events,
    eventRecall: events ? hit / events : 0,
    falseAlarmsPerMin: minutes ? alarms / minutes : 0
  }
}
