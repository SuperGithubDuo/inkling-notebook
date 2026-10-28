/** Markdown ⇄ note document conversion, using the same schema as the editor. */
import { Editor } from '@tiptap/core'
import type { NoteNode } from '@shared/schema'
import { PAGE_LINK_RE } from '@shared/library'
import { noteExtensions, type NoteExtensionOptions } from './extensions'

function headless(content: NoteNode | string, markdown: boolean, options: NoteExtensionOptions = {}): Editor {
  return new Editor({
    extensions: noteExtensions(options),
    content: content as never,
    contentType: markdown ? 'markdown' : 'json',
    // No DOM element: the editor only parses and serialises.
    element: null
  })
}

export function markdownToDoc(markdown: string): NoteNode {
  const editor = headless(markdown, true)
  try {
    return linksToRefs(sanitizeNoteDoc(editor.getJSON() as NoteNode))
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

/**
 * Turns portable `inkling://page/<id>` Markdown links back into internal
 * page-link nodes (the link text becomes the fallback label).
 */
export function linksToRefs(node: NoteNode): NoteNode {
  if (!node.content) return node
  const content: NoteNode[] = []
  for (const child of node.content) {
    const link = child.type === 'text' ? child.marks?.find((m) => m.type === 'link') : undefined
    const match = link ? PAGE_LINK_RE.exec(String(link.attrs?.href ?? '')) : null
    const prev = content[content.length - 1]
    if (match) {
      // Adjacent text pieces of the same link (e.g. partly bold) merge into one.
      if (prev?.type === 'noteRef' && prev.attrs?.pageId === match[1]) prev.attrs!.label = `${prev.attrs!.label}${child.text ?? ''}`
      else content.push({ type: 'noteRef', attrs: { pageId: match[1], label: child.text ?? '' } })
    } else content.push(linksToRefs(child))
  }
  return { ...node, content }
}

/** Titles of linked pages come from `pages.resolve` when given. */
export function docToMarkdown(doc: NoteNode, options: NoteExtensionOptions = {}): string {
  const editor = headless(doc, false, options)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}
