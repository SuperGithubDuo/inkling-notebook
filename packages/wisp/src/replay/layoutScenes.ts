/**
 * Layout scenes (v0.1.4) — what the v0.1.4 measurements are made on.
 * All physical: the writer writes letters of a fixed real size on a surface
 * in front of the camera. See layout.ts.
 */
import { advanceOf, text, type Placed } from './font'
import type { LayoutScene } from './layout'
import type { Orientation } from './hand3d'

const EM = 0.028 // 2.8 cm cap height, 1.4 cm x-height
const PITCH = 1.9 // line pitch, em

/** Placeholder origin: the runner places each scene on the page the mapping shows (layout.placeScene). */
const originFor = (): { X: number; Y: number } => ({ X: 0, Y: 0 })

function words(line: string[], y: number, firstWord: number, scale = 1): Placed[][] {
  let x = 0
  return line.map((w, i) => {
    const g = text(w, x, y, firstWord + i, scale)
    x += advanceOf(w, scale) + 0.6
    return g
  })
}

const T = { facing: { pitch: 0, yaw: 0, roll: 0 }, yaw40: { pitch: 0, yaw: 40, roll: 0 }, tiltUp: { pitch: -30, yaw: 0, roll: 0 } } satisfies Record<string, Orientation>

export interface SceneDef {
  scene: LayoutScene
  /** Which line a word is on (words on one line should share a baseline). */
  lineOf: (word: number) => number
  /** Intended notation geometry: `${word}:${role}` → size relative to main, baseline offset in main ems (+ = above). */
  notation?: Map<string, { scale: number; dy: number }>
}

export const LAYOUT_SCENES: SceneDef[] = [
  {
    scene: {
      id: 'LA-distance',
      title: '"hello hello" on three lines at 45, 37 and 56 cm',
      em: EM,
      origin: originFor(),
      words: [
        ...words(['hello', 'hello'], 0, 0).map((g) => ({ glyphs: g, depth: 0.45 })),
        ...words(['hello', 'hello'], -PITCH, 2).map((g) => ({ glyphs: g, depth: 0.37 })),
        ...words(['hello', 'hello'], -2 * PITCH, 4).map((g) => ({ glyphs: g, depth: 0.56 }))
      ]
    },
    lineOf: (w) => Math.floor(w / 2)
  },
  {
    scene: {
      id: 'LB-lean',
      title: 'Leaning in while writing one line (42 → 52 cm)',
      em: EM,
      origin: originFor(),
      words: words(['hello', 'hello', 'hello'], 0, 0).map((g, i) => ({ glyphs: g, depth: 0.42 + 0.05 * i }))
    },
    lineOf: () => 0
  },
  {
    scene: {
      id: 'LC-turn',
      title: 'Turning the hand between words (facing, 40° sideways, tilted up)',
      em: EM,
      origin: originFor(),
      words: words(['hello', 'hello', 'hello'], 0, 0).map((g, i) => ({ glyphs: g, depth: 0.45, orientation: [T.facing, T.yaw40, T.tiltUp][i] }))
    },
    lineOf: () => 0
  },
  {
    scene: {
      id: 'LD-drift',
      title: 'Arm slowly sinking (1.2 mm/s) over two lines',
      em: EM,
      origin: originFor(),
      words: [...words(['hello', 'hello', 'hello'], 0, 0), ...words(['hello', 'hello', 'hello'], -PITCH, 3)].map((g) => ({ glyphs: g, depth: 0.45 })),
      drift: (s) => ({ dX: 0, dY: 0.0012 * s })
    },
    lineOf: (w) => Math.floor(w / 3)
  },
  (() => {
    // x² + 1 = (a over b) √x ∫x₁ Σ — main glyphs plus superscripts, subscripts and fraction parts.
    const g: Placed[] = []
    const notation = new Map<string, { scale: number; dy: number }>()
    let x = 0
    const add = (s: string, word: number, role: string, scale = 1, dy = 0) => {
      g.push(...text(s, x, dy, word, scale, role))
      x += advanceOf(s, scale)
      if (role !== 'main') notation.set(`${word}:${role}`, { scale, dy })
    }
    add('x', 0, 'main')
    add('2', 0, 'sup', 0.6, 0.55)
    x += 0.3
    add('+', 0, 'main')
    add('1', 0, 'main')
    x += 0.6
    // fraction: numerator "a" above a bar, denominator "b" below
    const fx = x
    g.push(...text('a', fx + 0.15, 0.75, 1, 1, 'main'))
    g.push(...text('—', fx, 0.5, 1, 0.8, 'bar'))
    g.push(...text('b', fx + 0.15, -1.15, 1, 1, 'den'))
    notation.set('1:den', { scale: 1, dy: -1.9 })
    x = fx + 1.4
    add('√', 2, 'root')
    notation.set('2:root', { scale: 1, dy: 0 })
    add('x', 2, 'main')
    x += 0.6
    add('∫', 3, 'main')
    add('x', 3, 'main')
    add('1', 3, 'sub', 0.55, -0.25)
    x += 0.6
    add('Σ', 4, 'main')
    add('n', 4, 'sub', 0.55, -0.3)
    const byWord = new Map<number, Placed[]>()
    for (const p of g) byWord.set(p.word, [...(byWord.get(p.word) ?? []), p])
    return {
      scene: { id: 'LE-math', title: 'x² + 1, a fraction, √x, ∫x₁, Σₙ', em: EM, origin: originFor(), words: [...byWord.values()].map((glyphs) => ({ glyphs, depth: 0.45 })) },
      lineOf: () => 0,
      notation
    }
  })()
]
