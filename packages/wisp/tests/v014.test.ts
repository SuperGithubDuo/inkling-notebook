/**
 * WISP v0.1.4: canvas boundary reach, stable writing plane, writing scale,
 * guides, reversible line tidying, notation preservation. Synthetic only.
 */
import { describe, expect, it } from 'vitest'
import { cameraToPage, fitPage, pageToScreen, screenToPage } from '../src/strokes/coordinates'
import { ExtentTracker, PRIOR_EXTENT, ScaleTracker, handImageScale, measureExtent, safeRegion, zoomAboutCentre } from '../src/strokes/writingPlane'
import { cameraHand, imageLandmarks, project, worldLandmarks, VIDEO_ASPECT, type Orientation } from '../src/replay/hand3d'
import { HandFrameProcessor } from '../src/input/handFrameProcessor'
import { StrokeEngine } from '../src/strokes/strokeEngine'
import { REPLAY_PROCESSOR } from '../src/replay/replay'
import { boundaryReport } from '../src/replay/boundary'
import { LAYOUT_CONFIGS, buildScene, fittedRegion, layoutMetrics, notationError, placeScene, replayLayout, WEBCAM_NOISE } from '../src/replay/layout'
import { LAYOUT_SCENES } from '../src/replay/layoutScenes'
import { estimateBaseline, groupLines, guideLines, restoreOriginal, tidyLines } from '../src/strokes/layout'
import { parseDocument, serializeDocument } from '../src/strokes/serialization'
import { createDocument, type Stroke } from '../src/strokes/types'
import { DEFAULT_SETTINGS, sanitizeSettings, scalePreset } from '../src/core/settings'
import { unpackLandmarks } from '../src/replay/trace'
import { synthesize, NO_NOISE } from '../src/replay/synth'

const PAGE = { width: 1600, height: 1000, background: '#ffffff' }
const FACING: Orientation = { pitch: 0, yaw: 0, roll: 0 }
const hand = (x: number, y: number, depth = 0.45, o: Orientation = FACING, gap = 0.75) => cameraHand({ pen: { x, y }, depth, gap, mover: 'index', orientation: o })

describe('canvas boundary: coordinates', () => {
  it('the writing region maps exactly onto [0, 1] on both axes, and beyond it clamps to the edge', () => {
    const m = { mirror: false, region: { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.7 } }
    expect(cameraToPage({ x: 0.2, y: 0.1 }, m)).toMatchObject({ x: 0, y: 0, clamped: false })
    expect(cameraToPage({ x: 0.8, y: 0.7 }, m)).toMatchObject({ x: 1, y: 1, clamped: false })
    expect(cameraToPage({ x: 0.95, y: 0.9 }, m)).toMatchObject({ x: 1, y: 1, clamped: true })
  })

  it('page ↔ screen round-trips at every size and keeps the page aspect (resizing)', () => {
    for (const [w, h] of [[1200, 800], [640, 900], [1920, 1080], [333, 271]] as const) {
      const f = fitPage(w, h, 1600, 1000, 28)
      expect(f.width / f.height).toBeCloseTo(1.6, 6)
      for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0.37, y: 0.81 }]) {
        const s = pageToScreen(p, f)
        expect(s.x).toBeGreaterThanOrEqual(0)
        expect(s.y).toBeGreaterThanOrEqual(0)
        expect(s.x).toBeLessThanOrEqual(w)
        expect(s.y).toBeLessThanOrEqual(h)
        const q = screenToPage(s, f)
        expect(q.x).toBeCloseTo(p.x, 9)
        expect(q.y).toBeCloseTo(p.y, 9)
      }
      // The pointer in the margin outside the page still reaches the page edge.
      expect(screenToPage({ x: 0, y: 0 }, f)).toMatchObject({ x: 0, y: 0 })
      expect(screenToPage({ x: w, y: h }, f)).toMatchObject({ x: 1, y: 1 })
    }
  })

  it('a stroke drawn along an edge stays on the page after refinement, so its export re-imports', () => {
    const e = new StrokeEngine()
    let done: Stroke | null = null
    e.onStrokeEnd((ev) => (done = ev.stroke))
    let s = 3
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.004
    for (let i = 0; i < 60; i++) e.input({ x: Math.min(1, 0.2 + i * 0.012 + rnd()), y: Math.min(1, 0.96 + i * 0.004 + rnd()), t: i * 33, confidence: 1, source: 'webcam' }, true)
    e.end('released')
    expect(done).not.toBeNull()
    for (const p of done!.points) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeLessThanOrEqual(1)
    }
    expect(Math.max(...done!.points.map((p) => p.y))).toBe(1)
    const doc = { ...createDocument(), strokes: [done!] }
    expect(parseDocument(serializeDocument(doc)).ok).toBe(true)
  })
})

