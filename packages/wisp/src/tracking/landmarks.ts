/**
 * Hand landmark helpers. Indices follow MediaPipe's 21-point hand model.
 * Pure functions: no MediaPipe import, so they are unit-testable.
 */

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17
} as const

/** Same shape as MediaPipe's NormalizedLandmark (x, y in [0,1] of the frame; z relative depth ≈ x scale). */
export interface Landmark {
  x: number
  y: number
  z: number
}

/** Pairs to draw for the skeleton overlay (copied from MediaPipe's HAND_CONNECTIONS). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

/**
 * Distance between two landmarks in units of frame WIDTH, so x and y count
 * equally on non-square video (y is scaled by height/width). z is already
 * roughly in x units per MediaPipe's documentation; `zWeight` lets callers
 * damp its noise.
 */
export function landmarkDistance(a: Landmark, b: Landmark, videoAspect: number, zWeight = 0.5): number {
  const ar = videoAspect > 0 ? videoAspect : 1
  const dx = a.x - b.x
  const dy = (a.y - b.y) / ar
  const dz = (a.z - b.z) * zWeight
  return Math.hypot(dx, dy, dz)
}

/**
 * Apparent hand size: the mean side of the palm triangle (wrist, index MCP,
 * pinky MCP). Palm landmarks barely move when fingers bend, so this tracks
 * distance from the camera without being affected by the pinch itself.
 */
export function palmSize(lm: readonly Landmark[], videoAspect: number): number {
  const w = lm[LM.WRIST]
  const i = lm[LM.INDEX_MCP]
  const p = lm[LM.PINKY_MCP]
  if (!w || !i || !p) return 0
  return (landmarkDistance(w, i, videoAspect) + landmarkDistance(w, p, videoAspect) + landmarkDistance(i, p, videoAspect)) / 3
}

/**
 * Thumb–index tip distance divided by palm size. Scale-invariant: the same
 * gesture gives the same ratio near or far from the camera. Returns null
 * when the landmarks are missing or degenerate.
 */
/**
 * Weight of MediaPipe's depth (z) in the thumb–index distance. z is the
 * least reliable landmark coordinate, and fingertip z is especially noisy
 * while the thumb hides the index tip. v0.1/v0.1.1 used 0.5; see README.
 */
export const DEFAULT_DEPTH_WEIGHT = 0.25

export function pinchRatio(lm: readonly Landmark[], videoAspect: number, depthWeight = DEFAULT_DEPTH_WEIGHT): number | null {
  if (lm.length < 21) return null
  const thumb = lm[LM.THUMB_TIP]!
  const index = lm[LM.INDEX_TIP]!
  const palm = palmSize(lm, videoAspect)
  if (!(palm > 1e-4)) return null
  const r = landmarkDistance(thumb, index, videoAspect, depthWeight) / palm
  return Number.isFinite(r) ? r : null
}

/** Validates that a landmark list has 21 finite points. */
export function validLandmarks(lm: readonly Landmark[] | undefined | null): lm is Landmark[] {
  if (!lm || lm.length < 21) return false
  for (const p of lm) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  }
  return true
}

// ── 3D (world landmarks), v0.1.3 ──────────────────────────────────────────
//
// MediaPipe's world landmarks are metres in a frame whose ORIGIN is the
// hand's approximate geometric centre and whose axes are aligned with the
// camera (x right, y down, z away from the camera; "smaller z = closer").
// They therefore carry the hand's SHAPE and ORIENTATION but not its position
// in the room: the pen position must still come from the image landmarks.
// The 3D shape is a model estimate, not a measurement; it is most useful
// exactly where the 2D projection fails (fingers pointing at the camera,
// palm edge-on), because there the thumb and index tips overlap in the image.

const d3 = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Mean side of the wrist / index-MCP / pinky-MCP triangle, in metres. */
export function palmSize3D(w: readonly Landmark[]): number {
  const a = w[LM.WRIST], i = w[LM.INDEX_MCP], p = w[LM.PINKY_MCP]
  if (!a || !i || !p) return 0
  return (d3(a, i) + d3(a, p) + d3(i, p)) / 3
}

/**
 * Thumb–index tip distance ÷ 3D palm size. Unlike the 2D ratio it does not
 * shrink when the fingers point toward the camera or the hand is turned
 * sideways (foreshortening). Null when the world landmarks are unusable
 * (missing, or a palm outside 3–20 cm, which no real hand has).
 */
export function pinchRatio3D(w: readonly Landmark[] | null | undefined): number | null {
  if (!w || w.length < 21) return null
  for (const p of w) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  const palm = palmSize3D(w)
  if (!(palm > 0.03 && palm < 0.2)) return null
  const r = d3(w[LM.THUMB_TIP]!, w[LM.INDEX_TIP]!) / palm
  return Number.isFinite(r) ? r : null
}

export type TrackingQuality = 'good' | 'reduced' | 'poor'

export interface HandPose {
  /** Unit palm normal (camera axes), pointing out of the palm. */
  normal: [number, number, number]
  /** Unit direction wrist → middle-finger MCP (camera axes). */
  finger: [number, number, number]
  /** 0 = fingers across the image, 1 = fingers pointing straight along the camera axis. */
  along: number
  /** 0 = palm (or back of hand) faces the camera, 1 = palm seen edge-on. */
  edgeOn: number
  quality: TrackingQuality
}

/**
 * Hand orientation from world landmarks, using the hand-local frame
 * (wrist, index MCP, middle MCP, pinky MCP). Quality is about how well a
 * single camera can see the thumb–index gap in this orientation:
 *   good     – the fingers lie roughly across the image;
 *   reduced  – fingers tipped toward the camera (> ~45°) or palm near edge-on;
 *   poor     – fingers almost along the camera axis (> ~65°): the tips overlap
 *              in the image and both 2D and 3D estimates are guesses.
 */
export function handPose(w: readonly Landmark[] | null | undefined): HandPose | null {
  if (!w || w.length < 21) return null
  const W = w[LM.WRIST]!, I = w[LM.INDEX_MCP]!, M = w[LM.MIDDLE_MCP]!, P = w[LM.PINKY_MCP]!
  const f = [M.x - W.x, M.y - W.y, M.z - W.z]
  const a = [I.x - P.x, I.y - P.y, I.z - P.z] // across the knuckles
  const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
  if (!(fl > 1e-4)) return null
  const finger: [number, number, number] = [f[0]! / fl, f[1]! / fl, f[2]! / fl]
  const n = [f[1]! * a[2]! - f[2]! * a[1]!, f[2]! * a[0]! - f[0]! * a[2]!, f[0]! * a[1]! - f[1]! * a[0]!]
  const nl = Math.hypot(n[0]!, n[1]!, n[2]!)
  if (!(nl > 1e-6)) return null
  const normal: [number, number, number] = [n[0]! / nl, n[1]! / nl, n[2]! / nl]
  const along = Math.abs(finger[2])
  const edgeOn = 1 - Math.abs(normal[2])
  const quality: TrackingQuality = along > 0.9 ? 'poor' : along > 0.7 || edgeOn > 0.9 ? 'reduced' : 'good'
  return { normal, finger, along, edgeOn, quality }
}
