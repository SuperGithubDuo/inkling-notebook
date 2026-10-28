import { useState } from 'react'
import { Maximize, Minus, MoveHorizontal, Plus } from 'lucide-react'
import { IconButton, Menu } from '@/components/ui/primitives'
import { fitWidth, type Camera, type Size } from './viewport'

/** Top-right zoom pill (clear of the tool dock at any width). Percent is relative to "fit width" (the default view). */
export function ZoomControls({
  cam,
  page,
  view,
  onAction
}: {
  cam: Camera
  page: Size
  view: Size
  onAction: (a: 'in' | 'out' | 'fit-width' | 'fit-page') => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const pct = Math.round((cam.scale / fitWidth(page, view).scale) * 100)
  return (
    <div
      className="absolute top-3 right-3 z-10 flex items-center rounded-[14px] border border-line bg-white/95 p-1 shadow-float backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <IconButton label="Zoom out" hint="Ctrl+−" size="sm" onClick={() => onAction('out')}>
        <Minus size={15} />
      </IconButton>
      <button
        type="button"
        data-testid="zoom-level"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left - 40, y: r.bottom + 6 })
        }}
        className="h-7 min-w-[52px] rounded-md px-1.5 text-[12.5px] font-medium text-ink-2 tabular-nums hover:bg-[#f1f2f4]"
      >
        {pct}%
      </button>
      <IconButton label="Zoom in" hint="Ctrl+=" size="sm" onClick={() => onAction('in')}>
        <Plus size={15} />
      </IconButton>
      <Menu
        at={menu}
        onClose={() => setMenu(null)}
        items={[
          { label: 'Fit width (reset)', hint: 'Ctrl+0', icon: <MoveHorizontal size={15} />, onSelect: () => onAction('fit-width') },
          { label: 'Fit whole page', hint: 'Ctrl+9', icon: <Maximize size={15} />, onSelect: () => onAction('fit-page') }
        ]}
      />
    </div>
  )
}