describe('canvas boundary: the hand must stay in the camera frame', () => {
  it('the fitted region keeps the palm inside the frame at every page edge and corner', () => {
    const lm = imageLandmarks(hand(0.5, 0.35))
    const pen = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 }
    const e = measureExtent(lm, pen, false)!
    const r = safeRegion(e, VIDEO_ASPECT, 1.6)
    expect(((r.x1 - r.x0) * VIDEO_ASPECT) / (r.y1 - r.y0)).toBeCloseTo(1.6, 6)
    for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]] as const) {
      expect(x - e.left).toBeGreaterThanOrEqual(0.03 - 1e-9)
      expect(x + e.right).toBeLessThanOrEqual(0.97 + 1e-9)
      expect(y - e.up).toBeGreaterThanOrEqual(0.03 - 1e-9)
      expect(y + e.down).toBeLessThanOrEqual(0.97 + 1e-9)
    }
  })

  it('mirroring swaps the left and right extent', () => {
    const lm = imageLandmarks(hand(0.5, 0.35))
    const pen = { x: (lm[4]!.x + lm[8]!.x) / 2, y: (lm[4]!.y + lm[8]!.y) / 2 }
    const a = measureExtent(lm, pen, false)!
    const b = measureExtent(lm, pen, true)!
    expect(b.left).toBeCloseTo(a.right, 9)
    expect(b.right).toBeCloseTo(a.left, 9)
  })

  it('every edge and all four corners are reachable (v0.1.3 could not reach the bottom edge)', () => {
    const res = boundaryReport(2, WEBCAM_NOISE)
    const old = res.find((r) => r.config.startsWith('v0.1.3'))!
    const now = res.find((r) => r.config.startsWith('Natural'))!
    const assist = res.find((r) => r.config.startsWith('Writing Assist'))!
    expect(old.bottom).toBeGreaterThan(50) // the reported bug, reproduced
    for (const r of [now, assist]) {
      for (const k of ['top', 'bottom', 'left', 'right'] as const) expect(r[k]).toBeLessThan(2)
      expect(r.corners).toBe(4)
    }
  })
})

