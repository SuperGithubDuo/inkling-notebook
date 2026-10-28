/**
 * The rich-text schema for notes (TipTap 3 / ProseMirror, MIT). One list of
 * extensions is shared by the live editor and the headless Markdown converter,
 * so both read and write exactly the same document shape.
 */
import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Markdown } from '@tiptap/markdown'

export interface NoteExtensionOptions {
  /** Called when the user clicks a formula, to edit its LaTeX. */
  onMathClick?: (kind: 'inline' | 'block', latex: string, pos: number) => void
}

export function noteExtensions(options: NoteExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        // Only web and mail links; anything else (javascript:, file:) is dropped.
        isAllowedUri: (url, ctx) => /^(https?:|mailto:)/i.test(url) || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && ctx.defaultValidate(url)),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null }
      }
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: false }),
    Mathematics.configure({
      katexOptions: { throwOnError: false, strict: false },
      inlineOptions: { onClick: (node, pos) => options.onMathClick?.('inline', String(node.attrs.latex ?? ''), pos) },
      blockOptions: { onClick: (node, pos) => options.onMathClick?.('block', String(node.attrs.latex ?? ''), pos) }
    }),
    Markdown.configure({ markedOptions: { gfm: true } })
  ]
}
