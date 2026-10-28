import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * ProseMirror learns about keyboard selection changes from asynchronous
 * `selectionchange` events, so right after Shift+Arrow its selection can lag
 * behind what the user sees. Commands that act on the selection (Ctrl+K,
 * toolbar buttons) call this first to read the browser's selection directly.
 */
export function syncSelectionFromDOM(view: EditorView): void {
  const sel = view.dom.ownerDocument.getSelection()
  if (!sel?.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return
  try {
    const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
    const head = view.posAtDOM(sel.focusNode, sel.focusOffset)
    const current = view.state.selection
    if (anchor === current.anchor && head === current.head) return
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)))
  } catch {
    /* positions inside atoms/node views: keep ProseMirror's own selection */
  }
}
