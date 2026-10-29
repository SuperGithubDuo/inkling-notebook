import { useRef, useState } from 'react'
import {
  FileDown,
  FilePlus2,
  FileText,
  ChevronDown,
  ChevronLeft,
  CloudCheck,
  Ellipsis,
  Eraser,
  Hand,
  Highlighter,
  Lasso,
  LoaderCircle,
  Menu as MenuIcon,
  Mic,
  PanelLeft,
  PenLine,
  Pencil,
  Redo2,
  Settings,
  Share,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Waves
} from 'lucide-react'
import { HIGHLIGHT_COLORS, INK_COLORS, PEN_SIZES, selectActiveKind, selectActiveNotebook, selectActivePage, useStore, type Tool } from '@/store/store'
import { renderPagePng } from '@/canvas/stageRef'
import { IconButton, InlineEdit, Menu, Popover, Tip, cx } from './ui/primitives'
import { NotebookIcon } from './NotebookIcon'
import { useApp } from '@/app/appStore'
import { BookOpen, Info, MessageSquare } from 'lucide-react'
import { ImageButton, ShapePicker } from './ToolControls'
import { NoteToolbar } from '@/notes/NoteToolbar'
import { exportActiveNoteMarkdown, importMarkdownNote } from '@/notes/noteActions'
import { exportActiveNotebookPdf, importPdfIntoNotebook } from '@/pdf/pdfActions'

const TOOLS: { tool: Tool; label: string; key: string; icon: typeof PenLine }[] = [
  { tool: 'pen', label: 'Pen', key: 'P', icon: PenLine },
  { tool: 'highlighter', label: 'Highlighter', key: 'H', icon: Highlighter },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: Eraser }
]


