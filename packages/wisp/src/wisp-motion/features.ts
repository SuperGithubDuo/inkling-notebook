/**
 * wisp-motion features: one fixed-length vector per camera frame, computed
 * only from what the tracker reports (landmarks, world landmarks,
 * handedness, timestamps). Never from WISP's own output, so a model trained
 * on them can't simply learn to imitate the current pipeline.
 *
 * Units: positions in PALM WIDTHS relative to the palm centroid, or frame
 * widths for absolute positions; velocities per second; so features mean the
 * same at any distance and frame rate.
 */
import { LM, handPose, palmSize, pinchRatio, pinchRatio3D, validLandmarks, type Landmark } from '../tracking/landmarks'
import { unpackLandmarks, type LandmarkTrace } from '../replay/trace'

export const FEATURE_NAMES = [
  'present', // 1 if a hand was tracked this frame
  'dt', // seconds since the previous frame
  'gap', // seconds since the previous frame WITH a hand
  'conf', // tracker confidence
  'penX', 'penY', // pen point (thumb–index midpoint), frame widths, view-independent (not mirrored)
  'vX', 'vY', // pen velocity, palm widths / s
  'aX', 'aY', // pen acceleration, palm widths / s²
  'relX', 'relY', // pen relative to palm centroid, palm widths
  'dRel', // change of rel since the previous tracked frame, palm widths
  'palm', // palm size, frame widths
  'dLogPalm', // change of log palm size since the previous tracked frame
  'palmVX', 'palmVY', // palm centroid velocity, palm widths / s
  'pinch2d', 'pinch3d', // pinch ratios (null → -1)
  'nX', 'nY', 'nZ', // palm normal (world landmarks; 0 if missing)
  'turnDeg', // palm normal change since the previous tracked frame, degrees
  'handFlip', // handedness label changed since the previous tracked frame
  'tipSpread' // thumb–index tip distance, palm widths (occlusion / grip)
] as const

export type FeatureName = (typeof FEATURE_NAMES)[number]

export interface FeatureTable {
  names: readonly FeatureName[]
  t: number[]
  rows: number[][]
}

const PALM_IDX = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const

interface Prev {
  t: number
  pen: { x: number; y: number }
  palmC: { x: number; y: number }
  rel: { x: number; y: number }
  v: { x: number; y: number }
  palm: number
  n: [number, number, number] | null
  hand: string | null
}

export function extractFeatures(trace: LandmarkTrace): FeatureTable {
  const ar = trace.videoAspect > 0 ? trace.videoAspect : 16 / 9
  const iso = (p: Landmark) => ({ x: p.x, y: p.y / ar })
  const rows: number[][] = []
  const ts: number[] = []
  let prevT: number | null = null
  let prev: Prev | null = null
  for (const f of trace.frames) {
    const dt = prevT === null ? 0 : Math.max(0, (f.t - prevT) / 1000)
    prevT = f.t
    ts.push(f.t)
    const lm = unpackLandmarks(f.lm)
    if (!validLandmarks(lm)) {
      rows.push(FEATURE_NAMES.map((n) => (n === 'dt' ? dt : n === 'gap' && prev ? (f.t - prev.t) / 1000 : n === 'pinch2d' || n === 'pinch3d' ? -1 : 0)))
      continue
    }
    const w = unpackLandmarks(f.w ?? null)
    const P = Math.max(1e-3, palmSize(lm, ar))
    const th = iso(lm[LM.THUMB_TIP]!)
    const ix = iso(lm[LM.INDEX_TIP]!)
    const pen = { x: (th.x + ix.x) / 2, y: (th.y + ix.y) / 2 }
    let cx = 0, cy = 0
    for (const i of PALM_IDX) {
      const q = iso(lm[i]!)
      cx += q.x / PALM_IDX.length
      cy += q.y / PALM_IDX.length
    }
    const rel = { x: (pen.x - cx) / P, y: (pen.y - cy) / P }
    const pose = handPose(w)
    const n = pose?.normal ?? null
    const gap = prev ? Math.max(1e-3, (f.t - prev.t) / 1000) : 0
    const v: { x: number; y: number } = prev ? { x: (pen.x - prev.pen.x) / P / gap, y: (pen.y - prev.pen.y) / P / gap } : { x: 0, y: 0 }
    const a = prev ? { x: (v.x - prev.v.x) / gap, y: (v.y - prev.v.y) / gap } : { x: 0, y: 0 }
    const palmV = prev ? { x: (cx - prev.palmC.x) / P / gap, y: (cy - prev.palmC.y) / P / gap } : { x: 0, y: 0 }
    let turn = 0
    if (prev?.n && n) turn = (Math.acos(Math.max(-1, Math.min(1, prev.n[0] * n[0] + prev.n[1] * n[1] + prev.n[2] * n[2]))) * 180) / Math.PI
    const hand = f.h ?? null
    const values: Record<FeatureName, number> = {
      present: 1,
      dt,
      gap,
      conf: f.c,
      penX: pen.x,
      penY: pen.y,
      vX: v.x,
      vY: v.y,
      aX: a.x,
      aY: a.y,
      relX: rel.x,
      relY: rel.y,
      dRel: prev ? Math.hypot(rel.x - prev.rel.x, rel.y - prev.rel.y) : 0,
      palm: P,
      dLogPalm: prev ? Math.log(P / prev.palm) : 0,
      palmVX: palmV.x,
      palmVY: palmV.y,
      pinch2d: pinchRatio(lm, ar) ?? -1,
      pinch3d: pinchRatio3D(w) ?? -1,
      nX: n?.[0] ?? 0,
      nY: n?.[1] ?? 0,
      nZ: n?.[2] ?? 0,
      turnDeg: turn,
      handFlip: prev && prev.hand && hand && prev.hand !== hand ? 1 : 0,
      tipSpread: Math.hypot(th.x - ix.x, th.y - ix.y) / P
    }
    rows.push(FEATURE_NAMES.map((k) => (Number.isFinite(values[k]) ? values[k] : 0)))
    prev = { t: f.t, pen, palmC: { x: cx, y: cy }, rel, v, palm: P, n, hand }
  }
  return { names: FEATURE_NAMES, t: ts, rows }
}

/** CSV (header + one row per frame), for inspection in a spreadsheet or notebook. */
export function featuresToCsv(table: FeatureTable, labels?: ReadonlyArray<0 | 1 | null>): string {
  const head = ['t', ...table.names, ...(labels ? ['label'] : [])].join(',')
  const lines = table.rows.map((r, i) => [table.t[i]!, ...r.map((v) => +v.toFixed(6)), ...(labels ? [labels[i] ?? ''] : [])].join(','))
  return [head, ...lines].join('\n')
}
