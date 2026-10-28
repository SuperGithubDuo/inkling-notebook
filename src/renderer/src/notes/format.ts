/** Markdown ⇄ note document conversion, using the same schema as the editor. */
import { Editor } from '@tiptap/core'
import type { NoteNode } from '@shared/schema'
import { noteExtensions } from './extensions'

function headless(content: NoteNode | string, markdown: boolean): Editor {
  return new Editor({
    extensions: noteExtensions(),
    content: content as never,
    contentType: markdown ? 'markdown' : 'json',
    // No DOM element: the editor only parses and serialises.
    element: null
  })
}

export function markdownToDoc(markdown: string): NoteNode {
  const editor = headless(markdown, true)
  try {
    return sanitizeNoteDoc(editor.getJSON() as NoteNode)
  } finally {
    editor.destroy()
  }
}

const SAFE_LINK = /^(https?:|mailto:|inkling:\/\/page\/)/i
const SAFE_IMAGE = /^(inkling-asset:\/\/|https:)/i

/**
 * Removes links and images with unsafe URLs (javascript:, file:, data: …).
 * Markdown parsing builds nodes directly, bypassing the editor's paste rules,
 * so every imported document passes through here.
 */
export function sanitizeNoteDoc(node: NoteNode): NoteNode {
  const content = node.content
    ?.filter((c) => c.type !== 'image' || SAFE_IMAGE.test(String(c.attrs?.src ?? '')))
    .map(sanitizeNoteDoc)
  const marks = node.marks?.filter((m) => m.type !== 'link' || SAFE_LINK.test(String(m.attrs?.href ?? '')))
  const out: NoteNode = { ...node }
  if (content) out.content = content
  if (marks) {
    if (marks.length) out.marks = marks
    else delete out.marks
  }
  return out
}

export function docToMarkdown(doc: NoteNode): string {
  const editor = headless(doc, false)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}
