import { FolderOpen, Pencil, Star, Trash2 } from 'lucide-react'
import { NOTEBOOK_ICONS, type NotebookMeta } from '@shared/schema'
import { useStore } from '@/store/store'
import { Menu } from './ui/primitives'
import { ICONS, NOTEBOOK_COLORS } from './NotebookIcon'

/** Context menu for a notebook: open, rename, favourite, colour, icon, trash. */
export function NotebookMenu({
  notebook,
  at,
  onClose,
  onRename
}: {
  notebook: NotebookMeta
  at: { x: number; y: number } | null
  onClose: () => void
  onRename: () => void
}) {
  const s = useStore.getState()
  const header = (
    <div className="px-2 pt-1.5 pb-2">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">Colour</div>
      <div className="flex flex-wrap gap-1.5">
        {NOTEBOOK_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Colour ${c}`}
            onClick={() => s.styleNotebook(notebook.id, { color: c })}
            className="h-5 w-5 rounded-full ring-offset-2 transition-transform hover:scale-110"
            style={{ background: c, boxShadow: notebook.color === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : undefined }}
          />
        ))}
      </div>
      <div className="mt-2.5 mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">Icon</div>
      <div className="flex flex-wrap gap-1">
        {NOTEBOOK_ICONS.map((name) => {
          const Glyph = ICONS[name]
          return (
            <button
              key={name}
              type="button"
              aria-label={`Icon ${name}`}
              onClick={() => s.styleNotebook(notebook.id, { icon: name })}
              className={`flex h-7 w-7 items-center justify-center rounded-md ${notebook.icon === name ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-[#f2f3f5]'}`}
            >
              <Glyph size={15} />
            </button>
          )
        })}
      </div>
      <div className="mt-2 h-px bg-line-soft" />
    </div>
  )
  return (
    <Menu
      at={at}
      onClose={onClose}
      header={header}
      items={[
        { label: 'Open', icon: <FolderOpen size={15} />, onSelect: () => void s.openNotebook(notebook.id) },
        { label: 'Rename', icon: <Pencil size={15} />, onSelect: onRename },
        {
          label: notebook.favorite ? 'Remove from Favourites' : 'Add to Favourites',
          icon: <Star size={15} />,
          onSelect: () => s.toggleFavorite(notebook.id)
        },
        'separator',
        { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => s.trashNotebook(notebook.id) }
      ]}
    />
  )
}