describe('stable writing plane', () => {
  it('the hand extent locks after 20 hover frames, or at the first pen-down, and then never changes', () => {
    const t = new ExtentTracker()
    expect(t.extent).toEqual(PRIOR_EXTENT)
    for (let i = 0; i < 19; i++) expect(t.add({ up: 0, down: 0.3, left: 0.1, right: 0 })).toBe(false)
    expect(t.add({ up: 0, down: 0.3, left: 0.1, right: 0 })).toBe(true)
    const locked = { ...t.extent }
    t.add({ up: 0.5, down: 0.5, left: 0.5, right: 0.5 })
    expect(t.extent).toEqual(locked)
    const u = new ExtentTracker()
    u.lockNow()
    expect(u.extent).toEqual(PRIOR_EXTENT)
  })

  it('the mapping does not change once writing has started', () => {
    const proc = new HandFrameProcessor(new StrokeEngine(), { ...REPLAY_PROCESSOR, regionFit: 'hand' })
    const script = [
      ...Array.from({ length: 6 }, () => ({ pen: { x: 0.5, y: 0.45 }, gap: 0.75, intendInk: false, mover: 'index' as const })),
      ...Array.from({ length: 4 }, (_, i) => ({ pen: { x: 0.5, y: 0.45 }, gap: 0.75 - i * 0.15, intendInk: false, mover: 'index' as const })),
      ...Array.from({ length: 40 }, (_, i) => ({ pen: { x: 0.5 + i * 0.002, y: 0.45 }, gap: 0.16, intendInk: true, mover: 'index' as const })),
      ...Array.from({ length: 30 }, () => ({ pen: { x: 0.6, y: 0.45 }, gap: 0.75, intendInk: false, mover: 'index' as const }))
    ]
    const { trace } = synthesize(script, { noise: NO_NOISE })
    let region: string | null = null
    let changedWhileWriting = false
    let wrote = false
    for (const f of trace.frames) {
      proc.process({ t: f.t, landmarks: unpackLandmarks(f.lm), world: unpackLandmarks(f.w ?? null), confidence: f.c, videoAspect: trace.videoAspect })
      const r = JSON.stringify(proc.region(trace.videoAspect))
      if (proc.gestures.isWriting) wrote = true
      if (wrote && region !== null && r !== region) changedWhileWriting = true
      if (wrote) region ??= r
    }
    expect(wrote).toBe(true)
    expect(changedWhileWriting).toBe(false)
  })

  it('hand image scale ∝ 1 / distance and barely depends on orientation', () => {
    const at = (d: number, o: Orientation = FACING) => {
      const c = hand(0.45, 0.4, d, o, 0.1)
      return handImageScale(imageLandmarks(c), worldLandmarks(c), VIDEO_ASPECT)! * d
    }
    const ref = at(0.45)
    for (const d of [0.35, 0.6]) expect(Math.abs(at(d) / ref - 1)).toBeLessThan(0.01)
    for (const o of [{ pitch: 0, yaw: 45, roll: 0 }, { pitch: -35, yaw: 0, roll: 0 }, { pitch: 0, yaw: 0, roll: 30 }]) expect(Math.abs(at(0.45, o) / ref - 1)).toBeLessThan(0.05)
    expect(handImageScale(imageLandmarks(hand(0.5, 0.4)), null, VIDEO_ASPECT)).toBeNull()
  })

  it('zooming about the camera centre keeps a physical point on the same page point at any distance', () => {
    const region = { x0: 0.3, y0: 0.05, x1: 0.8, y1: 0.6 }
    const X = 0.03, Y = -0.04
    const p45 = project([X, Y, 0.45]), p35 = project([X, Y, 0.35])
    const a = cameraToPage(p45, { mirror: false, region })!
    const b = cameraToPage(p35, { mirror: false, region: zoomAboutCentre(region, 0.45 / 0.35) })!
    expect(b.x).toBeCloseTo(a.x, 9)
    expect(b.y).toBeCloseTo(a.y, 9)
  })

  it('the scale is frozen while the pen is down, rate-limited, and held while the hand is turned', () => {
    const s = new ScaleTracker()
    const n: [number, number, number] = [0, 0, -1]
    for (let t = 0; t < 2000; t += 33) s.add(t, 1, false, n)
    s.setReference()
    expect(s.factor).toBeCloseTo(1, 6)
    for (let t = 2000; t < 3000; t += 33) s.add(t, 1.3, true, n) // pen down
    expect(s.factor).toBeCloseTo(1, 6)
    s.add(3033, 1.3, false, n)
    s.add(3066, 1.3, false, n)
    expect(s.factor).toBeLessThan(1 + 0.6 * 0.07) // at most 0.6/s
    const turned: [number, number, number] = [Math.sin(0.6), 0, -Math.cos(0.6)] // 34°
    const t2 = new ScaleTracker()
    for (let t = 0; t < 1000; t += 33) t2.add(t, 1, false, n)
    t2.setReference()
    for (let t = 1000; t < 4000; t += 33) t2.add(t, 1.2, false, turned)
    expect(t2.factor).toBeLessThan(1.05)
    expect(t2.skipped).toBeGreaterThan(50)
  })
})