const Divider = () => <span className="mx-1.5 h-6 w-px shrink-0 bg-line" aria-hidden />

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const view = useStore((s) => s.view)
  const notebook = useStore(selectActiveNotebook)
  const page = useStore(selectActivePage)
  const kind = useStore(selectActiveKind)
  const tool = useStore((s) => s.tool)
  const penColor = useStore((s) => s.penColor)
  const highlightColor = useStore((s) => s.highlightColor)
  const tutorOpen = useStore((s) => s.tutorOpen)
  const canUndo = useStore((s) => !!s.activePageId && (s.history[s.activePageId]?.undo.length ?? 0) > 0)
  const canRedo = useStore((s) => !!s.activePageId && (s.history[s.activePageId]?.redo.length ?? 0) > 0)
  const st = useStore.getState()

  const [nameMenu, setNameMenu] = useState<{ x: number; y: number } | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const inNotebook = view.kind === 'notebook' && !!notebook
  const inNote = inNotebook && kind === 'note'
  const openMore = (e: React.MouseEvent<HTMLElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMoreMenu({ x: r.left, y: r.bottom + 6 })
  }
  const colors = tool === 'highlighter' ? HIGHLIGHT_COLORS : INK_COLORS
  const currentColor = tool === 'highlighter' ? highlightColor : penColor

  async function exportPage(): Promise<void> {
    if (!page || !notebook) return
    const png = await renderPagePng(page)
    if (!png) return
    const idx = notebook.pages.filter((p) => p.deletedAt === null).findIndex((p) => p.id === page.id)
    const result = await window.inkling.exportPng(`${notebook.name} - page ${idx + 1}`, png)
    if (result.saved) flash(`Exported to ${result.path}`)
  }

  function flash(text: string): void {
    setNotice(text)
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 3500)
  }

  return (
    <header className="relative flex h-[60px] shrink-0 items-center border-b border-line-soft bg-white px-3">
      {/* Left: navigation + notebook name */}
      <div className="flex w-[clamp(190px,19vw,300px)] min-w-0 shrink-0 items-center gap-1 max-[1180px]:w-[168px]">
        <IconButton
          label={inNotebook ? 'Back to library' : 'Back to notebook'}
          disabled={!inNotebook && !notebook}
          onClick={() => (inNotebook ? st.showSection('notebooks') : notebook && void st.openNotebook(notebook.id))}
        >
          <ChevronLeft size={20} />
        </IconButton>
        <IconButton label="Toggle sidebar" onClick={() => st.toggle('sidebarOpen')}>
          <MenuIcon size={19} />
        </IconButton>
        {inNotebook &&
          (renaming ? (
            <div className="ml-2 w-48">
              <InlineEdit
                value={notebook.name}
                onCommit={(v) => {
                  st.renameNotebook(notebook.id, v)
                  setRenaming(false)
                }}
                onCancel={() => setRenaming(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              data-testid="notebook-title"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setNameMenu({ x: r.left, y: r.bottom + 6 })
              }}
              className="ml-1.5 flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[17px] font-semibold text-ink hover:bg-[#f1f2f4]"
            >
              <span className="truncate">{notebook.name}</span>
              <ChevronDown size={16} className="shrink-0 text-ink-2" />
            </button>
          ))}
      </div>

      {/* Center: formatting tools for notes, drawing tools for pages */}
      {inNote && (
        <>
          <NoteToolbar />
          <IconButton label="More" onClick={openMore} data-testid="more-menu">
            <Ellipsis size={19} />
          </IconButton>
        </>
      )}
      {inNotebook && !inNote && (
        // A size container: as the space between title and status shrinks, the least needed
        // controls fold away (they all have keyboard shortcuts or other places) instead of overlapping.
        <div className="@container flex min-w-0 flex-1 items-center justify-center gap-0.5" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map(({ tool: t, label, key, icon: Icon }) => (
            <IconButton key={t} label={label} hint={key} active={tool === t} onClick={() => st.setTool(t)} data-testid={`tool-${t}`}>
              <Icon size={19} strokeWidth={1.8} />
            </IconButton>
          ))}
          <IconButton label="Lasso select" hint="L" active={tool === 'lasso'} onClick={() => st.setTool('lasso')} data-testid="tool-lasso">
            <Lasso size={19} strokeWidth={1.8} />
          </IconButton>
          <ShapePicker />
          <IconButton label="Text" hint="T" active={tool === 'text'} onClick={() => st.setTool('text')} data-testid="tool-text">
            <Type size={19} strokeWidth={1.8} />
          </IconButton>
          <ImageButton />
          <IconButton label="Audio recording — not yet available" disabled className="@max-[720px]:hidden">
            <Mic size={19} strokeWidth={1.8} />
          </IconButton>
          <Divider />
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`color-${c}`}
              aria-label={`Colour ${c}`}
              aria-pressed={currentColor === c}
              onClick={() => st.setColor(c)}
              className="group relative flex h-9 w-8 items-center justify-center @max-[600px]:w-6"
            >
              <span
                className="h-[18px] w-[18px] rounded-full transition-transform group-hover:scale-110"
                style={{ background: c, boxShadow: currentColor === c && tool !== 'eraser' ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : undefined }}
              />
            </button>
          ))}
          <span className="contents @max-[640px]:hidden">
            <CustomColor value={currentColor} onPick={st.setColor} />
          </span>
          <SizePicker />
          <IconButton label="Hand (pan)" hint="Space" active={tool === 'hand'} onClick={() => st.setTool('hand')} data-testid="tool-hand" className="@max-[680px]:hidden">
            <Hand size={18} strokeWidth={1.8} />
          </IconButton>
          <Divider />
          <IconButton label="Undo" hint="Ctrl+Z" disabled={!canUndo} onClick={st.undo} data-testid="undo">
            <Undo2 size={19} strokeWidth={1.8} />
          </IconButton>
          <IconButton label="Redo" hint="Ctrl+Shift+Z" disabled={!canRedo} onClick={st.redo} data-testid="redo">
            <Redo2 size={19} strokeWidth={1.8} />
          </IconButton>
          <IconButton label="More" onClick={openMore} data-testid="more-menu-canvas">
            <Ellipsis size={19} />
          </IconButton>
        </div>
      )}
      {!inNotebook && <div className="flex-1" />}

      {/* Right: status, tutor, export, settings */}
      <div className="flex min-w-[clamp(250px,19vw,300px)] shrink-0 items-center justify-end gap-1 max-[1180px]:min-w-0">
        <SaveIndicator />
        <button
          type="button"
          data-testid="toggle-tutor"
          aria-pressed={tutorOpen}
          onClick={() => st.toggle('tutorOpen')}
          className={cx(
            'group relative mx-1 flex h-9 shrink-0 items-center gap-1.5 rounded-[11px] px-3.5 text-[14px] font-medium whitespace-nowrap transition-colors max-[1180px]:px-2.5',
            tutorOpen
              ? 'bg-gradient-to-r from-[#8d8cf6] to-[#9fa7fb] text-white shadow-[0_2px_8px_-2px_rgb(109_99_240/0.5)]'
              : 'bg-lav-soft text-lav hover:bg-[#e2dffc]'
          )}
        >
          <Sparkles size={15} />
          {/* Icon only in narrow windows; the name stays for screen readers and the tooltip. */}
          <span className="max-[1180px]:sr-only">AI Tutor</span>
          <Tip text="AI Tutor" />
        </button>
        <IconButton
          label={inNote ? 'Export note as Markdown' : 'Export page as PNG'}
          disabled={!inNotebook}
          onClick={() => void (inNote ? exportActiveNoteMarkdown() : exportPage())}
        >
          <Share size={18} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Settings" onClick={onOpenSettings}>
          <Settings size={19} strokeWidth={1.8} />
        </IconButton>
      </div>

      {notice && (
        <div role="status" className="animate-pop absolute top-[66px] right-4 z-40 max-w-md rounded-lg bg-[#262a33] px-3 py-2 text-[12.5px] text-white shadow-pop">
          {notice}
        </div>
      )}

      {notebook && (
        <Menu
          at={nameMenu}
          onClose={() => setNameMenu(null)}
          header={
            <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
              <NotebookIcon color={notebook.color} icon={notebook.icon} size={18} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{notebook.name}</div>
                <div className="text-[11.5px] text-ink-3">
                  {notebook.pages.filter((p) => p.deletedAt === null).length} pages · edited {new Date(notebook.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          }
          items={[
            { label: 'Rename notebook', icon: <Pencil size={15} />, onSelect: () => setRenaming(true) },
            {
              label: notebook.favorite ? 'Remove from Favourites' : 'Add to Favourites',
              icon: <Star size={15} />,
              onSelect: () => st.toggleFavorite(notebook.id)
            },
            'separator',
            ...(useStore.getState().library?.notebooks ?? [])
              .filter((n) => n.deletedAt === null && n.id !== notebook.id)
              .slice(0, 8)
              .map((n) => ({
                label: n.name,
                icon: <NotebookIcon color={n.color} icon={n.icon} size={13} />,
                onSelect: () => void st.openNotebook(n.id)
              })),
            'separator',
            { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => st.trashNotebook(notebook.id) }
          ]}
        />
      )}

      <Menu
        at={moreMenu}
        onClose={() => setMoreMenu(null)}
        items={[
          { label: 'Add page', hint: 'Ctrl+Enter', icon: <FilePlus2 size={15} />, onSelect: () => st.addPage() },
          { label: 'Add note', icon: <FileText size={15} />, onSelect: () => st.addNote() },
          { label: 'Import Markdown as note…', icon: <FileText size={15} />, onSelect: () => void importMarkdownNote() },
          { label: 'Import PDF…', icon: <FileDown size={15} />, onSelect: () => void importPdfIntoNotebook() },
          { label: 'Toggle page navigator', icon: <PanelLeft size={15} />, onSelect: () => st.toggle('navigatorOpen') },
          inNote
            ? { label: 'Export note as Markdown…', icon: <Share size={15} />, onSelect: () => void exportActiveNoteMarkdown() }
            : { label: 'Export page as PNG…', icon: <Share size={15} />, onSelect: () => void exportPage() },
          { label: 'Export notebook as PDF…', icon: <Share size={15} />, onSelect: () => void exportActiveNotebookPdf() },
          'separator',
          { label: 'Save now', hint: 'Ctrl+S', icon: <CloudCheck size={15} />, onSelect: () => void st.flush() },
          { label: 'Show data folder', icon: <Settings size={15} />, onSelect: () => void window.inkling.showDataFolder() },
          'separator',
          { label: 'Getting started', icon: <BookOpen size={15} />, onSelect: () => useApp.getState().open('welcome') },
          { label: 'Send feedback…', icon: <MessageSquare size={15} />, onSelect: () => void window.inkling.openFeedback() },
          { label: 'About Inkling', icon: <Info size={15} />, onSelect: () => useApp.getState().open('about') }
        ]}
      />
    </header>
  )
}

