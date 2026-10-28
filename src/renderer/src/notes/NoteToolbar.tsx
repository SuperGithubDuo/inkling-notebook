/** Formatting controls shown in the top bar while a note is open. */
import { useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import {
  Bold,
  ChevronDown,
  Code,
  FileCode2,
  FileSymlink,
  Image,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Sigma,
  Strikethrough,
  Table,
  Underline,
  Undo2
} from 'lucide-react'
import { assetUrl } from '@shared/ipc'
import { selectActiveNotebook, useStore } from '@/store/store'
import { IconButton, Menu, type MenuEntry } from '@/components/ui/primitives'
import { useNoteEditor } from './editorStore'
import { syncSelectionFromDOM } from './syncSelection'

const Divider = () => <span className="mx-1.5 h-6 w-px shrink-0 bg-line" aria-hidden />
const at = (e: React.MouseEvent<HTMLElement>): { x: number; y: number } => {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left, y: r.bottom + 6 }
}

const editorKeys = new WeakMap<Editor, number>()
let nextEditorKey = 0

export function NoteToolbar() {
  const editor = useNoteEditor((s) => s.editor)
  if (!editor) return <div className="flex-1" />
  // useEditorState captures its editor when first mounted and only notices a
  // replacement on that editor's next transaction, so mount it per instance.
  if (!editorKeys.has(editor)) editorKeys.set(editor, nextEditorKey++)
  return <EditorToolbar key={editorKeys.get(editor)} editor={editor} />
}

function EditorToolbar({ editor }: { editor: Editor }) {
  const { openMath, openLink } = useNoteEditor.getState()
  const notebook = useStore(selectActiveNotebook)
  const [menu, setMenu] = useState<{ kind: 'style' | 'math' | 'table'; at: { x: number; y: number } } | null>(null)

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            task: e.isActive('taskList'),
            codeBlock: e.isActive('codeBlock'),
            quote: e.isActive('blockquote'),
            link: e.isActive('link'),
            table: e.isActive('table'),
            heading: ([1, 2, 3] as const).find((level) => e.isActive('heading', { level })) ?? 0,
            canUndo: e.can().undo(),
            canRedo: e.can().redo()
          }
        : null
  })
  if (!state) return <div className="flex-1" />
  const chain = () => editor.chain().focus()

  const insertImage = async (): Promise<void> => {
    if (!notebook) return
    const result = await window.inkling.importImage(notebook.id)
    if ('asset' in result) chain().setImage({ src: assetUrl(notebook.id, result.asset) }).run()
    else if ('error' in result) useStore.getState().setNotice(result.error)
  }

  const styleLabel = state.heading ? `Heading ${state.heading}` : 'Text'
  const menus: Record<'style' | 'math' | 'table', MenuEntry[]> = {
    style: [
      { label: 'Text', hint: state.heading ? undefined : '✓', onSelect: () => chain().setParagraph().run() },
      ...([1, 2, 3] as const).map((level) => ({
        label: `Heading ${level}`,
        hint: state.heading === level ? '✓' : `Ctrl+Alt+${level}`,
        onSelect: () => chain().toggleHeading({ level }).run()
      }))
    ],
    math: [
      { label: 'Inline formula', hint: '$…$', onSelect: () => openMath({ kind: 'inline', latex: '', pos: null }) },
      { label: 'Block formula', hint: '$$$…$$$', onSelect: () => openMath({ kind: 'block', latex: '', pos: null }) }
    ],
    table: state.table
      ? [
          { label: 'Add row below', onSelect: () => chain().addRowAfter().run() },
          { label: 'Add column right', onSelect: () => chain().addColumnAfter().run() },
          { label: 'Toggle header row', onSelect: () => chain().toggleHeaderRow().run() },
          'separator',
          { label: 'Delete row', onSelect: () => chain().deleteRow().run() },
          { label: 'Delete column', onSelect: () => chain().deleteColumn().run() },
          { label: 'Delete table', danger: true, onSelect: () => chain().deleteTable().run() }
        ]
      : [{ label: 'Insert 3 × 3 table', onSelect: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }]
  }

  return (
    <div
      className="flex min-w-0 flex-1 items-center justify-center gap-0.5"
      role="toolbar"
      aria-label="Formatting"
      data-testid="note-toolbar"
      // Keep focus (and the selection) in the editor when a button is clicked;
      // otherwise the next keystroke could land on the button instead.
      onMouseDown={(e) => {
        e.preventDefault()
        syncSelectionFromDOM(editor.view)
      }}
    >
      <button
        type="button"
        data-testid="text-style"
        onClick={(e) => setMenu({ kind: 'style', at: at(e) })}
        className="flex h-9 w-[112px] items-center justify-between rounded-[10px] px-2.5 text-[13.5px] text-ink-2 hover:bg-[#f1f2f4]"
      >
        {styleLabel}
        <ChevronDown size={14} className="text-ink-3" />
      </button>
      <Divider />
      <IconButton label="Bold" hint="Ctrl+B" active={state.bold} onClick={() => chain().toggleBold().run()} data-testid="fmt-bold">
        <Bold size={17} />
      </IconButton>
      <IconButton label="Italic" hint="Ctrl+I" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic size={17} />
      </IconButton>
      <IconButton label="Underline" hint="Ctrl+U" active={state.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline size={17} />
      </IconButton>
      <IconButton label="Strikethrough" hint="Ctrl+Shift+S" active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={17} />
      </IconButton>
      <IconButton label="Inline code" hint="Ctrl+E" active={state.code} onClick={() => chain().toggleCode().run()}>
        <Code size={17} />
      </IconButton>
      <Divider />
      <IconButton label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()} data-testid="fmt-bullet">
        <List size={18} />
      </IconButton>
      <IconButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={18} />
      </IconButton>
      <IconButton label="Checklist" active={state.task} onClick={() => chain().toggleTaskList().run()} data-testid="fmt-task">
        <ListChecks size={18} />
      </IconButton>
      <IconButton label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={17} />
      </IconButton>
      <IconButton label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
        <FileCode2 size={17} />
      </IconButton>
      <Divider />
      <IconButton label="Formula" onClick={(e) => setMenu({ kind: 'math', at: at(e) })} data-testid="fmt-math">
        <Sigma size={17} />
      </IconButton>
      <IconButton label="Table" active={state.table} onClick={(e) => setMenu({ kind: 'table', at: at(e) })} data-testid="fmt-table">
        <Table size={17} />
      </IconButton>
      <IconButton label="Link" hint="Ctrl+K" active={state.link} onClick={openLink} data-testid="fmt-link">
        <Link2 size={17} />
      </IconButton>
      <IconButton label="Link to a page or note" hint="[[" onClick={() => useNoteEditor.getState().openPagePicker()} data-testid="fmt-page-link">
        <FileSymlink size={17} />
      </IconButton>
      <IconButton label="Insert image" onClick={() => void insertImage()}>
        <Image size={17} />
      </IconButton>
      <Divider />
      <IconButton label="Undo" hint="Ctrl+Z" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 size={18} />
      </IconButton>
      <IconButton label="Redo" hint="Ctrl+Shift+Z" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 size={18} />
      </IconButton>
      <Menu at={menu?.at ?? null} items={menu ? menus[menu.kind] : []} onClose={() => setMenu(null)} />
    </div>
  )
}
