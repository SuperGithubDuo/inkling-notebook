// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { appendBlocks } from '../../src/renderer/src/services/notebookContext'
import { markdownToDoc } from '../../src/renderer/src/notes/format'

describe('assistant notebook context', () => {
  it('appends Markdown blocks to a note, replacing a trailing empty paragraph', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mine' }] }, { type: 'paragraph' }] }
    const added = markdownToDoc('**Hint:** factor first.\n\n- step one')
    const out = appendBlocks(doc, added.content!)
    expect(out.content!.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'bulletList'])
    expect(out.content![0]).toEqual(doc.content[0])
  })

  it('sanitises appended Markdown like any import', () => {
    const added = markdownToDoc('[x](javascript:alert(1)) ok')
    expect(JSON.stringify(added)).not.toContain('javascript:')
  })
})
