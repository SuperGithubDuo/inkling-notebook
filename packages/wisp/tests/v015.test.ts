/**
 * WISP v0.1.5 "Smart Ink": stroke continuity, mapping stability, aspect-true
 * calibration, A/B guarantees and the wisp-motion research tooling.
 * All replay inputs are SYNTHETIC (modelled hand and noise).
 */
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/pipeline-v014.json'
import { ContinuityGuard, type MotionFrame } from '../src/strokes/continuity'
import { HandFrameProcessor, effectiveRegion } from '../src/input/handFrameProcessor'
import { StrokeEngine } from '../src/strokes/strokeEngine'
import { fitAspect } from '../src/strokes/writingPlane'
import { guideLines } from '../src/strokes/layout'
import { replay, REPLAY_PROCESSOR } from '../src/replay/replay'
import { SCENARIOS, setNoiseProfile } from '../src/replay/scenarios'
import { synthesize, writeStrokes, line, WEBCAM_NOISE, NO_NOISE } from '../src/replay/synth'
import { packLandmarks, parseTrace, unpackLandmarks, TraceRecorder, type LandmarkTrace } from '../src/replay/trace'
import { AB_CASES, runAb } from '../src/replay/ab'
import { buildManifest, canonicalJson, checkLeakage, groupSplit, validateTrace, type ManifestEntry } from '../src/wisp-motion/dataset'
import { extractFeatures, FEATURE_NAMES } from '../src/wisp-motion/features'
import { frameLabels, marksToAnnotations, validateAnnotations } from '../src/wisp-motion/labels'
import { DETECTORS, scoreDetection } from '../src/wisp-motion/baselines'
import { faultAnnotations, injectFaults, syntheticDataset } from '../src/wisp-motion/synthetic'
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/core/settings'

// ── helpers ────────────────────────────────────────────────────────────────

/** A frame with the pen at q, palm 0.1 below it (palm width 0.1). */
const mf = (t: number, x: number, y: number, extra: Partial<MotionFrame> = {}): MotionFrame => ({ t, q: { x, y }, palm: { x, y: y + 0.1 }, size: 0.1, normal: null, hand: 'Right', ...extra })

/** Runs frames through a guard as ink; returns the inked frame indices and the operations. */
function runGuard(frames: MotionFrame[], penUpAtEnd = true) {
  const g = new ContinuityGuard<number>()
  const inked: number[] = []
  const ops: string[] = []
  frames.forEach((f, i) => {
    for (const op of g.ink(f, i)) {
      if (op.op === 'ink') inked.push(op.item)
      ops.push(op.op === 'ink' ? `ink${op.item}` : `break:${op.reason}`)
    }
  })
  if (penUpAtEnd) for (const op of g.penUp()) if (op.op === 'ink') inked.push(op.item)
  return { g, inked, ops, breaks: ops.filter((o) => o.startsWith('break')).length }
}

/** A straight pen movement at `speed` frame widths/s, 30 fps. */
const straight = (n: number, speed = 0.15, t0 = 0, x0 = 0.3, y0 = 0.5) => Array.from({ length: n }, (_, i) => mf(t0 + i * 33, x0 + speed * (i * 0.033), y0))

const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── v0.1.4 preserved exactly ───────────────────────────────────────────────

describe('smartInk: false replays the v0.1.4 commit exactly', () => {
  const CFGS: Record<string, object> = { centred: {}, hand: { regionFit: 'hand' }, assist: { regionFit: 'hand', keepScale: true } }
  for (const c of (fixture as { cases: Array<{ profile: 'webcam' | 'model'; id: string; cfg: string; strokes: string; cursor: string }> }).cases.filter((_, i) => i % 3 === 0)) {
    it(`${c.profile} · ${c.id} · ${c.cfg}`, () => {
      setNoiseProfile(c.profile)
      const { trace } = SCENARIOS.find((s) => s.id === c.id)!.build(1)
      const r = replay(trace, { processor: { ...CFGS[c.cfg], smartInk: false } })
      expect(fnv(JSON.stringify(r.strokes.map((s) => s.points)))).toBe(c.strokes)
      expect(fnv(JSON.stringify(r.cursor.map(({ at: _at, ...q }) => q)))).toBe(c.cursor)
    })
  }
})

