/**
 * Hand landmark helpers. Indices follow MediaPipe's 21-point hand model.
 * Pure functions: no MediaPipe import, so they are unit-testable.
 */

export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
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
export function pinchRatio(lm: readonly Landmark[], videoAspect: number): number | null {
  if (lm.length < 21) return null
  const thumb = lm[LM.THUMB_TIP]!
  const index = lm[LM.INDEX_TIP]!
  const palm = palmSize(lm, videoAspect)
  if (!(palm > 1e-4)) return null
  const r = landmarkDistance(thumb, index, videoAspect) / palm
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
