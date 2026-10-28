/**
 * Upgrades older page files in memory before validation. Migrations only ever
 * add or rename fields; the upgraded page is written back on the next save.
 */
export function migratePage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const page = raw as Record<string, unknown>
  // v1 → v2: v2 added shape and image objects; existing objects are unchanged.
  if (page.schemaVersion === 1) return { ...page, schemaVersion: 2 }
  return raw
}