// ── Continuity guard ───────────────────────────────────────────────────────

describe('stroke continuity guard', () => {
  it('passes ordinary movement through at once (no frame held)', () => {
    const { inked, g } = runGuard(straight(30))
    expect(inked).toEqual(Array.from({ length: 30 }, (_, i) => i))
    expect(g.stats.held).toBe(0)
  })

  it('accepts a fast legitimate stroke that accelerates smoothly (up to ~1 m/s)', () => {
    const frames: MotionFrame[] = []
    let x = 0.3
    for (let i = 0; i < 20; i++) {
      const v = Math.min(1.2, 0.1 + 0.25 * i) // frame widths / s, ramping up
      x += v * 0.033
      frames.push(mf(i * 33, x, 0.5))
    }
    const { inked, breaks } = runGuard(frames)
    expect(breaks).toBe(0)
    expect(inked).toHaveLength(20)
  })

  it('releases a sharp fast reversal after one held frame instead of dropping it', () => {
    const frames = [...straight(8, 0.6)]
    const last = frames.at(-1)!
    for (let i = 1; i <= 8; i++) frames.push(mf(last.t + i * 33, last.q.x - 0.6 * 0.033 * i * 1.4, 0.5))
    const { inked, breaks, g } = runGuard(frames)
    expect(breaks).toBe(0)
    expect(inked).toHaveLength(frames.length)
    expect(g.stats.dropped).toBe(0)
  })

  it('drops a single-frame fingertip glitch and connects the stroke around it', () => {
    const frames = straight(20)
    frames[10] = { ...frames[10]!, q: { x: frames[10]!.q.x, y: frames[10]!.q.y - 0.06 } } // pen jumps, palm stays
    const { inked, breaks } = runGuard(frames)
    expect(breaks).toBe(0)
    expect(inked).not.toContain(10)
    expect(inked).toHaveLength(19)
  })

  it('never inks a 6-frame fingertip misplacement, and resumes on the pen trajectory', () => {
    const frames = straight(30)
    for (let i = 10; i < 16; i++) frames[i] = { ...frames[i]!, q: { x: frames[i]!.q.x + 0.01, y: frames[i]!.q.y - 0.06 } }
    const { inked } = runGuard(frames)
    for (let i = 10; i < 16; i++) expect(inked).not.toContain(i)
    expect(inked.filter((i) => i >= 18)).toHaveLength(12) // writing continues
  })

  it('splits (never connects) when the hand is re-detected elsewhere after a short gap', () => {
    const a = straight(12)
    const b = straight(12, 0.15, a.at(-1)!.t + 4 * 33, 0.32, 0.56) // 0.06 lower, after 100 ms without a hand
    const { inked, ops } = runGuard([...a, ...b])
    expect(ops.filter((o) => o === 'break:gap').length).toBe(1)
    // The break comes before any ink of the second segment.
    expect(ops.indexOf('break:gap')).toBeLessThan(ops.indexOf('ink12') === -1 ? ops.indexOf('ink13') : ops.indexOf('ink12'))
    expect(inked.filter((i) => i >= 12).length).toBeGreaterThanOrEqual(11)
  })

  it('bridges a one-frame drop-out on a straight stroke (no needless split)', () => {
    const frames = straight(20)
    frames.splice(10, 1)
    const { breaks, inked } = runGuard(frames)
    expect(breaks).toBe(0)
    expect(inked).toHaveLength(19)
  })

  it('suspends ink when tracking jumps to another hand, and resumes when the pen is found again', () => {
    const frames = straight(30)
    for (let i = 10; i < 18; i++) frames[i] = { ...frames[i]!, q: { x: frames[i]!.q.x - 0.35, y: 0.5 }, palm: { x: frames[i]!.q.x - 0.35, y: 0.6 }, hand: 'Left' }
    const { inked, g } = runGuard(frames)
    for (let i = 10; i < 18; i++) expect(inked).not.toContain(i)
    expect(g.stats.suspends).toBe(1)
    expect(inked.filter((i) => i >= 20).length).toBeGreaterThanOrEqual(9)
  })

  it('a long suspension ends once tracking is steady with the same hand (a stroke is never blank until pen-up)', () => {
    const frames = straight(60)
    // Tracker latches 0.3 away (same hand) for 4 frames, then stays offset by a small amount the resume test can't explain.
    for (let i = 10; i < 14; i++) frames[i] = { ...frames[i]!, q: { x: frames[i]!.q.x, y: 0.2 }, palm: { x: frames[i]!.q.x, y: 0.3 } }
    const { inked } = runGuard(frames)
    expect(inked.filter((i) => i >= 30).length).toBeGreaterThan(25)
  })

  it('keeps a nearby held frame at pen-up (the end of a quick stroke is not lost)', () => {
    const g = new ContinuityGuard<number>()
    const frames = straight(10, 0.3)
    const inked: number[] = []
    frames.forEach((f, i) => g.ink(f, i).forEach((o) => o.op === 'ink' && inked.push(o.item)))
    // A slightly surprising last frame, then the pen lifts.
    const last = frames.at(-1)!
    g.ink(mf(last.t + 33, last.q.x + 0.004, last.q.y + 0.012), 10).forEach((o) => o.op === 'ink' && inked.push(o.item))
    g.penUp().forEach((o) => o.op === 'ink' && inked.push(o.item))
    expect(inked).toContain(10)
  })

  it('treats a sudden palm-size change (another hand / re-detection) as an identity change', () => {
    const frames = straight(24)
    for (let i = 10; i < 14; i++) frames[i] = { ...frames[i]!, q: { x: frames[i]!.q.x + 0.05, y: 0.45 }, palm: { x: frames[i]!.q.x + 0.05, y: 0.6 }, size: 0.15 }
    const { inked } = runGuard(frames)
    for (let i = 10; i < 14; i++) expect(inked).not.toContain(i)
  })

  it('thresholds are distance-independent (palm widths): the same motion at half the size behaves the same', () => {
    const half = (f: MotionFrame): MotionFrame => ({ ...f, q: { x: f.q.x / 2, y: f.q.y / 2 }, palm: { x: f.palm.x / 2, y: f.palm.y / 2 }, size: f.size / 2 })
    const frames = straight(20)
    frames[10] = { ...frames[10]!, q: { x: frames[10]!.q.x, y: frames[10]!.q.y - 0.06 } }
    const a = runGuard(frames)
    const b = runGuard(frames.map(half))
    expect(b.inked).toEqual(a.inked)
  })
})

