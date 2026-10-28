/**
 * A tiny single-stroke "handwriting" font for tests: turns a string such as
 * "2x+3=11" into pen strokes (polylines in page coordinates), so acceptance
 * tests can write maths on the canvas with the real pen tool.
 */
const ellipse = (cx, cy, rx, ry, n = 14) => Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI - Math.PI / 2), cy + ry * Math.sin((i / n) * 2 * Math.PI - Math.PI / 2)])

// Glyphs in a unit box (0,0 top-left → 1,1 baseline-right); each is a list of strokes.
const GLYPHS = {
  0: [ellipse(0.5, 0.5, 0.42, 0.5)],
  1: [[[0.25, 0.2], [0.55, 0], [0.55, 1]]],
  2: [[[0.05, 0.25], [0.25, 0.03], [0.6, 0], [0.9, 0.2], [0.8, 0.5], [0.05, 1], [0.95, 1]]],
  3: [[[0.05, 0.1], [0.5, 0], [0.9, 0.2], [0.45, 0.47], [0.95, 0.7], [0.55, 1], [0.05, 0.9]]],
  4: [[[0.7, 1], [0.7, 0], [0.02, 0.68], [1, 0.68]]],
  5: [[[0.9, 0], [0.18, 0], [0.12, 0.45], [0.6, 0.38], [0.95, 0.68], [0.6, 1], [0.05, 0.9]]],
  6: [[[0.85, 0.05], [0.4, 0.1], [0.1, 0.55], [0.25, 0.95], [0.7, 0.98], [0.9, 0.7], [0.6, 0.5], [0.15, 0.65]]],
  7: [[[0.02, 0], [0.98, 0], [0.4, 1]]],
  8: [[[0.5, 0.48], [0.1, 0.22], [0.5, 0], [0.9, 0.22], [0.5, 0.48], [0.08, 0.75], [0.5, 1], [0.92, 0.75], [0.5, 0.48]]],
  9: [[[0.88, 0.35], [0.5, 0.02], [0.12, 0.3], [0.5, 0.52], [0.88, 0.35], [0.85, 1]]],
  x: [[[0.05, 0.42], [0.95, 1]], [[0.95, 0.42], [0.05, 1]]],
  y: [[[0.05, 0.42], [0.5, 0.8]], [[0.95, 0.42], [0.25, 1.25]]],
  '+': [[[0.5, 0.3], [0.5, 0.95]], [[0.12, 0.62], [0.88, 0.62]]],
  '-': [[[0.12, 0.62], [0.88, 0.62]]],
  '=': [[[0.08, 0.45], [0.92, 0.45]], [[0.08, 0.78], [0.92, 0.78]]],
  '.': [[[0.45, 0.94], [0.52, 1]]],
  '(': [[[0.7, -0.05], [0.35, 0.3], [0.35, 0.7], [0.7, 1.05]]],
  ')': [[[0.3, -0.05], [0.65, 0.3], [0.65, 0.7], [0.3, 1.05]]],
  '^': [[[0.2, 0.3], [0.5, 0], [0.8, 0.3]]],
  '/': [[[0.9, 0], [0.1, 1]]]
}

/** Strokes for `text` with its top-left at (x, y) and glyph height `h`. Spaces advance. */
export function strokesFor(text, x, y, h = 48) {
  const w = h * 0.62
  const gap = h * 0.22
  const out = []
  let cx = x
  for (const ch of text) {
    if (ch === ' ') {
      cx += w * 0.7
      continue
    }
    const glyph = GLYPHS[ch]
    if (!glyph) throw new Error(`No test glyph for "${ch}"`)
    // Tiny deterministic wobble so it is not perfectly mechanical.
    for (const stroke of glyph) out.push(stroke.map(([gx, gy], i) => [cx + gx * w + ((i * 7) % 3) - 1, y + gy * h + ((i * 5) % 3) - 1]))
    cx += w + gap
  }
  return out
}
