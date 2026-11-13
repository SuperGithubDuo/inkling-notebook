/**
 * Three-way merge of notebook documents (library, pages, notes). Used when the
 * same document changed on two devices: changes that don't touch the same
 * thing are combined; where both sides changed the same thing differently the
 * local value is kept and the path is reported, so the caller can preserve the
 * other version (the sync server keeps it in the document's history).
 *
 * Rules:
 *  - a side that didn't change (equals the base) takes the other side's value
 *  - objects merge key by key
 *  - arrays of things with an `id` (notebooks, pages, canvas objects, folders)
 *    merge per id; something deleted on one side and edited on the other is kept
 *  - arrays of blocks (a note's paragraphs) merge as a sequence
 *  - `updatedAt` takes the later time
 *  - anything else (text, numbers, point lists) is a single value
 */
export interface MergeResult<T> {
  merged: T
  /** Paths where both sides changed the same value; the local one was kept. */
  conflicts: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const hasIds = (v: unknown): v is (Obj & { id: string })[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string')
const isBlocks = (v: unknown): v is Obj[] => Array.isArray(v) && v.length <= SEQ_LIMIT && v.every(isObj)
/** Longest block list merged as a sequence (the comparison is quadratic). */
const SEQ_LIMIT = 2000

/** Structural equality of JSON values; key order doesn't matter. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]))
  }
  return false
}

export function merge3<T>(base: T | undefined | null, local: T, remote: T): MergeResult<T> {
  const conflicts: string[] = []
  const merged = merge(base ?? undefined, local, remote, '', conflicts) as T
  return { merged, conflicts }
}

function merge(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
  if (same(local, remote)) return local
  if (base !== undefined) {
    if (same(local, base)) return remote
    if (same(remote, base)) return local
  }
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {}
    const out: Obj = {}
    for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const p = path ? `${path}.${key}` : key
      const [l, r] = [local[key], remote[key]]
      let v: unknown
      if (key === 'updatedAt' && typeof l === 'number' && typeof r === 'number') v = Math.max(l, r)
      else if (l === undefined || r === undefined) {
        // Removed on one side: gone if the other left it alone, kept if the other changed it.
        const kept = l ?? r
        v = key in b && same(kept, b[key]) ? undefined : kept
      } else v = merge(b[key], l, r, p, conflicts)
      if (v !== undefined) out[key] = v
    }
    return out
  }
  if (hasIds(local) && hasIds(remote)) return mergeById(hasIds(base) ? base : undefined, local, remote, path, conflicts)
  if (isBlocks(local) && isBlocks(remote) && isBlocks(base)) return mergeSeq(base, local, remote, path, conflicts)
  conflicts.push(path || '(document)')
  return local
}

function mergeById(base: (Obj & { id: string })[] | undefined, local: (Obj & { id: string })[], remote: (Obj & { id: string })[], path: string, conflicts: string[]): unknown[] {
  const byId = (list: (Obj & { id: string })[] | undefined): Map<string, Obj> => new Map((list ?? []).map((x) => [x.id, x]))
  const [B, L, R] = [byId(base), byId(local), byId(remote)]
  const out = new Map<string, unknown>()
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const [b, l, r] = [B.get(id), L.get(id), R.get(id)]
    if (l && r) out.set(id, merge(b, l, r, `${path}[${id}]`, conflicts))
    else {
      const kept = (l ?? r)!
      // Present on one side only: new there (keep), or deleted on the other (drop unless edited since).
      if (!b || !same(kept, b)) out.set(id, kept)
    }
  }
  // Order: the side that reordered wins (local if both did); the other side's additions go before their next neighbour (or last).
  const order = (list: { id: string }[]): string[] => list.map((x) => x.id).filter((id) => out.has(id))
  const baseOrder = base ? order(base) : null
  const common = (ids: string[]): string[] => ids.filter((id) => B.has(id))
  const localMoved = !baseOrder || !same(common(order(local)), baseOrder.filter((id) => L.has(id)))
  const [primary, secondary] = localMoved ? [order(local), order(remote)] : [order(remote), order(local)]
  const result = primary.slice()
  const placed = new Set(result)
  secondary.forEach((id, i) => {
    if (placed.has(id)) return
    const next = secondary.slice(i + 1).find((p) => placed.has(p))
    result.splice(next ? result.indexOf(next) : result.length, 0, id)
    placed.add(id)
  })
  return result.map((id) => out.get(id))
}

/** diff3 over a list of blocks: regions changed on one side only are taken from that side. */
function mergeSeq(base: Obj[], local: Obj[], remote: Obj[], path: string, conflicts: string[]): Obj[] {
  const key = (list: Obj[]): string[] => list.map((x) => JSON.stringify(x))
  const [kb, kl, kr] = [key(base), key(local), key(remote)]
  const ml = lcs(kb, kl)
  const mr = lcs(kb, kr)
  const out: Obj[] = []
  let [ib, il, ir] = [0, 0, 0]
  let conflicted = false
  const chunk = (eb: number, el: number, er: number): void => {
    const [sb, sl, sr] = [kb.slice(ib, eb), kl.slice(il, el), kr.slice(ir, er)]
    if (same(sl, sb)) out.push(...remote.slice(ir, er))
    else {
      if (!same(sr, sb) && !same(sl, sr)) conflicted = true
      out.push(...local.slice(il, el))
    }
    ;[ib, il, ir] = [eb, el, er]
  }
  for (let b = 0; b < base.length; b++) {
    const [l, r] = [ml.get(b), mr.get(b)]
    if (l === undefined || r === undefined || l < il || r < ir) continue
    // A block unchanged on both sides: settle what lies before it, then keep it.
    chunk(b, l, r)
    out.push(local[l]!)
    ;[ib, il, ir] = [b + 1, l + 1, r + 1]
  }
  chunk(base.length, local.length, remote.length)
  if (conflicted) conflicts.push(path)
  return out
}

/** Longest common subsequence: index in `a` → matching index in `b`. */
function lcs(a: string[], b: string[]): Map<number, number> {
  const [n, m] = [a.length, b.length]
  const w = m + 1
  const t = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
  const out = new Map<number, number>()
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) out.set(i++, j++)
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++
    else j++
  }
  return out
}