const run = (id: string, cfg: string, seed: number) => {
  const def = LAYOUT_SCENES.find((d) => d.scene.id === id)!
  const c = LAYOUT_CONFIGS[cfg]!
  const { trace, tags } = buildScene(placeScene(def.scene, fittedRegion(c, seed, WEBCAM_NOISE)), seed, WEBCAM_NOISE)
  const r = replayLayout(trace, c)
  return { def, r, tags }
}

describe('writing size consistency (layout scenes, modelled webcam noise)', () => {
  it('Writing Assist keeps letter size steady when writing at 37–56 cm (size spread at most half of Natural)', () => {
    let nat = 0, as = 0
    for (const seed of [1, 2, 3]) {
      const a = run('LA-distance', 'Natural (v0.1.4)', seed)
      const b = run('LA-distance', 'Writing Assist', seed)
      nat += layoutMetrics(a.r, a.r.strokes, a.tags, a.def.lineOf).sizeCV
      as += layoutMetrics(b.r, b.r.strokes, b.tags, b.def.lineOf).sizeCV
    }
    expect(as).toBeLessThan(nat * 0.5)
  })

  it('turning the hand does not change the size or position of writing in Writing Assist', () => {
    let nat = 0, as = 0
    for (const seed of [1, 2, 3]) {
      const a = run('LC-turn', 'Natural (v0.1.4)', seed)
      const b = run('LC-turn', 'Writing Assist', seed)
      const ma = layoutMetrics(a.r, a.r.strokes, a.tags, a.def.lineOf)
      const mb = layoutMetrics(b.r, b.r.strokes, b.tags, b.def.lineOf)
      nat += ma.baselineRMS + ma.sizeCV
      as += mb.baselineRMS + mb.sizeCV
    }
    expect(as).toBeLessThan(nat * 1.2 + 1)
  })
})