// ── Processor: mapping stability ───────────────────────────────────────────

describe('mapping stays fixed for a whole stroke (v0.1.5)', () => {
  const firstStrokeJump = (smartInk: boolean) => {
    // The first stroke starts ~0.5 s after the hand appears (before the 20-frame extent lock).
    const script = writeStrokes([{ path: line({ x: 0.35, y: 0.5 }, { x: 0.6, y: 0.5 }), duration: 1.2 }], { lead: 3 })
    const { trace } = synthesize(script, { seed: 3, noise: NO_NOISE })
    const r = replay(trace, { processor: { regionFit: 'hand', smartInk } })
    const s = r.strokes[0]!.points
    let jump = 0
    for (let i = 1; i < s.length; i++) jump = Math.max(jump, Math.hypot((s[i]!.x - s[i - 1]!.x) * 1600, (s[i]!.y - s[i - 1]!.y) * 1000))
    return jump
  }
  it('the first stroke of a session no longer jumps when the hand extent locks (v0.1.4: >150 px)', () => {
    expect(firstStrokeJump(false)).toBeGreaterThan(150)
    expect(firstStrokeJump(true)).toBeLessThan(25)
  })

  it('a calibration or writing-size change during a stroke takes effect at the next pen-up', () => {
    const script = writeStrokes([
      { path: line({ x: 0.35, y: 0.5 }, { x: 0.6, y: 0.5 }), duration: 1.5 },
      { path: line({ x: 0.35, y: 0.55 }, { x: 0.6, y: 0.55 }), duration: 1.5 }
    ])
    const { trace } = synthesize(script, { seed: 2, noise: NO_NOISE })
    const engine = new StrokeEngine()
    const p = new HandFrameProcessor(engine, REPLAY_PROCESSOR)
    const strokes: number[][] = []
    engine.onStrokeEnd((e) => strokes.push(e.stroke.points.map((q) => q.x)))
    let changed = false
    for (const f of trace.frames) {
      const o = p.process({ t: f.t, landmarks: unpackLandmarks(f.lm), world: unpackLandmarks(f.w ?? null), confidence: f.c, videoAspect: trace.videoAspect })
      if (!changed && o.gesture === 'writing' && engine.activeStroke && engine.activeStroke.points.length > 10) {
        p.configure({ writingSensitivity: 1.5 })
        changed = true
      }
    }
    p.reset(1e9)
    expect(changed).toBe(true)
    // First stroke: one gain throughout (steps stay small); second stroke: the new, larger gain.
    const steps = (xs: number[]) => xs.slice(1).map((x, i) => Math.abs(x - xs[i]!) * 1600)
    expect(Math.max(...steps(strokes[0]!))).toBeLessThan(25)
    const len = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
    expect(len(strokes[1]!) / len(strokes[0]!)).toBeGreaterThan(1.3)
  })

  it('a calibrated area keeps the page aspect ratio (x and y gain equal)', () => {
    const cal = { x0: 0.2, y0: 0.35, x1: 0.8, y1: 0.65 }
    const r = effectiveRegion({ ...REPLAY_PROCESSOR, region: cal }, 16 / 9, undefined, 1, true)
    expect(((r.x1 - r.x0) * (16 / 9)) / (r.y1 - r.y0)).toBeCloseTo(1.6, 6)
    // inside the calibrated rectangle, centred
    expect(r.x0).toBeGreaterThanOrEqual(cal.x0 - 1e-9)
    expect(r.x1).toBeLessThanOrEqual(cal.x1 + 1e-9)
    expect((r.x0 + r.x1) / 2).toBeCloseTo(0.5, 9)
    expect(fitAspect(cal, 16 / 9, 1.6)).toEqual(r)
  })

  it('a circle in a wide calibrated area stays round (v0.1.4 drew it ~2.4× taller than wide)', () => {
    const c = AB_CASES.find((x) => x.id === 'C1-calibrated-circle')!
    const mean = (p: 'v0.1.4' | 'v0.1.5') => [1, 2, 3].reduce((a, seed) => a + runAb(c, seed, p).metrics.aspect! / 3, 0)
    const old = mean('v0.1.4')
    const now = mean('v0.1.5')
    expect(old).toBeGreaterThan(1.8)
    expect(Math.abs(now - 1)).toBeLessThan(0.12)
  })
})

