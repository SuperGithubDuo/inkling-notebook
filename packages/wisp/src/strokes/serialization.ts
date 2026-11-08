/**
 * JSON export/import of WISP documents (`format: "wisp.strokes"`, version 1).
 * Import validates everything and never throws: bad files produce a readable
 * error instead of a crash or a half-loaded drawing.
 */
import {
  WISP_FORMAT,
  WISP_FORMAT_VERSION,
  newId,
  type InputSource,
  type Stroke,
  type StrokePoint,
  type WispDocument
} from './types'

export const LIMITS = { strokes: 20000, pointsPerStroke: 20000, bytes: 50 * 1024 * 1024 } as const

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6

export function serializeDocument(doc: WispDocument, pretty = false): string {
  const out: WispDocument = {
    format: WISP_FORMAT,
    version: WISP_FORMAT_VERSION,
    id: doc.id,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    canvas: { ...doc.canvas },
    strokes: doc.strokes.map((s) => ({
      id: s.id,
      color: s.color,
      width: s.width,
      source: s.source,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      points: s.points.map((p) => {
        const q: StrokePoint = { x: r6(p.x), y: r6(p.y), t: p.t }
        if (p.confidence !== undefined) q.confidence = p.confidence
        if (p.raw) q.raw = { x: r6(p.raw.x), y: r6(p.raw.y) }
        return q
      })
    }))
  }
  return JSON.stringify(out, null, pretty ? 2 : undefined)
}

export type ParseResult = { ok: true; doc: WispDocument; warnings: string[] } | { ok: false; error: string }

class InvalidDoc extends Error {}

const fail = (msg: string): never => {
  throw new InvalidDoc(msg)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, path: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${path} must be a finite number`))
const unit = (v: unknown, path: string): number => {
  const n = num(v, path)
  // Allow tiny float error outside [0, 1]; clamp it.
  if (n < -1e-6 || n > 1 + 1e-6) fail(`${path} must be between 0 and 1 (page-normalized)`)
  return Math.min(1, Math.max(0, n))
}
const HEX = /^#[0-9a-fA-F]{6}$/
const SOURCES: readonly InputSource[] = ['webcam', 'mouse', 'import']
const ID = /^[A-Za-z0-9_-]{1,80}$/

export function parseDocument(input: string | unknown): ParseResult {
  try {
    let data: unknown = input
    if (typeof input === 'string') {
      if (input.length > LIMITS.bytes) fail('File is too large (over 50 MB).')
      try {
        data = JSON.parse(input)
      } catch {
        fail('This file is not valid JSON.')
      }
    }
    return { ok: true, ...validate(data) }
  } catch (err) {
    if (err instanceof InvalidDoc) return { ok: false, error: err.message }
    return { ok: false, error: 'Could not read this file.' }
  }
}

function validate(data: unknown): { doc: WispDocument; warnings: string[] } {
  const warnings: string[] = []
  if (!isObj(data)) fail('Expected a WISP stroke document (a JSON object).')
  const d = data as Record<string, unknown>
  if (d.format !== WISP_FORMAT) fail(`Not a WISP stroke file (format should be "${WISP_FORMAT}").`)
  if (d.version !== WISP_FORMAT_VERSION) fail(`Unsupported WISP format version ${String(d.version)} (this build reads version ${WISP_FORMAT_VERSION}).`)

  const c = d.canvas
  if (!isObj(c)) fail('canvas is missing.')
  const canvas = c as Record<string, unknown>
  const width = num(canvas.width, 'canvas.width')
  const height = num(canvas.height, 'canvas.height')
  if (width < 16 || height < 16 || width > 20000 || height > 20000) fail('canvas size must be between 16 and 20000.')
  const background = typeof canvas.background === 'string' && HEX.test(canvas.background) ? canvas.background : '#ffffff'

  if (!Array.isArray(d.strokes)) fail('strokes must be an array.')
  const rawStrokes = d.strokes as unknown[]
  if (rawStrokes.length > LIMITS.strokes) fail(`Too many strokes (max ${LIMITS.strokes}).`)

  const strokes: Stroke[] = rawStrokes.map((s, i) => {
    const path = `strokes[${i}]`
    if (!isObj(s)) fail(`${path} must be an object.`)
    const so = s as Record<string, unknown>
    if (typeof so.color !== 'string' || !HEX.test(so.color)) fail(`${path}.color must be a #rrggbb colour.`)
    const w = num(so.width, `${path}.width`)
    if (w <= 0 || w > 200) fail(`${path}.width must be between 0 and 200.`)
    if (!Array.isArray(so.points) || so.points.length === 0) fail(`${path}.points must be a non-empty array.`)
    const pts = so.points as unknown[]
    if (pts.length > LIMITS.pointsPerStroke) fail(`${path} has too many points (max ${LIMITS.pointsPerStroke}).`)
    const points: StrokePoint[] = pts.map((p, j) => {
      const pp = `${path}.points[${j}]`
      if (!isObj(p)) fail(`${pp} must be an object.`)
      const po = p as Record<string, unknown>
      const q: StrokePoint = { x: unit(po.x, `${pp}.x`), y: unit(po.y, `${pp}.y`), t: num(po.t, `${pp}.t`) }
      if (po.confidence !== undefined) q.confidence = Math.min(1, Math.max(0, num(po.confidence, `${pp}.confidence`)))
      if (po.raw !== undefined) {
        if (!isObj(po.raw)) fail(`${pp}.raw must be an object.`)
        const r = po.raw as Record<string, unknown>
        q.raw = { x: unit(r.x, `${pp}.raw.x`), y: unit(r.y, `${pp}.raw.y`) }
      }
      return q
    })
    let source: InputSource = 'import'
    if (typeof so.source === 'string' && (SOURCES as readonly string[]).includes(so.source)) source = so.source as InputSource
    else if (so.source !== undefined) warnings.push(`${path}.source "${String(so.source)}" is unknown; treated as "import".`)
    const id = typeof so.id === 'string' && ID.test(so.id) ? so.id : newId('stroke')
    const startedAt = typeof so.startedAt === 'number' && Number.isFinite(so.startedAt) ? so.startedAt : points[0]!.t
    const endedAt = typeof so.endedAt === 'number' && Number.isFinite(so.endedAt) ? so.endedAt : points[points.length - 1]!.t
    return { id, points, color: so.color as string, width: w, source, startedAt, endedAt }
  })

  const ids = new Set<string>()
  for (const s of strokes) {
    if (ids.has(s.id)) {
      warnings.push(`Duplicate stroke id ${s.id} was renamed.`)
      s.id = newId('stroke')
    }
    ids.add(s.id)
  }

  const now = Date.now()
  const doc: WispDocument = {
    format: WISP_FORMAT,
    version: WISP_FORMAT_VERSION,
    id: typeof d.id === 'string' && ID.test(d.id) ? d.id : newId('doc'),
    createdAt: typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? d.createdAt : now,
    updatedAt: typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) ? d.updatedAt : now,
    canvas: { width, height, background },
    strokes
  }
  return { doc, warnings }
}