describe('reversible line tidying', () => {
  const tilted = (deg: number): Stroke[] => {
    // Six "letters" (vertical ticks and small arcs) along a tilted baseline, plus one superscript.
    const th = (deg * Math.PI) / 180
    const P = (x: number, y: number) => ({ x: (300 + x * Math.cos(th) - y * Math.sin(th)) / 1600, y: (500 + x * Math.sin(th) + y * Math.cos(th)) / 1000, t: 0 })
    const strokes: Stroke[] = []
    for (let k = 0; k < 6; k++) {
      const x = k * 80
      const pts = Array.from({ length: 12 }, (_, i) => P(x + 10 * Math.sin((i / 11) * Math.PI), -60 + (60 * i) / 11))
      strokes.push({ id: `s${k}`, points: pts.map((p, i) => ({ ...p, t: k * 1000 + i * 30 })), color: '#000000', width: 4, source: 'webcam', startedAt: k * 1000, endedAt: k * 1000 + 330 })
    }
    const sup = Array.from({ length: 8 }, (_, i) => P(500 + i * 3, -110 + i * 4))
    strokes.push({ id: 'sup', points: sup.map((p, i) => ({ ...p, t: 7000 + i * 30 })), color: '#000000', width: 4, source: 'webcam', startedAt: 7000, endedAt: 7210 })
    return strokes
  }
  const dists = (s: Stroke[]) => {
    const pts = s.flatMap((k) => k.points.map((p) => [p.x * 1600, p.y * 1000]))
    return pts.flatMap((a, i) => pts.slice(i + 1, i + 40).map((b) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)))
  }

  it('straightens a tilted line as one rigid piece: every distance (letter size, superscript offset) is kept', () => {
    const s = tilted(5)
    const base = estimateBaseline(s, PAGE)!
    expect((Math.atan(base.slope) * 180) / Math.PI).toBeCloseTo(5, 0)
    const { strokes, report } = tidyLines(s, PAGE)
    expect(report.straightened).toBe(1)
    const after = estimateBaseline(strokes, PAGE)!
    expect(Math.abs((Math.atan(after.slope) * 180) / Math.PI)).toBeLessThan(0.2)
    const d0 = dists(s), d1 = dists(strokes)
    d0.forEach((d, i) => expect(d1[i]).toBeCloseTo(d, 6))
  })

  it('leaves level lines and large (intentional) tilts alone', () => {
    expect(tidyLines(tilted(0.5), PAGE).report.straightened).toBe(0)
    expect(tidyLines(tilted(20), PAGE).report.straightened).toBe(0)
  })

  it('Restore original puts every point back exactly, and the transform survives export/import', () => {
    const s = tilted(4)
    const { strokes } = tidyLines(s, PAGE)
    const doc = { ...createDocument(), strokes }
    const back = parseDocument(serializeDocument(doc))
    expect(back.ok).toBe(true)
    const restored = restoreOriginal(back.ok ? back.doc.strokes : [], PAGE)
    restored.forEach((k, i) => {
      expect(k.assist).toBeUndefined()
      k.points.forEach((p, j) => {
        expect(p.x).toBeCloseTo(s[i]!.points[j]!.x, 5)
        expect(p.y).toBeCloseTo(s[i]!.points[j]!.y, 5)
      })
    })
  })

  it('strokes without the assist field serialize exactly as before (format unchanged)', () => {
    const s = tilted(0)
    const json = JSON.parse(serializeDocument({ ...createDocument(), strokes: s }))
    expect(json.version).toBe(1)
    expect(Object.keys(json.strokes[0]).sort()).toEqual(['color', 'endedAt', 'id', 'points', 'source', 'startedAt', 'width'])
  })

  it('rejects a broken assist transform on import', () => {
    const json = JSON.parse(serializeDocument({ ...createDocument(), strokes: tilted(0) }))
    json.strokes[0].assist = { a: 0, b: 0, tx: 0, ty: 0 }
    expect(parseDocument(JSON.stringify(json)).ok).toBe(false)
  })

  it('a line of maths stays one line, and tidying never changes the notation geometry', () => {
    for (const seed of [1, 2, 3]) {
      const { r, tags } = run('LE-math', 'Writing Assist', seed)
      expect(groupLines(r.strokes, PAGE).length).toBeLessThanOrEqual(2)
      const before = notationError(r.strokes, tags)
      const after = notationError(tidyLines(r.strokes, PAGE).strokes, tags)
      expect(Math.abs(after.sizeErr - before.sizeErr)).toBeLessThan(0.01)
      expect(Math.abs(after.offsetErr - before.offsetErr)).toBeLessThan(0.01)
    }
  })

  it('straightens lines tilted by a sinking arm (layout scene)', () => {
    let before = 0, after = 0
    for (const seed of [1, 2, 3]) {
      const { def, r, tags } = run('LD-drift', 'Writing Assist', seed)
      before += layoutMetrics(r, r.strokes, tags, def.lineOf).lineTiltDeg
      after += layoutMetrics(r, tidyLines(r.strokes, PAGE).strokes, tags, def.lineOf).lineTiltDeg
    }
    expect(after).toBeLessThan(before * 0.3)
  })
})

describe('guides and settings', () => {
  it('guide spacing follows the writing size', () => {
    const m = guideLines(PAGE, 1)
    const l = guideLines(PAGE, 1.25)
    expect(l.pitch / m.pitch).toBeCloseTo(1.25, 1)
    expect(m.xHeight).toBeLessThan(m.capHeight)
    expect(m.baselines.every((b) => b > m.capHeight && b < PAGE.height)).toBe(true)
  })

  it('new settings default to Natural Writing with guides off, and are validated', () => {
    expect(DEFAULT_SETTINGS.writingMode).toBe('natural')
    expect(DEFAULT_SETTINGS.showGuides).toBe(false)
    expect(sanitizeSettings({ writingMode: 'assist' }).writingMode).toBe('assist')
    expect(sanitizeSettings({ writingMode: 'x' }).writingMode).toBe('natural')
    expect(scalePreset(0.8)).toBe('small')
    expect(scalePreset(1)).toBe('medium')
    expect(scalePreset(1.25)).toBe('large')
    expect(scalePreset(1.1)).toBe('custom')
  })
})
