import { beforeEach, describe, expect, it } from 'vitest'
import { SearchIndex, fold, parseQuery } from '../../src/main/searchIndex'
import { createNoteDoc, createPageDoc, createPageMeta, createStarterLibrary } from '../../src/shared/factory'
import type { Library, NoteNode, PageMeta } from '../../src/shared/schema'

const p = (text: string): NoteNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const ref = (pageId: string, label = ''): NoteNode => ({ type: 'noteRef', attrs: { pageId, label } })
const doc = (...content: NoteNode[]): NoteNode => ({ type: 'doc', content })

let library: Library
let index: SearchIndex
let math: Library['notebooks'][number]
let physics: Library['notebooks'][number]
let quadratics: PageMeta
let vertex: PageMeta
let forces: PageMeta
let canvas: PageMeta

function setPage(nbId: string, meta: PageMeta): void {
  library = {
    ...library,
    notebooks: library.notebooks.map((n) => (n.id === nbId ? { ...n, pages: n.pages.map((x) => (x.id === meta.id ? meta : x)) } : n))
  }
  index.setLibrary(library)
}

beforeEach(() => {
  library = createStarterLibrary()
  math = library.notebooks[0]!
  physics = library.notebooks[1]!
  canvas = math.pages[0]!
  quadratics = { ...createPageMeta('Quadratic equations', 'note'), tags: ['algebra', 'exam'] }
  vertex = { ...createPageMeta('Vertex form', 'note'), tags: ['algebra'] }
  forces = { ...createPageMeta('Forces on a ramp', 'note'), tags: ['mechanics'] }
  math.pages.push(quadratics, vertex)
  physics.pages = [forces]
  index = new SearchIndex()
  index.setLibrary(library)

  const page = createPageDoc(math.id, canvas.id)
  page.objects.push({
    id: 'text-000001', type: 'text', author: 'user', createdAt: 0, x: 0, y: 0, width: 300,
    text: 'Discriminant b² − 4ac decides the roots', color: '#000000', fontSize: 20, font: 'sans'
  })
  index.upsertPage(page)
  index.upsertNote(createNoteDoc(math.id, quadratics.id, doc(p('Factor, then set each factor to zero. Check the signs!'), p('See '), ref(vertex.id, 'Vertex form'))))
  index.upsertNote(createNoteDoc(math.id, vertex.id, doc(p('Complete the square: y = a(x-h)^2 + k'))))
  index.upsertNote(createNoteDoc(physics.id, forces.id, doc(p('Résumé: normal force and friction'), ref(quadratics.id))))
})

describe('search', () => {
  it('folds case and accents without changing string length', () => {
    expect(fold('Résumé ÉCOLE')).toBe('resume ecole')
    expect(fold('Résumé').length).toBe('Résumé'.length)
    expect(parseQuery('  #Algebra  Signs ')).toEqual({ terms: ['signs'], tags: ['algebra'] })
  })

  it('finds words inside notes with a highlighted snippet', () => {
    const [hit] = index.search('signs')
    expect(hit?.page.pageId).toBe(quadratics.id)
    expect(hit?.fields).toContain('text')
    const [a, b] = hit!.snippetRanges[0]!
    expect(hit!.snippet.slice(a, b).toLowerCase()).toBe('signs')
  })

  it('finds text boxes on handwritten pages but not handwriting', () => {
    const hits = index.search('discriminant')
    expect(hits.map((h) => h.page.pageId)).toEqual([canvas.id])
    expect(hits[0]?.page.kind).toBe('canvas')
  })

  it('ranks title matches first and requires every term', () => {
    const hits = index.search('vertex')
    expect(hits[0]?.page.pageId).toBe(vertex.id)
    expect(hits[0]?.titleRanges).toEqual([[0, 6]])
    expect(index.search('vertex friction')).toEqual([])
  })

  it('matches accents loosely, tags with #, and filters by notebook', () => {
    expect(index.search('resume')[0]?.page.pageId).toBe(forces.id)
    expect(index.search('#algebra').map((h) => h.page.pageId).sort()).toEqual([quadratics.id, vertex.id].sort())
    expect(index.search('#algebra square').map((h) => h.page.pageId)).toEqual([vertex.id])
    expect(index.search('factor', { notebookId: physics.id })).toEqual([])
  })

  it('matches pages through the titles of notes they link to', () => {
    const hit = index.search('quadratic').find((h) => h.page.pageId === forces.id)
    expect(hit?.fields).toContain('link')
    expect(hit?.linkedTitles).toEqual(['Quadratic equations'])
  })

  it('follows renames, trash and restore without re-indexing content', () => {
    setPage(math.id, { ...vertex, title: 'Completing the square' })
    expect(index.search('completing')[0]?.page.pageId).toBe(vertex.id)
    expect(index.search('vertex form').map((h) => h.page.pageId)).not.toContain(vertex.id)

    setPage(math.id, { ...quadratics, deletedAt: Date.now() })
    expect(index.search('signs')).toEqual([])
    setPage(math.id, { ...quadratics, deletedAt: null })
    expect(index.search('signs')).toHaveLength(1)
  })

  it('reflects edited content after re-indexing a note', () => {
    index.upsertNote(createNoteDoc(math.id, vertex.id, doc(p('Axis of symmetry x = -b/2a'))))
    expect(index.search('symmetry')[0]?.page.pageId).toBe(vertex.id)
    expect(index.search('square').map((h) => h.page.pageId)).not.toContain(vertex.id)
  })
})

describe('links', () => {
  it('reports outgoing links, backlinks and related notes', () => {
    const q = index.connections(quadratics.id)
    expect(q.outgoing.map((r) => r.pageId)).toEqual([vertex.id])
    expect(q.backlinks.map((r) => r.pageId)).toEqual([forces.id])

    const v = index.connections(vertex.id)
    expect(v.backlinks.map((r) => r.pageId)).toEqual([quadratics.id])
    // forces → quadratics → vertex: two steps away.
    expect(v.related.map((r) => r.pageId)).toContain(forces.id)
  })

  it('relates notes that share tags', () => {
    const extra = { ...createPageMeta('Exam checklist', 'note'), tags: ['exam'] }
    math.pages.push(extra)
    index.setLibrary(library)
    const related = index.connections(quadratics.id).related.find((r) => r.pageId === extra.id)
    expect(related?.reason).toBe('#exam')
  })

  it('keeps links valid when the target is renamed and hides trashed sources', () => {
    setPage(math.id, { ...vertex, title: 'Renamed' })
    expect(index.connections(quadratics.id).outgoing[0]?.title).toBe('Renamed')
    setPage(physics.id, { ...forces, deletedAt: Date.now() })
    expect(index.connections(quadratics.id).backlinks).toEqual([])
  })
})

describe('graph', () => {
  it('builds nodes, edges and clusters from real links', () => {
    const g = index.graph()
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { source: quadratics.id, target: vertex.id },
        { source: forces.id, target: quadratics.id }
      ])
    )
    const node = (id: string) => g.nodes.find((n) => n.pageId === id)!
    expect(node(quadratics.id).degree).toBe(2)
    expect(node(forces.id).cluster).toBe(node(vertex.id).cluster)
    expect(node(canvas.id).cluster).not.toBe(node(vertex.id).cluster)
    const mathOnly = index.graph({ notebookId: math.id })
    expect(mathOnly.nodes.every((n) => n.notebookId === math.id)).toBe(true)
    expect(mathOnly.edges).toEqual([{ source: quadratics.id, target: vertex.id }])
  })
})
