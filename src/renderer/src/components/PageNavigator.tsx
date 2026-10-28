import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Copy, FilePlus2, FileText, Grid3x3, Import, Plus, Trash2 } from 'lucide-react'
import { PAPER_TYPES, type PaperType } from '@shared/schema'
import { PAGE_SIZES, pageSizeOf, type PageSize } from '@shared/factory'
import { livePages, selectActiveNotebook, useStore } from '@/store/store'
import { PageThumbnail } from '@/canvas/PageThumbnail'
import { NoteThumbnail } from '@/notes/NoteThumbnail'
import { importMarkdownNote } from '@/notes/noteActions'
import { Menu, Popover, Tip, cx, type MenuEntry } from './ui/primitives'

export const PAPER_LABEL: Record<PaperType, string> = { grid: 'Grid', lined: 'Lined', dotted: 'Dotted', blank: 'Blank' }

function PaperSwatch({ type }: { type: PaperType }) {
  const bg: Record<PaperType, string> = {
    grid: 'linear-gradient(to right,#d5d9e1 1px,transparent 1px),linear-gradient(to bottom,#d5d9e1 1px,transparent 1px)',
    lined: 'linear-gradient(to bottom,transparent 5px,#d5d9e1 5px)',
    dotted: 'radial-gradient(circle,#b9bfca 1px,transparent 1.3px)',
    blank: 'none'
  }
  return <span className="inline-block h-5 w-4 rounded-[3px] border border-line bg-white" style={{ backgroundImage: bg[type], backgroundSize: '6px 6px' }} />
}