function CustomColor({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const swatches = ['#1f2430', '#4a5060', '#2563eb', '#0ea5e9', '#6d63f0', '#16a34a', '#e5484d', '#ea8a2c', '#d9468f', '#fde047', '#86efac', '#93c5fd']
  return (
    <>
      <button ref={ref} type="button" aria-label="More colours" onClick={() => setOpen((o) => !o)} className="group relative flex h-9 w-8 items-center justify-center">
        <span className="h-[18px] w-[18px] rounded-full border-2 border-ink-2 p-[2px]">
          <span className="block h-full w-full rounded-full" style={{ background: value }} />
        </span>
        <Tip text="More colours" />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="w-[188px] p-3">
        <div className="grid grid-cols-6 gap-2">
          {swatches.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              onClick={() => onPick(c)}
              className="h-6 w-6 rounded-full transition-transform hover:scale-110"
              style={{ background: c, boxShadow: value === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : 'inset 0 0 0 1px rgb(0 0 0 / 0.08)' }}
            />
          ))}
        </div>
        <label className="mt-3 flex items-center justify-between rounded-lg border border-line px-2 py-1.5 text-[12.5px] text-ink-2">
          Custom
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)} className="h-6 w-9 cursor-pointer rounded border-0 bg-transparent p-0" />
        </label>
      </Popover>
    </>
  )
}

