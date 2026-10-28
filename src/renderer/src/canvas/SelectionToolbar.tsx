import { Copy, CopyPlus, Scissors, Sparkles, Trash2 } from 'lucide-react'
import { openTutorChat } from '@/ai/tutorStore'
import { useStore } from '@/store/store'
import { IconButton } from '@/components/ui/primitives'
import type { Rect } from './geometry'
import type { Camera, Size } from './viewport'

/** Compact action pill floating next to the current selection. */
export function SelectionToolbar({ box, cam, view, below }: { box: Rect; cam: Camera; view: Size; below?: boolean }) {
  const st = useStore.getState()
  const count = useStore((s) => s.selection.length)
  const width = 236
  const left = Math.max(8, Math.min(view.width - width - 8, cam.x + (box.x + box.width / 2) * cam.scale - width / 2))
  const above = cam.y + box.y * cam.scale - 58
  const under = Math.min(view.height - 60, cam.y + (box.y + box.height) * cam.scale + 16)
  // Rotatable selections keep the space above free for the rotation handle.
  const top = !below && above > 8 ? above : under
  return (
    <div
      data-testid="selection-toolbar"
      className="animate-pop absolute z-20 flex items-center gap-0.5 rounded-[14px] border border-line bg-white p-1 shadow-pop"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="px-2 text-[12px] font-medium text-ink-3 tabular-nums">{count}</span>
      <IconButton label="Ask AI about this" onClick={openTutorChat} data-testid="ask-ai-selection" className="!text-lav hover:!bg-lav-softer">
        <Sparkles size={16} />
      </IconButton>
      <IconButton label="Copy" hint="Ctrl+C" onClick={st.copySelection}>
        <Copy size={16} />
      </IconButton>
      <IconButton label="Cut" hint="Ctrl+X" onClick={st.cutSelection}>
        <Scissors size={16} />
      </IconButton>
      <IconButton label="Duplicate" hint="Ctrl+D" onClick={st.duplicateSelection} data-testid="duplicate-selection">
        <CopyPlus size={16} />
      </IconButton>
      <IconButton label="Delete" hint="Del" onClick={st.deleteSelection} className="hover:!text-[#d93d42]" data-testid="delete-selection">
        <Trash2 size={16} />
      </IconButton>
    </div>
  )
}