export function PageNavigator() {
  const notebook = useStore(selectActiveNotebook)
  const pages = useStore((s) => s.pages)
  const notes = useStore((s) => s.notes)
  const activePageId = useStore((s) => s.activePageId)
  const { selectPage, addPage, addNote, duplicatePage, trashPage, movePage, setPaper, setPageSize } = useStore.getState()
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null)

  const [menu, setMenu] = useState<{ pageId: string; at: { x: number; y: number } } | null>(null)
  const [paperOpen, setPaperOpen] = useState(false)
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null)
  const paperBtn = useRef<HTMLButtonElement>(null)

  const list = livePages(notebook)
  const activeIsNote = list.find((p) => p.id === activePageId)?.kind === 'note'
  const activeDoc = activePageId && !activeIsNote ? pages[activePageId] : undefined
  const activePaper = activeDoc?.paper.type
  const activeSize = activeDoc ? pageSizeOf(activeDoc) : null

  const menuItems = (pageId: string): MenuEntry[] => {
    const i = list.findIndex((p) => p.id === pageId)
    const isNote = list[i]?.kind === 'note'
    return [
      { label: 'New page after', icon: <FilePlus2 size={15} />, onSelect: () => addPage(pageId) },
      { label: 'New note after', icon: <FileText size={15} />, onSelect: () => addNote(pageId) },
      { label: 'Duplicate', icon: <Copy size={15} />, onSelect: () => duplicatePage(pageId) },
      'separator',
      ...(isNote
        ? []
        : [
            ...PAPER_TYPES.map((t) => ({
              label: `${PAPER_LABEL[t]} paper`,
              icon: <PaperSwatch type={t} />,
              hint: pages[pageId]?.paper.type === t ? '✓' : undefined,
              onSelect: () => setPaper(pageId, t)
            })),
            'separator' as const
          ]),
      { label: 'Move up', icon: <ArrowUp size={15} />, disabled: i <= 0, onSelect: () => movePage(pageId, i - 1) },
      { label: 'Move down', icon: <ArrowDown size={15} />, disabled: i >= list.length - 1, onSelect: () => movePage(pageId, i + 1) },
      'separator',
      { label: 'Delete page', icon: <Trash2 size={15} />, danger: true, onSelect: () => trashPage(pageId) }
    ]
  }

  return (
    <div className="flex w-[122px] shrink-0 flex-col border-r border-line-soft bg-[#f5f5f6]" aria-label="Pages">
      <div className="px-3 pt-3 pb-2">
        <button
          ref={paperBtn}
          type="button"
          onClick={() => !activeIsNote && setPaperOpen((o) => !o)}
          disabled={activeIsNote}
          className="group relative flex h-8 w-full items-center justify-between rounded-[10px] border border-line bg-white px-2.5 text-[12.5px] text-ink-2 hover:border-[#d9dbe0]"
          aria-label="Paper and size for this page"
        >
          <span className="flex items-center gap-1.5">
            {activeIsNote ? <FileText size={14} /> : <Grid3x3 size={14} />}
            {activeIsNote ? 'Note' : activePaper ? PAPER_LABEL[activePaper] : 'Paper'}
          </span>
          <ChevronDown size={13} className="text-ink-3" />
          <Tip text={activeIsNote ? 'Notes have no paper settings' : 'Paper and page size'} side="bottom" />
        </button>
        <Popover anchor={paperBtn} open={paperOpen} onClose={() => setPaperOpen(false)} align="start" className="w-48 p-1.5">
          <div className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">Paper</div>
          {PAPER_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                if (activePageId) setPaper(activePageId, t)
                setPaperOpen(false)
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]',
                activePaper === t ? 'bg-accent-soft text-accent' : 'hover:bg-[#f2f3f5]'
              )}
            >
              <PaperSwatch type={t} />
              {PAPER_LABEL[t]}
            </button>
          ))}
          <div className="mx-1 my-1.5 h-px bg-line-soft" />
          <div className="px-2 pt-0.5 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">Size</div>
          {(Object.keys(PAGE_SIZES) as PageSize[]).map((size) => {
            const { label, width, height } = PAGE_SIZES[size]
            return (
              <button
                key={size}
                type="button"
                data-testid={`page-size-${size}`}
                onClick={() => {
                  if (activePageId) setPageSize(activePageId, size)
                  setPaperOpen(false)
                }}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]',
                  activeSize === size ? 'bg-accent-soft text-accent' : 'hover:bg-[#f2f3f5]'
                )}
              >
                <span className="flex w-4 justify-center">
                  <span className="rounded-[2px] border border-current opacity-70" style={{ width: (14 * width) / 1920, height: (14 * height) / 1920 }} />
                </span>
                {label}
              </button>
            )
          })}
        </Popover>
      </div>

      <div
        className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        onDragOver={(e) => drag && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (drag && drag.over !== null) {
            const from = list.findIndex((p) => p.id === drag.id)
            movePage(drag.id, drag.over > from ? drag.over - 1 : drag.over)
          }
          setDrag(null)
        }}
      >
        {list.map((meta, i) => {
          const doc = meta.kind === 'note' ? undefined : pages[meta.id]
          const note = meta.kind === 'note' ? notes[meta.id] : undefined
          const active = meta.id === activePageId
          return (
            <div key={meta.id} className="relative mb-3">
              {drag && drag.over === i && <div className="absolute -top-2 right-0 left-0 h-[3px] rounded-full bg-accent" />}
              <button
                type="button"
                data-testid="page-thumb"
                draggable
                aria-label={`${meta.kind === 'note' ? 'Note' : 'Page'} ${i + 1}${meta.title ? `: ${meta.title}` : ''}`}
                data-kind={meta.kind}
                aria-current={active ? 'page' : undefined}
                onClick={() => selectPage(meta.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ pageId: meta.id, at: { x: e.clientX, y: e.clientY } })
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', meta.id)
                  setDrag({ id: meta.id, over: null })
                }}
                onDragOver={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const over = e.clientY < r.top + r.height / 2 ? i : i + 1
                  if (over !== drag.over) setDrag({ ...drag, over })
                }}
                onDragEnd={() => setDrag(null)}
                className={cx(
                  'relative block w-full overflow-hidden rounded-[8px] bg-white transition-shadow',
                  active ? 'shadow-[0_0_0_2px_var(--color-accent)]' : 'shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_#cfd3da]',
                  drag?.id === meta.id && 'opacity-40'
                )}
              >
                <span className="block" style={{ aspectRatio: doc ? `${doc.width} / ${doc.height}` : '1240 / 1754' }}>
                  {note ? (
                    <NoteThumbnail note={note} title={meta.title} />
                  ) : doc ? (
                    <PageThumbnail page={doc} />
                  ) : (
                    <span className="block h-full w-full animate-pulse bg-[#f4f4f6]" />
                  )}
                </span>
                {meta.kind === 'note' && (
                  <span className="absolute right-1 bottom-1 rounded bg-lav-soft px-1 text-[8.5px] font-semibold tracking-wide text-lav uppercase">Note</span>
                )}
                <span
                  className={cx(
                    'absolute top-1 left-1.5 text-[10.5px] font-medium',
                    active ? 'text-accent' : 'text-ink-3'
                  )}
                >
                  {i + 1}
                </span>
              </button>
            </div>
          )
        })}
        {drag && drag.over === list.length && <div className="-mt-2 mb-2 h-[3px] rounded-full bg-accent" />}

        <button
          type="button"
          data-testid="add-page"
          onClick={() => addPage(list.at(-1)?.id)}
          className="group relative flex aspect-[1240/1300] w-full items-center justify-center rounded-[8px] border border-line bg-white/60 text-ink-3 transition-colors hover:border-[#cfd3da] hover:bg-white hover:text-ink-2"
          aria-label="Add page"
        >
          <Plus size={22} strokeWidth={1.6} />
          <Tip text="Add handwritten page" side="top" />
        </button>
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            data-testid="add-note"
            onClick={() => addNote(list.at(-1)?.id)}
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded-[8px] border border-line bg-white/60 text-[11.5px] text-ink-2 hover:bg-white hover:text-ink"
          >
            <FileText size={12} /> Note
          </button>
          <button
            type="button"
            data-testid="import-menu"
            aria-label="Import"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setImportMenu({ x: r.left, y: r.bottom + 4 })
            }}
            className="group relative flex h-7 w-8 items-center justify-center rounded-[8px] border border-line bg-white/60 text-ink-2 hover:bg-white hover:text-ink"
          >
            <Import size={13} />
            <Tip text="Import" side="top" />
          </button>
        </div>
      </div>

      <Menu at={menu?.at ?? null} items={menu ? menuItems(menu.pageId) : []} onClose={() => setMenu(null)} />
      <Menu
        at={importMenu}
        onClose={() => setImportMenu(null)}
        items={[{ label: 'Markdown file as note…', icon: <FileText size={15} />, onSelect: () => void importMarkdownNote() }]}
      />
    </div>
  )
}
