/**
 * A 3D hand and pinhole-camera model for synthetic traces (v0.1.3).
 *
 * Produces both MediaPipe outputs from one 3D pose:
 *   - image landmarks: x, y normalized to the frame, z = relative depth from
 *     the wrist on roughly the x scale (MediaPipe's NormalizedLandmark);
 *   - world landmarks: metres, origin at the hand's approximate geometric
 *     centre, axes aligned with the camera (x right, y down, z away from the
 *     camera; MediaPipe documents "smaller z = closer to the camera").
 *
 * The hand is a fixed right-hand skeleton in a pinch pose; the thumb and
 * index tips sit either side of the contact point C. Rotating the hand
 * (pitch / yaw / roll) about C models holding the "pen" at different
 * angles; moving C models writing. This is a geometric model with assumed
 * noise, not a measurement of MediaPipe.
 */
import type { NormPoint } from '../strokes/types'
import type { Landmark } from '../tracking/landmarks'

export type V3 = [number, number, number]

export const CAMERA = {
  width: 960,
  height: 540,
  /** Horizontal field of view of a typical laptop webcam. */
  hfovDeg: 65
}
export const FX = CAMERA.width / 2 / Math.tan(((CAMERA.hfovDeg / 2) * Math.PI) / 180)
export const VIDEO_ASPECT = CAMERA.width / CAMERA.height

/** Hand-local skeleton (metres): wrist at origin, fingers toward −y, palm facing −z (the camera). */
const BASE: V3[] = (() => {
  const p: V3[] = Array.from({ length: 21 }, () => [0, 0, 0] as V3)
  const set = (i: number, x: number, y: number, z: number) => (p[i] = [x, y, z])
  set(0, 0, 0, 0)
  // thumb
  set(1, 0.025, -0.02, -0.01)
  set(2, 0.045, -0.04, -0.02)
  set(3, 0.055, -0.058, -0.03)
  // index
  set(5, 0.025, -0.085, 0)
  set(6, 0.03, -0.11, -0.015)
  set(7, 0.035, -0.115, -0.03)
  // middle
  set(9, 0.004, -0.09, 0)
  set(10, 0.006, -0.12, -0.01)
  set(11, 0.008, -0.135, -0.03)
  set(12, 0.01, -0.14, -0.05)
  // ring
  set(13, -0.015, -0.085, 0)
  set(14, -0.017, -0.11, -0.01)
  set(15, -0.018, -0.123, -0.03)
  set(16, -0.019, -0.128, -0.048)
  // pinky
  set(17, -0.032, -0.075, 0)
  set(18, -0.036, -0.095, -0.01)
  set(19, -0.038, -0.105, -0.025)
  set(20, -0.039, -0.11, -0.04)
  return p
})()

/** Contact point of thumb and index when pinched (hand-local). */
export const CONTACT: V3 = [0.05, -0.085, -0.045]
/** Direction from thumb tip to index tip as the pinch opens (hand-local, unit). */
const AXIS: V3 = (() => {
  const a: V3 = [-0.2, -0.95, -0.25]
  const n = Math.hypot(...a)
  return [a[0] / n, a[1] / n, a[2] / n]
})()

/** Mean side of the wrist / index-MCP / pinky-MCP triangle (metres). */
export const PALM_3D = (() => {
  const d = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  return (d(BASE[0]!, BASE[5]!) + d(BASE[0]!, BASE[17]!) + d(BASE[5]!, BASE[17]!)) / 3
})()

export interface Orientation {
  /** Rotation about the camera x axis (deg). Positive tips the fingers toward the camera. */
  pitch: number
  /** Rotation about the vertical axis (deg). ±90 = hand seen edge-on (sideways). */
  yaw: number
  /** Rotation in the image plane (deg). */
  roll: number
}

export const FACING: Orientation = { pitch: 0, yaw: 0, roll: 0 }

function rot(o: Orientation): (v: V3) => V3 {
  const [p, y, r] = [o.pitch, o.yaw, o.roll].map((d) => (d * Math.PI) / 180) as [number, number, number]
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y), cr = Math.cos(r), sr = Math.sin(r)
  return ([x, yy, z]) => {
    // Rx(pitch): fingers (−y) tip toward the camera (−z) for positive pitch.
    const y1 = yy * cp + z * sp
    const z1 = -yy * sp + z * cp
    // Ry(yaw)
    const x2 = x * cy + z1 * sy
    const z2 = -x * sy + z1 * cy
    // Rz(roll)
    return [x2 * cr - y1 * sr, x2 * sr + y1 * cr, z2]
  }
}

