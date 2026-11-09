/**
 * wisp-motion dataset tools: validation, versioned manifests and
 * leakage-free train / validation / test partitions.
 *
 * A dataset is a folder of v4 landmark traces (landmarks only — never video)
 * plus optional annotation sidecars, described by a manifest. The manifest is
 * the dataset VERSION: it lists every file with its content hash, and its own
 * hash is computed from those, so any change to any trace or label gives a
 * new dataset id. Results must always cite the dataset id they used.
 */
import type { LandmarkTrace } from '../replay/trace'

// ── Validation ──────────────────────────────────────────────────────────────

export interface TraceStats {
  frames: number
  durationMs: number
  /** Share of frames with a tracked hand. */
  tracked: number
  /** Median and 95th-percentile frame interval (ms). */
  medianDtMs: number
  p95DtMs: number
  /** Frames with world landmarks / with a handedness label. */
  withWorld: number
  withHandedness: number
  marks: number
}

export interface Validation {
  ok: boolean
  /** Problems that make the trace unusable. */
  errors: string[]
  /** Problems that limit what it can be used for (e.g. no participant id → can't be in a participant-independent split). */
  warnings: string[]
  stats: TraceStats
}

/** Keys that would indicate image or video data; a WISP research trace must never contain them. */
const FORBIDDEN_KEYS = ['image', 'images', 'video', 'frame', 'jpeg', 'png', 'pixels', 'thumbnail', 'snapshot', 'dataUrl']

function findForbidden(v: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 4 || v === null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    // Only look inside the first few elements of long arrays (frames are uniform).
    for (let i = 0; i < Math.min(v.length, 3); i++) findForbidden(v[i], `${path}[${i}]`, out, depth + 1)
    return
  }
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.includes(k)) out.push(`${path}.${k}`)
    if (typeof x === 'string' && x.startsWith('data:image')) out.push(`${path}.${k}`)
    findForbidden(x, `${path}.${k}`, out, depth + 1)
  }
}

const quantile = (v: number[], q: number): number => {
  if (v.length === 0) return 0
  const s = v.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!
}

/**
 * Validates one trace for research use. `raw` is the parsed JSON as found on
 * disk (checked for image/video content and v4 metadata); `trace` the parsed trace.
 */
export function validateTrace(raw: unknown, trace: LandmarkTrace): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  const forbidden: string[] = []
  findForbidden(raw, '$', forbidden)
  if (forbidden.length) errors.push(`contains image/video-like fields: ${forbidden.slice(0, 5).join(', ')}`)
  const fr = trace.frames
  if (fr.length < 30) errors.push(`too short: ${fr.length} frames`)
  const dts: number[] = []
  let backwards = 0
  for (let i = 1; i < fr.length; i++) {
    const d = fr[i]!.t - fr[i - 1]!.t
    if (!(d > 0)) backwards++
    else dts.push(d)
  }
  if (backwards) errors.push(`${backwards} non-increasing timestamps`)
  let bad = 0
  let tracked = 0
  let withWorld = 0
  let withHand = 0
  for (const f of fr) {
    if (f.lm) {
      tracked++
      // Normalized image coordinates: MediaPipe reports slightly outside [0, 1] near the edges, never far outside.
      for (let i = 0; i < 63; i += 3) if (!(f.lm[i]! > -0.5 && f.lm[i]! < 1.5 && f.lm[i + 1]! > -0.5 && f.lm[i + 1]! < 1.5)) bad++
    }
    if (f.w) withWorld++
    if (f.h) withHand++
  }
  if (bad) errors.push(`${bad} landmark coordinates far outside the image`)
  if (tracked < fr.length * 0.3) warnings.push(`hand tracked in only ${Math.round((100 * tracked) / Math.max(1, fr.length))} % of frames`)
  if (trace.version < 4) warnings.push(`trace v${trace.version}: no handedness or guard verdicts (record with WISP ≥ 0.1.5 for research)`)
  if (trace.version >= 3 && withWorld < tracked * 0.9) warnings.push('world landmarks missing on many frames')
  const meta = trace.meta
  if (!meta?.participant) warnings.push('no participant id: excluded from participant-independent splits')
  if (!meta?.session) warnings.push('no session id: each trace is treated as its own session')
  if (meta?.consent !== true) warnings.push('no recorded research consent: do not include in a shared dataset')
  if (meta?.participant && /\s/.test(meta.participant)) warnings.push('participant id contains spaces: use a pseudonymous code (e.g. P03), never a name')
  const marks = (trace.events ?? []).filter((e) => e.type === 'mark').length
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      frames: fr.length,
      durationMs: fr.length ? fr.at(-1)!.t - fr[0]!.t : 0,
      tracked: fr.length ? tracked / fr.length : 0,
      medianDtMs: quantile(dts, 0.5),
      p95DtMs: quantile(dts, 0.95),
      withWorld,
      withHandedness: withHand,
      marks
    }
  }
}

// ── Manifest (dataset version) ──────────────────────────────────────────────

export const MANIFEST_FORMAT = 'wisp.motion.dataset' as const

