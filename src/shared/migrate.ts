/**
 * Upgrades older files in memory before validation. Migrations only ever add
 * or rename fields; the upgraded file is written back on the next save, and
 * the previous version stays in the `.bak` file.
 */
type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

export function migratePage(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  // v1 → v2: v2 added shape and image objects; existing objects are unchanged.
  if (raw.schemaVersion === 1) return { ...raw, schemaVersion: 2 }
  return raw
}

export function migrateLibrary(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  // v1 → v2: pages gained a kind (all v1 pages are canvases) and tags.
  if (raw.schemaVersion === 1 && Array.isArray(raw.notebooks)) {
    return {
      ...raw,
      schemaVersion: 2,
      notebooks: raw.notebooks.map((nb) =>
        isObject(nb) && Array.isArray(nb.pages)
          ? { ...nb, pages: nb.pages.map((p) => (isObject(p) ? { kind: 'canvas', tags: [], ...p } : p)) }
          : nb
      )
    }
  }
  return raw
}
