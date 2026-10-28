/**
 * Local search, link and graph index. Lives in the main process, fed from the
 * same files the storage layer writes, and combined with live library
 * metadata (titles, tags, trash state) at query time — so renames, deletes and
 * restores are reflected immediately without re-indexing content.
 *
 * Handwriting strokes are not text and are not indexed. Indexed text is:
 * note content (including formulas' LaTeX), canvas text boxes and, for PDF
 * pages, the PDF's embedded text.
 */
import type { Library, NoteDoc, PageDoc } from '@shared/schema'
import { noteLinks, noteToPlainText } from '@shared/noteText'
import { pageRefs, type PageRef } from '@shared/library'
import type { Connections, GraphData, MatchField, SearchHit, SearchOptions } from '@shared/search'

interface Entry {
  pageId: string
  text: string
  /** Lower-cased, accent-folded `text` for matching. */
  folded: string
  links: string[]
}

/** Lower-case and strip accents, keeping string length (for highlight ranges). */
export function fold(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    out += base.length === ch.length ? base : ch
  }
  return out
}

function ranges(haystackFolded: string, terms: string[]): [number, number][] {
  const out: [number, number][] = []
  for (const t of terms) {
    let i = haystackFolded.indexOf(t)
    while (i !== -1 && out.length < 50) {
      out.push([i, i + t.length])
      i = haystackFolded.indexOf(t, i + t.length)
    }
  }
  out.sort((a, b) => a[0] - b[0])
  // Merge overlaps.
  const merged: [number, number][] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

const SNIPPET_RADIUS = 70

function makeSnippet(text: string, folded: string, terms: string[]): { snippet: string; ranges: [number, number][] } {
  const first = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0))
  if (!Number.isFinite(first)) return { snippet: '', ranges: [] }
  let start = Math.max(0, first - SNIPPET_RADIUS)
  let end = Math.min(text.length, first + SNIPPET_RADIUS * 2)
  // Snap to word boundaries.
  if (start > 0) start = text.indexOf(' ', start) + 1 || start
  if (end < text.length) end = text.lastIndexOf(' ', end) > first ? text.lastIndexOf(' ', end) : end
  const raw = text.slice(start, end).replace(/\n/g, ' · ')
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const snippet = prefix + raw + suffix
  return { snippet, ranges: ranges(fold(snippet), terms) }
}

export function parseQuery(query: string): { terms: string[]; tags: string[] } {
  const terms: string[] = []
  const tags: string[] = []
  for (const raw of query.trim().split(/\s+/)) {
    if (!raw) continue
    if (raw.startsWith('#') && raw.length > 1) tags.push(fold(raw.slice(1)))
    else terms.push(fold(raw))
  }
  return { terms, tags }
}

export class SearchIndex {
  private entries = new Map<string, Entry>()
  private refs = new Map<string, PageRef>()

  setLibrary(library: Library): void {
    this.refs = pageRefs(library)
    // Forget content of pages that no longer exist at all (deleted forever).
    for (const id of this.entries.keys()) if (!this.refs.has(id)) this.entries.delete(id)
  }

