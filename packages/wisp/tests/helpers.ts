import type { Landmark } from '../src/tracking/landmarks'
import type { GestureAction, GestureFrame } from '../src/gestures/gestureState'

/** Synthetic 21-point hand: palm triangle of side ~0.1 frame widths, thumb/index tips `gap` apart. */
export function fakeHand(gap: number, cx = 0.5, cy = 0.5): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }))
  lm[0] = { x: cx, y: cy + 0.1, z: 0 } // wrist
  lm[5] = { x: cx - 0.05, y: cy, z: 0 } // index MCP
  lm[17] = { x: cx + 0.05, y: cy, z: 0 } // pinky MCP
  lm[8] = { x: cx - 0.05, y: cy - 0.12, z: 0 } // index tip
  lm[4] = { x: cx - 0.05 + gap, y: cy - 0.12, z: 0 } // thumb tip
  return lm
}

export const hand = (ratio: number | null, x = 0.5, y = 0.5, confidence = 0.95) => ({ x, y, pinchRatio: ratio, confidence })

export const OPEN = 0.9
export const CLOSED = 0.1

/** Runs frames at 30 fps from t0. */
export function frames(list: Array<GestureFrame['hand']>, t0 = 0): GestureFrame[] {
  return list.map((h, i) => ({ t: t0 + i * 33, hand: h }))
}

export const samples = (actions: GestureAction[]) => actions.flatMap((a) => (a.type === 'sample' ? [a.sample] : []))
export const ends = (actions: GestureAction[]) => actions.filter((a) => a.type === 'end')