// ── A/B guarantees (synthetic) ─────────────────────────────────────────────

describe('A/B on identical synthetic traces (v0.1.4 vs v0.1.5)', () => {
  const sum = (ids: (c: (typeof AB_CASES)[number]) => boolean, k: 'strayPx' | 'strayLines' | 'missingPx' | 'lostStrokes') => {
    const out = { 'v0.1.4': 0, 'v0.1.5': 0 }
    for (const c of AB_CASES.filter(ids))
      for (const seed of [1, 2]) for (const p of ['v0.1.4', 'v0.1.5'] as const) out[p] += runAb(c, seed, p).metrics[k]
    return out
  }
  it('normal writing (the 12 required scenarios): no legitimate ink lost, no new stray ink', () => {
    const normal = (c: (typeof AB_CASES)[number]) => c.required !== null
    const miss = sum(normal, 'missingPx')
    const stray = sum(normal, 'strayPx')
    expect(miss['v0.1.5']).toBeLessThanOrEqual(miss['v0.1.4'] * 1.01 + 1)
    expect(stray['v0.1.5']).toBeLessThanOrEqual(stray['v0.1.4'] + 1)
    expect(sum(normal, 'lostStrokes')['v0.1.5']).toBeLessThanOrEqual(sum(normal, 'lostStrokes')['v0.1.4'])
  })
  it('adversarial traces: stray ink and stray lines cut by more than 60 %, for at most 15 % more missing ink', () => {
    const adv = (c: (typeof AB_CASES)[number]) => c.adversarial
    const stray = sum(adv, 'strayPx')
    const lines = sum(adv, 'strayLines')
    const miss = sum(adv, 'missingPx')
    expect(stray['v0.1.5']).toBeLessThan(0.4 * stray['v0.1.4'])
    expect(lines['v0.1.5']).toBeLessThan(0.4 * lines['v0.1.4'])
    expect(miss['v0.1.5']).toBeLessThan(1.15 * miss['v0.1.4'])
  })
})

