/**
 * Internal link to another page or note. Stores only the target's stable id
 * (plus the title at insertion time as a fallback), and always displays the
 * target's current title, so renaming or moving the target never breaks it.
 * In Markdown it is a portable `[Title](inkling://page/<id>)` link.
 */
import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { pageLinkUrl } from '@shared/library'

export interface PageInfo {
  title: string
  trashed: boolean
}

export interface NoteRefOptions {
  /** Current title/state of a page, or null if it no longer exists. */
  resolve: (pageId: string) => PageInfo | null
  /** Calls `onChange` whenever titles may have changed; returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void
  open: (pageId: string) => void
  /** Called when the user types `[[`. */
  onTrigger: () => void
}

const escapeLabel = (s: string): string => s.replace(/([[\]\\])/g, '\\$1')

export const NoteRef = Node.create<NoteRefOptions>({
  name: 'noteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { resolve: () => null, subscribe: () => () => undefined, open: () => undefined, onTrigger: () => undefined }
  },

  addAttributes() {
    return {
      pageId: { default: null, parseHTML: (el) => el.getAttribute('data-page-id') },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label') ?? el.textContent ?? '' }
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-note-ref]', priority: 1000 }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = String(node.attrs.pageId ?? '')
    const label = this.options.resolve(id)?.title ?? String(node.attrs.label ?? '')
    return [
      'a',
      mergeAttributes(HTMLAttributes, { 'data-note-ref': '', 'data-page-id': id, 'data-label': label, href: pageLinkUrl(id), class: 'note-ref' }),
      label || 'Untitled'
    ]
  },

  renderText({ node }) {
    return this.options.resolve(String(node.attrs.pageId))?.title ?? String(node.attrs.label ?? '')
  },

  renderMarkdown(node) {
    const id = String(node.attrs?.pageId ?? '')
    const label = this.options.resolve(id)?.title ?? String(node.attrs?.label ?? '') ?? 'Untitled'
    return `[${escapeLabel(label || 'Untitled')}](${pageLinkUrl(id)})`
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('a')
      dom.className = 'note-ref'
      dom.setAttribute('data-note-ref', '')
      dom.contentEditable = 'false'
      let current = node
      const paint = (): void => {
        const id = String(current.attrs.pageId ?? '')
        const info = this.options.resolve(id)
        dom.setAttribute('data-page-id', id)
        dom.textContent = info?.title ?? (String(current.attrs.label ?? '') || 'Missing page')
        dom.classList.toggle('note-ref--missing', !info)
        dom.classList.toggle('note-ref--trashed', !!info?.trashed)
        dom.title = !info ? 'This page no longer exists' : info.trashed ? 'In Trash' : `Open “${info.title}”`
      }
      paint()
      const unsubscribe = this.options.subscribe(paint)
      dom.addEventListener('mousedown', (e) => {
        // Single click navigates; it should not move the text cursor first.
        if (e.button !== 0) return
        e.preventDefault()
        const id = String(current.attrs.pageId ?? '')
        if (this.options.resolve(id)) this.options.open(id)
      })
      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false
          current = updated
          paint()
          return true
        },
        destroy: unsubscribe,
        ignoreMutation: () => true
      }
    }
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[$/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to)
          // The picker renders asynchronously; until it has focus, the editor
          // forwards typed characters to it (see NoteEditor), so none are lost.
          this.options.onTrigger()
        }
      })
    ]
  }
})