function SizePicker() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const tool = useStore((s) => s.tool)
  const hasSelection = useStore((s) => s.selection.length > 0)
  const eraserMode = useStore((s) => s.eraserMode)
  const color = useStore((s) => (s.tool === 'highlighter' ? s.highlightColor : s.penColor))
  const size = useStore((s) => (s.tool === 'highlighter' ? s.highlightSize : s.tool === 'eraser' ? s.eraserSize : s.penSize))
  const { setSize, setEraserMode } = useStore.getState()
  const kind = tool === 'highlighter' ? 'highlighter' : tool === 'eraser' ? 'eraser' : 'pen'
  const presets = kind === 'highlighter' ? [12, 18, 28] : kind === 'eraser' ? [8, 14, 28] : [...PEN_SIZES]
  const [min, max] = kind === 'highlighter' ? [6, 48] : kind === 'eraser' ? [4, 60] : [1, 16]
  const label =
    tool === 'lasso' && hasSelection
      ? 'Thickness of selection'
      : kind === 'eraser'
        ? 'Eraser'
        : kind === 'highlighter'
          ? 'Highlighter thickness'
          : tool === 'shape'
            ? 'Line thickness'
            : 'Pen thickness'
  const disabled = tool === 'text' || tool === 'hand' || (tool === 'lasso' && !hasSelection)
  return (
    <>
      <IconButton ref={ref} label={label} onClick={() => setOpen((o) => !o)} disabled={disabled} data-testid="size-picker">
        <Waves size={19} strokeWidth={1.8} />
      </IconButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="w-[232px] p-3">
        <div className="mb-2 text-[12px] font-medium text-ink-2">{label}</div>
        {kind === 'eraser' && (
          <div role="radiogroup" aria-label="Eraser mode" className="mb-3 flex rounded-[10px] bg-[#f2f3f6] p-0.5">
            {(
              [
                ['stroke', 'Whole stroke'],
                ['precise', 'Precise']
              ] as const
            ).map(([mode, text]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={eraserMode === mode}
                data-testid={`eraser-${mode}`}
                onClick={() => setEraserMode(mode)}
                className={cx(
                  'h-7 flex-1 rounded-[8px] text-[12px]',
                  eraserMode === mode ? 'bg-white font-medium text-accent shadow-[0_1px_2px_rgb(30_36_60/0.12)]' : 'text-ink-2'
                )}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {kind !== 'eraser' && (
          <svg viewBox="0 0 200 36" className="mb-2 h-9 w-full rounded-lg bg-[#fafafb]" aria-hidden>
            <path
              d="M14 24 C 50 4, 80 4, 100 18 S 160 32, 186 12"
              fill="none"
              stroke={color}
              strokeOpacity={kind === 'highlighter' ? 0.45 : 1}
              strokeWidth={Math.min(26, size * 0.9)}
              strokeLinecap="round"
            />
          </svg>
        )}
        <div className="flex gap-2">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              aria-label={`Size ${p}`}
              onClick={() => setSize(p)}
              className={cx(
                'flex h-10 flex-1 items-center justify-center rounded-lg border',
                size === p ? 'border-accent/50 bg-accent-softer' : 'border-line hover:bg-[#f6f6f8]'
              )}
            >
              <span className="rounded-full bg-ink" style={{ width: Math.min(26, p * 1.4 + 2), height: Math.min(26, p * 1.4 + 2) }} />
            </button>
          ))}
        </div>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={0.5}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="mt-3 w-full accent-[var(--color-accent)]"
        />
      </Popover>
    </>
  )
}

function SaveIndicator() {
  const status = useStore((s) => s.saveStatus)
  const conflicts = useStore((s) => s.conflicts.length)
  const state = conflicts ? 'error' : status.state
  const text =
    state === 'saving' ? 'Saving…' : state === 'error' ? (conflicts ? 'Conflict' : 'Save failed') : 'Saved'
  return (
    <div
      data-testid="save-status"
      data-state={state}
      role="status"
      className={cx(
        'group relative flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px]',
        state === 'error' ? 'bg-[#fdf0f0] text-[#c93a3f]' : 'text-ink-3'
      )}
    >
      {state === 'saving' ? <LoaderCircle size={15} className="animate-spin" /> : state === 'error' ? <TriangleAlert size={15} /> : <CloudCheck size={16} />}
      <span>{text}</span>
      <Tip text={status.message ?? (state === 'saved' ? 'All changes saved on this computer' : text)} />
    </div>
  )
}