// ── Guides, settings, trace v4 ─────────────────────────────────────────────

describe('guides, settings and trace v4', () => {
  const page = { width: 1600, height: 1000, background: '#fff' }
  it('line spacing changes the distance between lines, not the letter guides', () => {
    const a = guideLines(page, 1, 125, 1)
    const b = guideLines(page, 1, 125, 1.5)
    expect(Math.abs(b.pitch - a.pitch * 1.5)).toBeLessThanOrEqual(1)
    expect(b.xHeight).toBe(a.xHeight)
    expect(b.capHeight).toBe(a.capHeight)
    expect(guideLines(page, 1)).toEqual(a) // default unchanged from v0.1.4
  })
  it('new settings are sanitized and default safely', () => {
    expect(sanitizeSettings({}).strokeProtection).toBe(true)
    expect(sanitizeSettings({}).legacyPipeline).toBe(false)
    expect(sanitizeSettings({ lineSpacing: 9 }).lineSpacing).toBe(2)
    expect(DEFAULT_SETTINGS.lineSpacing).toBe(1)
  })
  it('records handedness, guard verdicts, glitch marks and metadata (v4), and replays them', () => {
    const rec = new TraceRecorder()
    rec.start()
    const lm = unpackLandmarks(packLandmarks(Array.from({ length: 21 }, (_, i) => ({ x: 0.5 + i * 0.001, y: 0.5, z: 0 }))))!
    rec.add(10, lm, 0.9, 16 / 9, { g: 'hold' }, null, 'Right')
    rec.mark(20)
    const t = parseTrace(JSON.parse(JSON.stringify(rec.stop(undefined, undefined, { participant: 'P01', session: 'P01-S1', consent: true }))))
    expect(t.version).toBe(4)
    expect(t.frames[0]!.h).toBe('Right')
    expect(t.frames[0]!.d?.g).toBe('hold')
    expect(t.events?.[0]).toMatchObject({ type: 'mark', label: 'tracking-error' })
    expect(t.meta?.participant).toBe('P01')
  })
})

// ── wisp-motion research tooling ───────────────────────────────────────────

