/**
 * Rich-text note view: title, tags and a TipTap editor on a paper column.
 * The editor's JSON is the saved document; every change goes to the store,
 * which saves it through the same debounced, atomic queue as canvas pages.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import { Selection, TextSelection } from '@tiptap/pm/state'
import { X } from 'lucide-react'
import type { NoteNode } from '@shared/schema'
import { assetUrl } from '@shared/ipc'
import { useStore } from '@/store/store'
import { noteExtensions } from './extensions'
import { useNoteEditor } from './editorStore'
import { LinkDialog, MathDialog } from './NoteDialogs'
import { PagePicker } from './PagePicker'
import { pageLinkOptions } from './pages'
import { syncSelectionFromDOM } from './syncSelection'
import { Connections } from './Connections'
import 'katex/dist/katex.min.css'
import './note.css'

export function NoteEditor({ pageId }: { pageId: string }) {
  const revision = useStore((s) => s.noteRevision[pageId] ?? 0)
  // Remount the editor when the note is replaced from disk.
  return <NoteEditorInner key={`${pageId}:${revision}`} pageId={pageId} />
}

function NoteEditorInner({ pageId }: { pageId: string }) {
  const note = useStore((s) => s.notes[pageId])!
  const meta = useStore((s) => s.library?.notebooks.find((n) => n.id === note.notebookId)?.pages.find((p) => p.id === pageId))
  const { updateNote, renamePage, setPageTags } = useStore.getState()
  const { setEditor, openMath } = useNoteEditor.getState()
  const notebookId = note.notebookId

  const extensions = useMemo(
    () => [
      ...noteExtensions({
        onMathClick: (kind, latex, pos) => openMath({ kind, latex, pos }),
        pages: pageLinkOptions(() => useNoteEditor.getState().openPagePicker())
      }),
      Placeholder.configure({ placeholder: 'Start writing… Use the toolbar for headings, lists, tables and formulas.' })
    ],
    [openMath]
  )

  const insertImageFiles = async (view: EditorView, files: File[], pos?: number): Promise<void> => {
    for (const file of files) {
      const result = await window.inkling.saveImageBytes(notebookId, new Uint8Array(await file.arrayBuffer()))
      if ('error' in result) useStore.getState().setNotice(result.error)
      if (!('asset' in result)) continue
      const node = view.state.schema.nodes.image!.create({ src: assetUrl(notebookId, result.asset), alt: file.name.replace(/\.[^.]+$/, '') })
      view.dispatch(pos === undefined ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(pos, node))
    }
  }

  const editor = useEditor({
    extensions,
    content: note.doc as never,
    autofocus: false,
    editorProps: {
      attributes: { class: 'inkling-prose', 'data-testid': 'note-editor', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        void insertImageFiles(view, files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImageFiles(view, files, pos)
        return true
      },
      // While the page picker is opening, keystrokes belong to it, not the note.
      handleTextInput: (_view, _from, _to, text) => {
        const picker = useNoteEditor.getState()
        if (!picker.pagePicker) return false
        useNoteEditor.setState({ pickerSeed: picker.pickerSeed + text })
        return true
      },
      handleKeyDown: (view, event) => {
        if (useNoteEditor.getState().pagePicker) {
          if (event.key === 'Backspace') useNoteEditor.setState((s) => ({ pickerSeed: s.pickerSeed.slice(0, -1) }))
          if (event.key === 'Escape') useNoteEditor.getState().close()
          if (event.key === 'Enter') useNoteEditor.setState({ pickerChoose: true })
          // Enter, arrows etc. wait for the picker instead of editing the note.
          if (event.key.length > 1) return true
        }
        // Ctrl/⌘+Home/End jump to the start/end of the note. The browser's own
        // handling stays inside a table cell when the caret is in a table.
        if ((event.ctrlKey || event.metaKey) && (event.key === 'End' || event.key === 'Home')) {
          const end = event.key === 'End'
          const sel = event.shiftKey
            ? TextSelection.create(view.state.doc, view.state.selection.anchor, Selection[end ? 'atEnd' : 'atStart'](view.state.doc).head)
            : Selection[end ? 'atEnd' : 'atStart'](view.state.doc)
          view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
          return true
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          // Take the selection the user sees before the dialog takes focus.
          syncSelectionFromDOM(view)
          useNoteEditor.getState().openLink()
          return true
        }
        return false
      },
      handleClick: (_view, _pos, event) => {
        // Ctrl/⌘+click opens a web link in the browser.
        const a = (event.target as HTMLElement).closest('a[href]')
        if (!a || !(event.ctrlKey || event.metaKey)) return false
        const href = a.getAttribute('href') ?? ''
        if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank')
        return true
      }
    },
    onUpdate: ({ editor: e }) => updateNote(pageId, e.getJSON() as NoteNode)
  })

  useEffect(() => {
    setEditor(editor)
    return () => {
      if (useNoteEditor.getState().editor === editor) setEditor(null)
    }
  }, [editor, setEditor])

  return (
    <div className="thin-scroll h-full overflow-y-auto bg-[#f1f1f3]" data-testid="note-view">
      <article className="mx-auto my-6 min-h-[calc(100%-48px)] w-[min(820px,calc(100%-48px))] rounded-[6px] bg-paper px-[clamp(24px,6%,64px)] pt-12 pb-40 shadow-[0_1px_3px_rgb(30_36_60/0.08),0_8px_24px_-12px_rgb(30_36_60/0.18)]">
        <TitleInput value={meta?.title ?? ''} onChange={(t) => renamePage(pageId, t)} onEnter={() => {
            if (!editor) return
            editor.commands.focus('start')
            // TipTap focuses on the next frame; focus now so no keystroke
            // typed right after Enter lands in the title.
            editor.view.focus()
          }} />
        <TagEditor tags={meta?.tags ?? []} onChange={(t) => setPageTags(pageId, t)} />
        <EditorContent editor={editor} />
        <Connections pageId={pageId} />
      </article>
      <MathDialog />
      <LinkDialog />
      <PagePicker currentPageId={pageId} />
    </div>
  )
}

function TitleInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <input
      value={draft}
      data-testid="note-title"
      aria-label="Note title"
      placeholder="Untitled note"
      maxLength={200}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        onChange(draft)
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onEnter()
        }
      }}
      className="w-full bg-transparent text-[30px] leading-tight font-semibold tracking-tight text-ink outline-none placeholder:text-[#c4c7cf]"
    />
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('')
  const add = (): void => {
    const parts = input.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
    if (parts.length) onChange([...tags, ...parts])
    setInput('')
  }
  return (
    <div className="mt-3 mb-6 flex flex-wrap items-center gap-1.5" data-testid="note-tags">
      {tags.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded-full bg-lav-soft py-0.5 pr-1 pl-2.5 text-[12px] font-medium text-lav">
          #{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="rounded-full p-0.5 hover:bg-white/60">
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={input}
        aria-label="Add tag"
        data-testid="tag-input"
        placeholder={tags.length ? 'Add tag' : 'Add tags…'}
        onChange={(e) => setInput(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !input && tags.length) onChange(tags.slice(0, -1))
        }}
        className="min-w-[90px] flex-1 bg-transparent text-[12.5px] text-ink-2 outline-none placeholder:text-ink-3"
      />
    </div>
  )
}
