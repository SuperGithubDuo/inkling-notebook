/**
 * A tiny single-line stroke font for synthetic layout tests (v0.1.4).
 *
 * Glyph space: em units, x to the right, y UP, baseline y = 0, x-height 0.5,
 * cap / ascender height 1.0, descender −0.35. Every glyph is a list of
 * strokes; every stroke a polyline. Accuracy of letter shapes doesn't
 * matter here — what matters is that we know, for every inked point, where it
 * sits relative to the baseline and the x-height, so size and alignment can
 * be measured on WISP's output.
 */
export type Pt = [number, number]
export type Glyph = { strokes: Pt[][]; advance: number }

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 16): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt
  })

export const GLYPHS: Record<string, Glyph> = {
  h: { strokes: [[[0, 1], [0, 0]], [[0, 0.25], ...arc(0.2, 0.3, 0.2, 0.2, 180, 0, 10), [0.4, 0]]], advance: 0.6 },
  e: { strokes: [[[0.02, 0.25], [0.4, 0.25], ...arc(0.21, 0.25, 0.2, 0.25, 0, 320, 18)]], advance: 0.55 },
  l: { strokes: [[[0.05, 1], [0.05, 0]]], advance: 0.25 },
  o: { strokes: [arc(0.2, 0.25, 0.2, 0.25, 90, 450, 20)], advance: 0.55 },
  x: { strokes: [[[0, 0.5], [0.4, 0]], [[0.4, 0.5], [0, 0]]], advance: 0.55 },
  a: { strokes: [[...arc(0.2, 0.25, 0.2, 0.25, 60, 420, 18)], [[0.4, 0.5], [0.4, 0]]], advance: 0.55 },
  b: { strokes: [[[0, 1], [0, 0]], arc(0.2, 0.25, 0.2, 0.25, 180, 540, 18)], advance: 0.55 },
  n: { strokes: [[[0, 0.5], [0, 0]], [[0, 0.3], ...arc(0.2, 0.3, 0.2, 0.2, 180, 0, 10), [0.4, 0]]], advance: 0.6 },
  '1': { strokes: [[[0.02, 0.8], [0.15, 1], [0.15, 0]]], advance: 0.4 },
  '2': { strokes: [[...arc(0.2, 0.75, 0.2, 0.25, 150, -30, 12), [0, 0], [0.42, 0]]], advance: 0.55 },
  '+': { strokes: [[[0, 0.3], [0.45, 0.3]], [[0.225, 0.55], [0.225, 0.05]]], advance: 0.65 },
  '=': { strokes: [[[0, 0.38], [0.45, 0.38]], [[0, 0.16], [0.45, 0.16]]], advance: 0.65 },
  '(': { strokes: [arc(0.45, 0.35, 0.4, 0.7, 130, 230, 12)], advance: 0.35 },
  ')': { strokes: [arc(-0.1, 0.35, 0.4, 0.7, 50, -50, 12)], advance: 0.35 },
  '√': { strokes: [[[0, 0.35], [0.1, 0.42], [0.25, 0], [0.42, 1.1], [1.25, 1.1]]], advance: 0.45 },
  '∫': { strokes: [[[0.42, 1.08], [0.33, 1.16], [0.24, 1.06], [0.2, 0.4], [0.16, -0.25], [0.07, -0.33], [-0.02, -0.25]]], advance: 0.5 },
  Σ: { strokes: [[[0.55, 1], [0, 1], [0.32, 0.5], [0, 0], [0.55, 0]]], advance: 0.75 },
  '—': { strokes: [[[0, 0], [1, 0]]], advance: 1 },
  ' ': { strokes: [], advance: 0.45 }
}

/** A glyph placed on the page of glyph space (em), with its own scale (superscripts etc.). */
export interface Placed {
  ch: string
  /** Offset of the glyph origin (em). */
  dx: number
  dy: number
  scale: number
  /** Role, for the notation metrics: 'main' | 'sup' | 'sub' | 'num' | 'den' | 'under'. */
  role: string
  /** Index of the "word" (group measured together). */
  word: number
}

/** Lays out plain text left to right from (x, y) (em), all role 'main'. */
export function text(s: string, x = 0, y = 0, word = 0, scale = 1, role = 'main'): Placed[] {
  const out: Placed[] = []
  let cx = x
  for (const ch of s) {
    const g = GLYPHS[ch]
    if (!g) throw new Error(`no glyph for "${ch}"`)
    if (ch !== ' ') out.push({ ch, dx: cx, dy: y, scale, role, word })
    cx += g.advance * scale
  }
  return out
}

export function advanceOf(s: string, scale = 1): number {
  let w = 0
  for (const ch of s) w += (GLYPHS[ch]?.advance ?? 0) * scale
  return w
}