  upsertPage(page: PageDoc): void {
    const parts = page.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []))
    if (page.background?.text) parts.push(page.background.text)
    this.put(page.id, parts.join('\n'), [])
  }

  upsertNote(note: NoteDoc): void {
    this.put(note.id, noteToPlainText(note.doc), noteLinks(note.doc))
  }

  has(pageId: string): boolean {
    return this.entries.has(pageId)
  }

  remove(pageId: string): void {
    this.entries.delete(pageId)
  }

  removeNotebook(notebookId: string): void {
    for (const [id, ref] of this.refs) if (ref.notebookId === notebookId) this.entries.delete(id)
  }

  /** The indexed text of a page (for previews and the AI context). */
  text(pageId: string): string {
    return this.entries.get(pageId)?.text ?? ''
  }

  private put(pageId: string, text: string, links: string[]): void {
    this.entries.set(pageId, { pageId, text, folded: fold(text), links })
  }

  private live(): PageRef[] {
    return [...this.refs.values()].filter((r) => !r.trashed)
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { terms, tags } = parseQuery(query)
    if (!terms.length && !tags.length) return []
    const hits: SearchHit[] = []
    for (const page of this.live()) {
      if (options.notebookId && page.notebookId !== options.notebookId) continue
      const pageTags = page.tags.map(fold)
      if (!tags.every((t) => pageTags.some((pt) => pt.startsWith(t)))) continue

      const entry = this.entries.get(page.pageId)
      const titleF = fold(page.title)
      const notebookF = fold(page.notebookName)
      const linked = (entry?.links ?? []).map((id) => this.refs.get(id)).filter((r): r is PageRef => !!r && !r.trashed)
      let score = 0
      const fields = new Set<MatchField>()
      const linkedTitles = new Set<string>()
      let allMatch = true
      for (const t of terms) {
        let matched = false
        if (titleF.includes(t)) {
          score += titleF.startsWith(t) || titleF.includes(` ${t}`) ? 12 : 8
          fields.add('title')
          matched = true
        }
        if (pageTags.some((pt) => pt.includes(t))) {
          score += 6
          fields.add('tag')
          matched = true
        }
        if (entry && entry.folded.includes(t)) {
          let count = 0
          for (let i = entry.folded.indexOf(t); i !== -1 && count < 20; i = entry.folded.indexOf(t, i + t.length)) count++
          score += 2 + Math.min(count, 10) * 0.5
          fields.add('text')
          matched = true
        }
        for (const l of linked) {
          if (fold(l.title).includes(t)) {
            score += 3
            fields.add('link')
            linkedTitles.add(l.title)
            matched = true
          }
        }
        if (notebookF.includes(t)) {
          score += 2
          fields.add('notebook')
          matched = true
        }
        if (!matched) {
          allMatch = false
          break
        }
      }
      if (!allMatch) continue
      if (!terms.length) score = 5 // tag-only query
      const { snippet, ranges: snippetRanges } = entry && fields.has('text') ? makeSnippet(entry.text, entry.folded, terms) : { snippet: '', ranges: [] }
      hits.push({
        page,
        score,
        fields: [...fields],
        titleRanges: ranges(titleF, terms),
        snippet,
        snippetRanges,
        linkedTitles: [...linkedTitles]
      })
    }
    hits.sort((a, b) => b.score - a.score || b.page.updatedAt - a.page.updatedAt)
    return hits.slice(0, options.limit ?? 50)
  }

  /** Live links between live pages. */
  private edges(): { source: string; target: string }[] {
    const out: { source: string; target: string }[] = []
    for (const [id, entry] of this.entries) {
      const from = this.refs.get(id)
      if (!from || from.trashed) continue
      for (const target of entry.links) {
        const to = this.refs.get(target)
        if (to && !to.trashed && target !== id) out.push({ source: id, target })
      }
    }
    return out
  }

  connections(pageId: string): Connections {
    const edges = this.edges()
    const ref = (id: string): PageRef | undefined => this.refs.get(id)
    const outgoingIds = (this.entries.get(pageId)?.links ?? []).filter((id) => id !== pageId)
    // Outgoing links include trashed/missing targets so the user can see them.
    const outgoing = outgoingIds.map(ref).filter((r): r is PageRef => !!r)
    const backlinkIds = [...new Set(edges.filter((e) => e.target === pageId).map((e) => e.source))]
    const backlinks = backlinkIds.map(ref).filter((r): r is PageRef => !!r)

    const self = ref(pageId)
    const direct = new Set([pageId, ...outgoingIds, ...backlinkIds])
    const related = new Map<string, PageRef & { reason: string }>()
    // Shared tags.
    if (self?.tags.length) {
      const mine = new Set(self.tags.map(fold))
      for (const p of this.live()) {
        if (direct.has(p.pageId)) continue
        const shared = p.tags.filter((t) => mine.has(fold(t)))
        if (shared.length) related.set(p.pageId, { ...p, reason: `#${shared.join(' #')}` })
      }
    }
    // Two steps away through a linked page.
    const neighbours = (id: string): string[] =>
      edges.flatMap((e) => (e.source === id ? [e.target] : e.target === id ? [e.source] : []))
    for (const mid of neighbours(pageId)) {
      for (const far of neighbours(mid)) {
        const p = ref(far)
        if (!p || p.trashed || direct.has(far) || related.has(far)) continue
        related.set(far, { ...p, reason: `via ${ref(mid)?.title ?? 'a linked page'}` })
      }
    }
    return { outgoing, backlinks, related: [...related.values()].slice(0, 20) }
  }

  graph(options: { notebookId?: string } = {}): GraphData {
    const nodes = this.live().filter((p) => !options.notebookId || p.notebookId === options.notebookId)
    const ids = new Set(nodes.map((n) => n.pageId))
    const edges = this.edges().filter((e) => ids.has(e.source) && ids.has(e.target))
    // Connected components become clusters (union–find).
    const parent = new Map(nodes.map((n) => [n.pageId, n.pageId]))
    const findRoot = (x: string): string => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      parent.set(x, r)
      return r
    }
    for (const e of edges) parent.set(findRoot(e.source), findRoot(e.target))
    const clusterIds = new Map<string, number>()
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    return {
      nodes: nodes.map((n) => {
        const root = findRoot(n.pageId)
        if (!clusterIds.has(root)) clusterIds.set(root, clusterIds.size)
        return { ...n, degree: degree.get(n.pageId) ?? 0, cluster: clusterIds.get(root)! }
      }),
      edges
    }
  }
}
