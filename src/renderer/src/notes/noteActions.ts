/** Note-level actions used from menus: Markdown import and export. */
import { selectActiveMeta, selectActiveNotebook, useStore } from '@/store/store'
import { docToMarkdown, markdownToDoc } from './format'
import { resolvePage } from './pages'
import { noteHeadline } from '@shared/noteText'

/** Picks a Markdown file and adds it to the open notebook as a new note. */
export async function importMarkdownNote(): Promise<void> {
  const s = useStore.getState()
  const notebook = selectActiveNotebook(s)
  if (!notebook) return
  const result = await window.inkling.importMarkdown(notebook.id)
  if ('error' in result) return s.setNotice(result.error)
  if ('canceled' in result) return
  const doc = markdownToDoc(result.markdown)
  // A leading "# Title" becomes the note title rather than repeating in the body.
  const first = doc.content?.[0]
  let title = result.name
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    title = noteHeadline({ type: 'doc', content: [first] }) || title
    doc.content = doc.content!.slice(1)
    if (!doc.content.length) doc.content = [{ type: 'paragraph' }]
  }
  useStore.getState().addNote(undefined, { title, doc })
}

/** Saves the open note as Markdown (with its title as a level-1 heading). */
export async function exportActiveNoteMarkdown(): Promise<void> {
  const s = useStore.getState()
  const meta = selectActiveMeta(s)
  const note = meta?.kind === 'note' ? s.notes[meta.id] : undefined
  if (!meta || !note) return
  const body = docToMarkdown(note.doc, { pages: { resolve: resolvePage } })
  const markdown = meta.title ? `# ${meta.title}\n\n${body}` : body
  const result = await window.inkling.exportMarkdown(meta.title || noteHeadline(note.doc) || 'note', markdown)
  if (result.error) s.setNotice(`Export failed: ${result.error}`)
}