describe('wisp-motion dataset tools', () => {
  const trace = (): LandmarkTrace => {
    setNoiseProfile('webcam')
    return { ...SCENARIOS.find((s) => s.id === 'A-slow-line')!.build(1).trace, version: 4, meta: { participant: 'P01', session: 'P01-S1', consent: true } }
  }
  it('validation accepts a clean trace and rejects video fields and backwards time', () => {
    const t = trace()
    expect(validateTrace(t, t).ok).toBe(true)
    const withVideo = { ...t, frames: [{ ...t.frames[0], image: 'data:image/png;base64,AAAA' }, ...t.frames.slice(1)] }
    expect(validateTrace(withVideo, t).errors.join()).toMatch(/image\/video/)
    const back = { ...t, frames: [...t.frames.slice(0, 5), { ...t.frames[5]!, t: 0 }, ...t.frames.slice(6)] }
    expect(validateTrace(back, back).ok).toBe(false)
    expect(validateTrace(t, { ...t, meta: undefined }).warnings.join()).toMatch(/participant/)
  })
  it('the manifest id depends on content only (not listing order) and changes when any file changes', () => {
    const e = (file: string, sha: string, participant: string): ManifestEntry => ({ file, sha256: sha, participant, session: `${participant}-S1`, task: null, frames: 100, durationMs: 3000, marks: 0 })
    const h = (s: string) => fnv(s)
    const a = buildManifest('x', 'synthetic', [e('a.json', '1', 'P1'), e('b.json', '2', 'P2')], h, 'now')
    const b = buildManifest('x', 'synthetic', [e('b.json', '2', 'P2'), e('a.json', '1', 'P1')], h, 'later')
    const c = buildManifest('x', 'synthetic', [e('a.json', '1', 'P1'), e('b.json', '3', 'P2')], h, 'now')
    expect(a.id).toBe(b.id)
    expect(a.id).not.toBe(c.id)
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}')
  })
  it('splits whole participants (no leakage) and says when that is impossible', () => {
    const items = syntheticDataset(6, 2, 1)
    const entries: ManifestEntry[] = items.map((s) => ({ file: s.file, sha256: '-', participant: s.participant, session: s.session, task: s.task, frames: s.trace.frames.length, durationMs: 0, marks: 0 }))
    const split = groupSplit(entries, { seed: 'test' })
    expect(split.participantIndependent).toBe(true)
    expect(checkLeakage(entries, split)).toEqual([])
    expect(split.test.length).toBeGreaterThan(0)
    // Splitting by session lets a participant land in train and test: the check catches it.
    const bySession = groupSplit(entries, { by: 'session', seed: 'x' })
    expect(bySession.participantIndependent).toBe(false)
    expect(checkLeakage(entries, bySession).some((p) => p.startsWith('participant'))).toBe(true)
    expect(groupSplit(entries.filter((e) => e.participant === 'SYN-P01')).warnings.join()).toMatch(/only 1 group|no held-out/)
  })
  it('features have a fixed length per frame and use only tracker output', () => {
    const t = trace()
    const f = extractFeatures(t)
    expect(f.rows).toHaveLength(t.frames.length)
    for (const r of f.rows) expect(r).toHaveLength(FEATURE_NAMES.length)
    expect(f.rows.every((r) => r.every(Number.isFinite))).toBe(true)
  })
  it('labels: marks become weak spans, sidecars are validated, unsure frames are excluded', () => {
    const t = { ...trace(), events: [{ t: 2000, type: 'mark' as const }] }
    const spans = marksToAnnotations(t)
    expect(spans[0]).toMatchObject({ t0: 500, t1: 2000, source: 'mark', label: 'tracking-error' })
    const labels = frameLabels(t, [...spans, { t0: 1900, t1: 2000, label: 'unsure', source: 'manual' }])
    expect(labels.some((v) => v === null)).toBe(true)
    expect(validateAnnotations({ format: 'wisp.motion.annotations', version: 1, trace: 'x', annotations: [{ t0: 5, t1: 1, label: 'x', source: 'mark' }] }, t).length).toBeGreaterThan(0)
  })
  it('synthetic Task A baselines: the continuity guard finds more injected faults than the v0.1.4 gate', () => {
    const items = syntheticDataset(2, 1, 4).map((s) => ({ trace: s.trace, labels: frameLabels(s.trace, faultAnnotations(s.faults)) }))
    const gate = scoreDetection(items, DETECTORS['gate-v0.1.4']!)
    const guard = scoreDetection(items, DETECTORS['guard-v0.1.5']!)
    expect(guard.eventRecall).toBeGreaterThan(gate.eventRecall)
    expect(guard.f1).toBeGreaterThan(gate.f1)
  })
  it('fault injection is reproducible and labels exactly the corrupted frames', () => {
    const t = trace()
    const a = injectFaults(t, 7, 3)
    const b = injectFaults(t, 7, 3)
    expect(a.faults).toEqual(b.faults)
    for (const f of a.faults) for (const i of f.frames) expect(a.trace.frames[i]!.lm).not.toEqual(t.frames[i]!.lm)
  })
})

describe('Smart Ink keeps webcam noise from becoming false alarms', () => {
  it('no strokes are split by the guard in the clean writing scenarios (both noise profiles)', () => {
    for (const profile of ['model', 'webcam'] as const) {
      setNoiseProfile(profile)
      for (const id of ['A-slow-line', 'A3-fast-line', 'B-hello', 'C-math', 'F3-dashes', 'S3-hello-3x', 'O3-toward', 'O4-sideways']) {
        const { trace } = SCENARIOS.find((s) => s.id === id)!.build(2)
        const engine = new StrokeEngine()
        const p = new HandFrameProcessor(engine, REPLAY_PROCESSOR)
        for (const f of trace.frames) p.process({ t: f.t, landmarks: unpackLandmarks(f.lm), world: unpackLandmarks(f.w ?? null), confidence: f.c, videoAspect: trace.videoAspect })
        expect(p.guard.stats.splits, `${profile} ${id}`).toBe(0)
        expect(p.guard.stats.suspends, `${profile} ${id}`).toBe(0)
      }
    }
    setNoiseProfile('model')
    void WEBCAM_NOISE
  })
})
