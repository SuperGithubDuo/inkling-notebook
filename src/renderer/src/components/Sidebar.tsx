import { useState } from 'react'
import { ChevronDown, Ellipsis, FileText, LibraryBig, Network, Plus, Search, Star, Trash2, Users } from 'lucide-react'
import { useStore, type Section } from '@/store/store'
import { NotebookIcon } from './NotebookIcon'
import { NotebookMenu } from './NotebookMenu'
import { InlineEdit, cx } from './ui/primitives'

const NAV: { section: Section; label: string; icon: typeof FileText }[] = [
  { section: 'notebooks', label: 'Notebooks', icon: LibraryBig },
  { section: 'all', label: 'All Notes', icon: FileText },
  { section: 'favorites', label: 'Favourites', icon: Star },
  { section: 'graph', label: 'Graph', icon: Network },
  { section: 'shared', label: 'Shared', icon: Users },
  { section: 'trash', label: 'Trash', icon: Trash2 }
]

export function Sidebar() {
  const library = useStore((s) => s.library)
  const view = useStore((s) => s.view)
  const activeId = useStore((s) => s.activeNotebookId)
  const { showSection, openNotebook, renameNotebook, createNotebook, setSearchOpen } = useStore.getState()

  const [collapsed, setCollapsed] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null)

  const notebooks = (library?.notebooks ?? []).filter((n) => n.deletedAt === null)
  const trashCount =
    library?.notebooks.reduce((n, nb) => n + (nb.deletedAt ? 1 : nb.pages.filter((p) => p.deletedAt).length), 0) ?? 0
  const menuNotebook = menu ? library?.notebooks.find((n) => n.id === menu.id) : undefined

  return (
    <aside className="flex w-[clamp(180px,14vw,208px)] shrink-0 flex-col border-r border-line-soft bg-panel" aria-label="Library">
      <div className="px-3 pt-3 pb-1">
        <button
          type="button"
          data-testid="open-search"
          onClick={() => setSearchOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-white px-2.5 text-[13px] text-ink-3 hover:border-[#d9dbe0] hover:text-ink-2"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-ink-3">Ctrl F</kbd>
        </button>
      </div>

      <nav className="px-3 pt-2">
        {NAV.map(({ section, label, icon: Icon }) => {
          const active = view.kind === 'library' && view.section === section
          return (
            <button
              key={section}
              type="button"
              onClick={() => showSection(section)}
              className={cx(
                'flex h-[38px] w-full items-center gap-3 rounded-[10px] px-2.5 text-[14.5px] transition-colors',
                active ? 'bg-accent-soft font-medium text-accent' : 'text-ink hover:bg-[#eeeef1]'
              )}
            >
              <Icon size={17} strokeWidth={1.8} className={active ? 'text-accent' : 'text-ink-2'} />
              <span className="flex-1 text-left">{label}</span>
              {section === 'trash' && trashCount > 0 && <span className="text-[11.5px] text-ink-3">{trashCount}</span>}
            </button>
          )
        })}
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1.5">
        <span className="text-[14px] font-semibold text-ink">My Notebooks</span>
        <button
          type="button"
          aria-label={collapsed ? 'Expand notebooks' : 'Collapse notebooks'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="rounded-md p-1 text-ink-3 hover:bg-[#eeeef1] hover:text-ink-2"
        >
          <ChevronDown size={14} className={cx('transition-transform', collapsed && '-rotate-90')} />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!collapsed &&
          notebooks.map((nb) => {
            const active = nb.id === activeId && view.kind === 'notebook'
            return (
              <div
                key={nb.id}
                data-testid="notebook-item"
                className={cx(
                  'group mb-0.5 flex h-[44px] items-center gap-3 rounded-[10px] px-2.5 transition-colors',
                  active ? 'bg-accent-soft' : 'hover:bg-[#eeeef1]'
                )}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: nb.id, at: { x: e.clientX, y: e.clientY } })
                }}
              >
                <NotebookIcon color={nb.color} icon={nb.icon} size={18} />
                {renaming === nb.id ? (
                  <InlineEdit
                    value={nb.name}
                    onCommit={(v) => {
                      renameNotebook(nb.id, v)
                      setRenaming(null)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => void openNotebook(nb.id)}
                    onDoubleClick={() => setRenaming(nb.id)}
                    className={cx('min-w-0 flex-1 truncate text-left text-[14.5px]', active ? 'font-medium text-accent' : 'text-ink')}
                  >
                    {nb.name}
                  </button>
                )}
                {nb.favorite && renaming !== nb.id && <Star size={12} className="fill-[#f2b316] text-[#f2b316]" aria-label="Favourite" />}
                {renaming !== nb.id && (
                  <button
                    type="button"
                    aria-label={`${nb.name} options`}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setMenu({ id: nb.id, at: { x: r.left, y: r.bottom + 4 } })
                    }}
                    className="rounded-md p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-white focus-visible:opacity-100"
                  >
                    <Ellipsis size={15} />
                  </button>
                )}
              </div>
            )
          })}

        <button
          type="button"
          data-testid="new-notebook"
          onClick={() => setRenaming(createNotebook())}
          className="mt-2 flex h-[40px] w-full items-center gap-3 rounded-[10px] px-2.5 text-[14.5px] text-accent hover:bg-accent-softer"
        >
          <Plus size={17} />
          New Notebook
        </button>
      </div>

      {menuNotebook && (
        <NotebookMenu
          notebook={menuNotebook}
          at={menu?.at ?? null}
          onClose={() => setMenu(null)}
          onRename={() => setRenaming(menuNotebook.id)}
        />
      )}
    </aside>
  )
}