/** Hand-local landmarks with the pinch opened to `gap` (palm fractions), moving the given finger(s). */
export function localHand(gap: number, mover: 'index' | 'thumb' | 'both'): V3[] {
  const h = BASE.map((v) => [...v] as V3)
  const half = (gap * PALM_3D) / 2
  const [ti, tt] = mover === 'both' ? [half, -half] : mover === 'index' ? [2 * half, 0] : [0, -2 * half]
  h[8] = [CONTACT[0] + AXIS[0] * ti, CONTACT[1] + AXIS[1] * ti, CONTACT[2] + AXIS[2] * ti]
  h[4] = [CONTACT[0] + AXIS[0] * tt, CONTACT[1] + AXIS[1] * tt, CONTACT[2] + AXIS[2] * tt]
  // Index DIP follows the tip a little so the finger stays plausible.
  h[7] = [(h[6]![0] + h[8]![0]) / 2, (h[6]![1] + h[8]![1]) / 2, (h[6]![2] + h[8]![2]) / 2]
  return h
}

/** Camera-space point (metres) for a normalized image position at depth `depth`. */
export function imageToCamera(p: NormPoint, depth: number): V3 {
  return [((p.x * CAMERA.width - CAMERA.width / 2) * depth) / FX, ((p.y * CAMERA.height - CAMERA.height / 2) * depth) / FX, depth]
}

export function project(v: V3): NormPoint {
  return { x: (FX * v[0]) / v[2] / CAMERA.width + 0.5, y: (FX * v[1]) / v[2] / CAMERA.height + 0.5 }
}

export interface Pose {
  /** Contact (pen) point in the image, normalized. */
  pen: NormPoint
  /** Distance of the pen point from the camera (metres). */
  depth: number
  gap: number
  mover: 'index' | 'thumb' | 'both'
  orientation: Orientation
}

/** Camera-space 3D landmarks of the hand in a pose (metres). */
export function cameraHand(pose: Pose): V3[] {
  const R = rot(pose.orientation)
  const C = imageToCamera(pose.pen, pose.depth)
  return localHand(pose.gap, pose.mover).map((v) => {
    const r = R([v[0] - CONTACT[0], v[1] - CONTACT[1], v[2] - CONTACT[2]])
    return [C[0] + r[0], C[1] + r[1], C[2] + r[2]] as V3
  })
}

/** MediaPipe-style image landmarks (x, y normalized; z relative to the wrist on the x scale). */
export function imageLandmarks(cam: readonly V3[]): Landmark[] {
  const wz = cam[0]![2]
  return cam.map((v) => {
    const p = project(v)
    return { x: p.x, y: p.y, z: ((v[2] - wz) * FX) / (wz * CAMERA.width) }
  })
}

/** MediaPipe-style world landmarks (metres, origin at the hand's centre, camera-aligned axes). */
export function worldLandmarks(cam: readonly V3[]): Landmark[] {
  const c = cam.reduce((a, v) => [a[0] + v[0] / cam.length, a[1] + v[1] / cam.length, a[2] + v[2] / cam.length] as V3, [0, 0, 0] as V3)
  return cam.map((v) => ({ x: v[0] - c[0], y: v[1] - c[1], z: v[2] - c[2] }))
}

/**
 * How badly an orientation hides the fingertips from the camera, 1 = palm
 * facing. Used to scale fingertip noise: when the fingers point at the camera
 * the thumb and index tips overlap in the image and MediaPipe must guess.
 */
export function occlusionFactor(o: Orientation): number {
  const R = rot(o)
  const finger = R([0, -1, 0]) // finger direction in camera space
  const normal = R([0, 0, -1]) // palm normal (toward the camera when facing)
  const along = Math.abs(finger[2]) // 1 = fingers point along the camera axis
  const edgeOn = 1 - Math.abs(normal[2]) // 1 = palm seen edge-on
  return 1 + 1.6 * along * along + 0.8 * edgeOn * edgeOn
}
