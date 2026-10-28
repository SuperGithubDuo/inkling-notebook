import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Copy, FilePlus2, Grid3x3, Plus, Trash2 } from 'lucide-react'
import { PAPER_TYPES, type PaperType } from '@shared/schema'
import { livePages, selectActiveNotebook, useStore } from '@/store/store'
import { PageThumbnail } from '@/canvas/PageThumbnail'
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
  const activePageId = useStore((s) => s.activePageId)
  const { selectPage, addPage, duplicatePage, trashPage, movePage, setPaper } = useStore.getState()

  const [menu, setMenu] = useState<{ pageId: string; at: { x: number; y: number } } | null>(null)
  const [paperOpen, setPaperOpen] = useState(false)
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null)
  const paperBtn = useRef<HTMLButtonElement>(null)

  const list = livePages(notebook)
  const activePaper = activePageId ? pages[activePageId]?.paper.type : undefined

  const menuItems = (pageId: string): MenuEntry[] => {
    const i = list.findIndex((p) => p.id === pageId)
    return [
      { label: 'New page after', icon: <FilePlus2 size={15} />, onSelect: () => addPage(pageId) },
      { label: 'Duplicate', icon: <Copy size={15} />, onSelect: () => duplicatePage(pageId) },
      'separator',
      ...PAPER_TYPES.map((t) => ({
        label: `${PAPER_LABEL[t]} paper`,
        icon: <PaperSwatch type={t} />,
        hint: pages[pageId]?.paper.type === t ? '✓' : undefined,
        onSelect: () => setPaper(pageId, t)
      })),
      'separator',
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
          onClick={() => setPaperOpen((o) => !o)}
          className="group relative flex h-8 w-full items-center justify-between rounded-[10px] border border-line bg-white px-2.5 text-[12.5px] text-ink-2 hover:border-[#d9dbe0]"
          aria-label="Paper for this page"
        >
          <span className="flex items-center gap-1.5">
            <Grid3x3 size={14} />
            {activePaper ? PAPER_LABEL[activePaper] : 'Paper'}
          </span>
          <ChevronDown size={13} className="text-ink-3" />
          <Tip text="Paper style for this page" side="bottom" />
        </button>
        <Popover anchor={paperBtn} open={paperOpen} onClose={() => setPaperOpen(false)} align="start" className="w-40 p-1.5">
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
          const doc = pages[meta.id]
          const active = meta.id === activePageId
          return (
            <div key={meta.id} className="relative mb-3">
              {drag && drag.over === i && <div className="absolute -top-2 right-0 left-0 h-[3px] rounded-full bg-accent" />}
              <button
                type="button"
                data-testid="page-thumb"
                draggable
                aria-label={`Page ${i + 1}`}
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
                  'relative block aspect-[1240/1754] w-full overflow-hidden rounded-[8px] bg-white transition-shadow',
                  active ? 'shadow-[0_0_0_2px_var(--color-accent)]' : 'shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_#cfd3da]',
                  drag?.id === meta.id && 'opacity-40'
                )}
              >
                {doc ? <PageThumbnail page={doc} /> : <span className="absolute inset-0 animate-pulse bg-[#f4f4f6]" />}
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
          <Tip text="Add page" side="top" />
        </button>
      </div>

      <Menu at={menu?.at ?? null} items={menu ? menuItems(menu.pageId) : []} onClose={() => setMenu(null)} />
    </div>
  )
}