export interface ManifestEntry {
  /** Path relative to the dataset root. */
  file: string
  /** sha256 of the file bytes. */
  sha256: string
  participant: string | null
  session: string | null
  task: string | null
  frames: number
  durationMs: number
  /** Annotation sidecar, if any. */
  annotations?: { file: string; sha256: string; spans: number }
  marks: number
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT
  version: 1
  /** sha256 over the canonical entry list: the dataset id. */
  id: string
  name: string
  createdAt: string
  /** Data provenance — must say 'synthetic' for generated data. */
  source: 'real' | 'synthetic' | 'mixed'
  entries: ManifestEntry[]
}

/** JSON with sorted keys, so equal content always serializes (and hashes) the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  return `{${Object.keys(v)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

/**
 * Builds a manifest. `sha256` is passed in (node:crypto in the CLI) so this
 * module stays free of Node APIs. Entries are sorted by file so the id does
 * not depend on directory listing order.
 */
export function buildManifest(name: string, source: Manifest['source'], entries: ManifestEntry[], sha256: (s: string) => string, createdAt = new Date().toISOString()): Manifest {
  const sorted = entries.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { format: MANIFEST_FORMAT, version: 1, id: sha256(canonicalJson(sorted)), name, createdAt, source, entries: sorted }
}

// ── Splits ──────────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** Fractions of GROUPS (not frames) for test and validation; the rest train. */
  test: number
  val: number
  /** Group recordings by participant (default) or by session. */
  by: 'participant' | 'session'
  seed: string
}

export interface Split {
  train: string[]
  val: string[]
  test: string[]
  /** What the groups were and where each went. */
  groups: Record<string, 'train' | 'val' | 'test'>
  /** True only if every test/val group is a participant never seen in training. */
  participantIndependent: boolean
  warnings: string[]
}

/** Deterministic 32-bit FNV-1a, for seed-stable group ordering. */
function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * Splits whole GROUPS into train / val / test, never frames or windows: all
 * recordings of one participant (or one session) land in the same part, so
 * neighbouring frames, the same writer's habits and the same camera/lighting
 * can't leak from training into evaluation. Recordings without a participant
 * fall back to their session (and are reported). Windows for a temporal
 * model must be cut AFTER splitting, within one recording.
 */
export function groupSplit(entries: readonly ManifestEntry[], opt: Partial<SplitOptions> = {}): Split {
  const o: SplitOptions = { test: 0.2, val: 0.1, by: 'participant', seed: 'wisp-motion', ...opt }
  const warnings: string[] = []
  const groupOf = (e: ManifestEntry): string => {
    if (o.by === 'participant' && e.participant) return `participant:${e.participant}`
    if (e.session) return `session:${e.session}`
    return `file:${e.file}`
  }
  const missing = entries.filter((e) => o.by === 'participant' && !e.participant).length
  if (missing) warnings.push(`${missing} recording(s) without a participant id grouped by session/file`)
  const groups = [...new Set(entries.map(groupOf))].sort((a, b) => fnv(o.seed + a) - fnv(o.seed + b) || (a < b ? -1 : 1))
  const n = groups.length
  const nTest = n >= 3 ? Math.max(1, Math.round(n * o.test)) : 0
  const nVal = n - nTest >= 3 ? Math.max(o.val > 0 ? 1 : 0, Math.round(n * o.val)) : 0
  if (n < 3) warnings.push(`only ${n} group(s): no held-out test set is possible; collect more ${o.by === 'participant' ? 'participants' : 'sessions'}`)
  const assign: Record<string, 'train' | 'val' | 'test'> = {}
  groups.forEach((g, i) => (assign[g] = i < nTest ? 'test' : i < nTest + nVal ? 'val' : 'train'))
  const split: Split = { train: [], val: [], test: [], groups: assign, participantIndependent: false, warnings }
  for (const e of entries) split[assign[groupOf(e)]!].push(e.file)
  const heldOut = groups.filter((g) => assign[g] !== 'train')
  split.participantIndependent = o.by === 'participant' && heldOut.length > 0 && heldOut.every((g) => g.startsWith('participant:'))
  if (o.by === 'participant' && !split.participantIndependent) warnings.push('NOT participant-independent: results describe seen writers only')
  return split
}

/** Leakage check: no participant or session appears in two parts. Returns the problems found. */
export function checkLeakage(entries: readonly ManifestEntry[], split: Split): string[] {
  const part = new Map<string, string>()
  for (const p of ['train', 'val', 'test'] as const) for (const f of split[p]) part.set(f, p)
  const problems: string[] = []
  for (const key of ['participant', 'session'] as const) {
    const seen = new Map<string, Set<string>>()
    for (const e of entries) {
      const id = e[key]
      if (!id) continue
      const p = part.get(e.file)
      if (!p) continue
      if (!seen.has(id)) seen.set(id, new Set())
      seen.get(id)!.add(p)
    }
    for (const [id, ps] of seen) if (ps.size > 1) problems.push(`${key} ${id} appears in ${[...ps].join(' + ')}`)
  }
  return problems
}
