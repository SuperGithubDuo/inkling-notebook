import { describe, expect, it } from 'vitest'
import { parseDocument, serializeDocument } from '../src/strokes/serialization'
import { createDocument, type WispDocument } from '../src/strokes/types'
import { StrokeEngine } from '../src/strokes/strokeEngine'

function sampleDoc(): WispDocument {
  const e = new StrokeEngine({ smoothing: 0.5 })
  const doc = createDocument()
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 25; i++) e.input({ x: 0.1 + i * 0.01, y: 0.2 + k * 0.1 + Math.sin(i) * 0.01, t: k * 1000 + i * 33, source: 'webcam', confidence: 0.9 }, true)
    doc.strokes.push(e.end()!)
  }
  return doc
}

describe('serialization', () => {
  it('JSON export → import is lossless', () => {
    const doc = sampleDoc()
    const json = serializeDocument(doc)
    const res = parseDocument(json)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc).toEqual(doc)
    expect(res.warnings).toEqual([])
    // And stable: exporting the import gives the same bytes.
    expect(serializeDocument(res.doc)).toBe(json)
  })

  it('accepts already-parsed objects', () => {
    const doc = sampleDoc()
    const res = parseDocument(JSON.parse(serializeDocument(doc)))
    expect(res.ok).toBe(true)
  })

  const bad: Array<[string, unknown, RegExp]> = [
    ['not JSON', '{nope', /not valid JSON/],
    ['an array', '[]', /JSON object/],
    ['wrong format', JSON.stringify({ format: 'other', version: 1 }), /Not a WISP/],
    ['future version', JSON.stringify({ format: 'wisp.strokes', version: 9 }), /Unsupported WISP format version 9/],
    ['missing canvas', JSON.stringify({ format: 'wisp.strokes', version: 1, strokes: [] }), /canvas/],
    ['bad colour', JSON.stringify({ format: 'wisp.strokes', version: 1, canvas: { width: 100, height: 100 }, strokes: [{ color: 'red', width: 2, points: [{ x: 0, y: 0, t: 0 }] }] }), /color/],
    ['NaN-like point', JSON.stringify({ format: 'wisp.strokes', version: 1, canvas: { width: 100, height: 100 }, strokes: [{ color: '#000000', width: 2, points: [{ x: 'a', y: 0, t: 0 }] }] }), /points\[0\]\.x/],
    ['out-of-page point', JSON.stringify({ format: 'wisp.strokes', version: 1, canvas: { width: 100, height: 100 }, strokes: [{ color: '#000000', width: 2, points: [{ x: 3, y: 0, t: 0 }] }] }), /between 0 and 1/],
    ['empty stroke', JSON.stringify({ format: 'wisp.strokes', version: 1, canvas: { width: 100, height: 100 }, strokes: [{ color: '#000000', width: 2, points: [] }] }), /non-empty/],
    ['null', null, /JSON object/]
  ]
  for (const [name, input, msg] of bad) {
    it(`rejects ${name} with a readable error`, () => {
      const res = parseDocument(input)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(msg)
    })
  }

  it('repairs missing ids, unknown sources and duplicate ids with warnings', () => {
    const json = JSON.stringify({
      format: 'wisp.strokes',
      version: 1,
      canvas: { width: 800, height: 500 },
      strokes: [
        { id: 'dup', color: '#112233', width: 2, source: 'pencil', points: [{ x: 0.1, y: 0.1, t: 0 }] },
        { id: 'dup', color: '#112233', width: 2, points: [{ x: 0.2, y: 0.2, t: 5 }] }
      ]
    })
    const res = parseDocument(json)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.strokes[0]!.source).toBe('import')
    expect(res.doc.strokes[0]!.id).not.toBe(res.doc.strokes[1]!.id)
    expect(res.warnings.length).toBe(2)
    expect(res.doc.canvas.background).toBe('#ffffff')
  })
})
