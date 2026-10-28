/**
 * Plain-text and link extraction from note documents. Pure functions with no
 * editor dependency, used by previews, search indexing and (later) the AI.
 */
import type { NoteNode } from './schema'

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'listItem',
  'taskItem',
  'tableRow',
  'blockMath',
  'image',
  'horizontalRule'
])

/** The note's readable text, one line per block; formulas as their LaTeX. */
export function noteToPlainText(doc: NoteNode): string {
  const out: string[] = []
  let line = ''
  const flush = (): void => {
    if (line.trim()) out.push(line.replace(/\s+/g, ' ').trim())
    line = ''
  }
  const walk = (n: NoteNode): void => {
    if (n.type === 'text') line += n.text ?? ''
    else if (n.type === 'inlineMath') line += ` ${String(n.attrs?.latex ?? '')} `
    else if (n.type === 'blockMath') {
      flush()
      line = String(n.attrs?.latex ?? '')
      flush()
    } else if (n.type === 'hardBreak') line += ' '
    else if (n.type === 'noteRef') line += String(n.attrs?.label ?? '')
    else if (n.type === 'image') line += String(n.attrs?.alt ?? '')
    else if (n.type === 'tableCell' || n.type === 'tableHeader') line += ' '
    n.content?.forEach(walk)
    if (BLOCKS.has(n.type)) flush()
  }
  walk(doc)
  flush()
  return out.join('\n')
}

/** First heading or line of text, for untitled notes. */
export function noteHeadline(doc: NoteNode): string {
  return noteToPlainText(doc).split('\n', 1)[0]?.slice(0, 120) ?? ''
}
