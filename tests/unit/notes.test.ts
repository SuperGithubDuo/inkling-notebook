// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { docToMarkdown, markdownToDoc } from '../../src/renderer/src/notes/format'
import { noteToPlainText } from '../../src/shared/noteText'
import { migrateLibrary } from '../../src/shared/migrate'
import { librarySchema, noteDocSchema, type NoteNode } from '../../src/shared/schema'
import { createNoteDoc } from '../../src/shared/factory'

const SAMPLE = `# Quadratics

Solve **carefully**, *check* <u>signs</u> and ~~guess~~ less.

- factor first
- then set each factor to zero

1. one
2. two

- [x] checked item
- [ ] open item

| x | y |
| --- | --- |
| -2 | 0 |

\`\`\`python
print("hi")
\`\`\`

Inline $x^2+5x+6=0$ math.

$$
x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}
$$

See [the docs](https://example.com/docs).
`

const find = (n: NoteNode, type: string): NoteNode[] => [...(n.type === type ? [n] : []), ...(n.content ?? []).flatMap((c) => find(c, type))]

describe('rich-text notes', () => {
  it('parses Markdown into every supported structure', () => {
    const doc = markdownToDoc(SAMPLE)
    expect(find(doc, 'heading')[0]?.attrs?.level).toBe(1)
    const marks = find(doc, 'text').flatMap((t) => t.marks?.map((m) => m.type) ?? [])
    expect(marks).toEqual(expect.arrayContaining(['bold', 'italic', 'strike', 'link']))
    expect(find(doc, 'bulletList')).toHaveLength(1)
    expect(find(doc, 'orderedList')).toHaveLength(1)
    expect(find(doc, 'taskItem').map((t) => t.attrs?.checked)).toEqual([true, false])
    expect(find(doc, 'table')).toHaveLength(1)
    expect(find(doc, 'codeBlock')[0]?.attrs?.language).toBe('python')
    expect(find(doc, 'inlineMath')[0]?.attrs?.latex).toBe('x^2+5x+6=0')
    expect(String(find(doc, 'blockMath')[0]?.attrs?.latex)).toContain('\\frac{-b')
    expect(noteDocSchema.safeParse(createNoteDoc('notebook-1', 'note-00001', doc)).success).toBe(true)
  })

  it('round-trips through Markdown without losing structure', () => {
    const doc = markdownToDoc(SAMPLE)
    const again = markdownToDoc(docToMarkdown(doc))
    expect(again).toEqual(doc)
    const md = docToMarkdown(doc)
    expect(md).toContain('- [x] checked item')
    expect(md).toContain('$x^2+5x+6=0$')
    expect(md).toMatch(/\| -2\s+\| 0\s+\|/)
  })

  it('extracts readable text for previews and search', () => {
    const text = noteToPlainText(markdownToDoc(SAMPLE))
    expect(text.split('\n')[0]).toBe('Quadratics')
    expect(text).toContain('Solve carefully, check signs and guess less.')
    expect(text).toContain('x^2+5x+6=0')
    expect(text).toContain('print("hi")')
  })

  it('drops unsafe link protocols', () => {
    const doc = markdownToDoc('[click](javascript:alert(1)) and [ok](https://a.example)')
    const hrefs = find(doc, 'text').flatMap((t) => t.marks?.filter((m) => m.type === 'link').map((m) => m.attrs?.href) ?? [])
    expect(hrefs).toEqual(['https://a.example'])
    const img = markdownToDoc('![x](javascript:alert(1))\n\n![y](inkling-asset://asset/notebook-1/abcdef123456.png)')
    expect(find(img, 'image').map((i) => i.attrs?.src)).toEqual(['inkling-asset://asset/notebook-1/abcdef123456.png'])
  })
})

describe('library v1 → v2 migration', () => {
  it('marks existing pages as canvases with no tags', () => {
    const v1 = {
      schemaVersion: 1,
      folders: [],
      notebooks: [
        {
          id: 'notebook-1', name: 'Math', color: '#3b6fe0', icon: 'sigma', favorite: false, folderId: null,
          createdAt: 1, updatedAt: 1, deletedAt: null,
          pages: [{ id: 'page-00001', title: '', createdAt: 1, updatedAt: 1, deletedAt: null }]
        }
      ]
    }
    const parsed = librarySchema.parse(migrateLibrary(v1))
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.notebooks[0]!.pages[0]).toMatchObject({ kind: 'canvas', tags: [] })
  })
})
