/**
 * Documents as the sync engine sees them: a path, and content validated with
 * the same schemas (and migrations) as the files on disk.
 */
import { z, type ZodType } from 'zod'
import { migrateLibrary, migratePage } from '../migrate'
import { LIBRARY_SCHEMA_VERSION, NOTE_SCHEMA_VERSION, PAGE_SCHEMA_VERSION, librarySchema, noteDocSchema, pageDocSchema, type Library, type NoteDoc, type PageDoc } from '../schema'
import { LIBRARY_PATH } from './engine'

const pageFile = z.preprocess(migratePage, pageDocSchema) as unknown as ZodType<PageDoc>
const libraryFile = z.preprocess(migrateLibrary, librarySchema) as unknown as ZodType<Library>

export type DocKind = 'library' | 'page' | 'note'
export const PATH_RE = /^(library|(page|note)\/([A-Za-z0-9_-]{6,64})\/([A-Za-z0-9_-]{6,64}))$/

export function parsePath(path: string): { kind: DocKind; notebookId: string; pageId: string } | null {
  const m = PATH_RE.exec(path)
  if (!m) return null
  return path === LIBRARY_PATH ? { kind: 'library', notebookId: '', pageId: '' } : { kind: m[2] as DocKind, notebookId: m[3]!, pageId: m[4]! }
}

const SPEC = {
  library: { schema: libraryFile, version: LIBRARY_SCHEMA_VERSION },
  page: { schema: pageFile, version: PAGE_SCHEMA_VERSION },
  note: { schema: noteDocSchema as ZodType<NoteDoc>, version: NOTE_SCHEMA_VERSION }
} as const

export type Checked = { ok: true; data: unknown } | { ok: false; reason: 'newer' | 'invalid'; message: string }

/** Validates (and upgrades) a document read from storage or received from the server. */
export function checkDoc(path: string, raw: unknown): Checked {
  const kind = parsePath(path)?.kind
  if (!kind) return { ok: false, reason: 'invalid', message: `Unknown document ${path}` }
  const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof v === 'number' && v > SPEC[kind].version) {
    return { ok: false, reason: 'newer', message: 'This was saved by a newer version of Inkling. Update Inkling on this device to open and sync it.' }
  }
  const parsed = SPEC[kind].schema.safeParse(raw)
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: 'invalid', message: `Refused to save invalid data: ${parsed.error.issues[0]?.message ?? 'unknown'}` }
}

/** The image and PDF files a document shows, as `<notebookId>/<assetName>`. */
export function assetRefs(path: string, content: unknown): string[] {
  const p = parsePath(path)
  if (!p || p.kind === 'library') return []
  const out = new Set<string>()
  if (p.kind === 'page') {
    const page = content as Partial<PageDoc>
    if (page.background?.asset) out.add(`${p.notebookId}/${page.background.asset}`)
    for (const o of page.objects ?? []) if (o.type === 'image') out.add(`${p.notebookId}/${o.asset}`)
  } else {
    // Notes embed images by URL: inkling-asset://asset/<notebookId>/<name>
    for (const m of JSON.stringify(content).matchAll(/inkling-asset:\/\/asset\/([A-Za-z0-9_-]{6,64})\/([A-Za-z0-9_-]{6,64}\.(?:png|jpg|jpeg|gif|webp))/g)) out.add(`${m[1]}/${m[2]}`)
  }
  return [...out]
}

/**
 * Notebooks worth carrying into an account: anything the user touched. A
 * notebook exactly as the first run made it (one page, never edited, nothing
 * on it) is left out, so signing in on a new device doesn't add another set
 * of empty starter notebooks to the account.
 */
export async function withoutPristine(library: Library, read: (path: string) => Promise<unknown | null>): Promise<Library> {
  const keep: Library['notebooks'] = []
  for (const nb of library.notebooks) {
    const untouched = nb.pages.length === 1 && nb.createdAt === nb.updatedAt && nb.deletedAt === null && !nb.favorite
    if (!untouched) {
      keep.push(nb)
      continue
    }
    const page = nb.pages[0]!
    const doc = (await read(page.kind === 'note' ? `note/${nb.id}/${page.id}` : `page/${nb.id}/${page.id}`)) as (Partial<PageDoc> & Partial<NoteDoc>) | null
    const empty = !doc || (page.kind === 'note' ? JSON.stringify(doc.doc ?? {}).length < 60 : !doc.objects?.length && !doc.background)
    if (!empty || page.title || page.tags.length) keep.push(nb)
  }
  return { ...library, notebooks: keep }
}

export const countPages = (library: Library): { notebooks: number; pages: number } => ({
  notebooks: library.notebooks.length,
  pages: library.notebooks.reduce((n, nb) => n + nb.pages.length, 0)
})
