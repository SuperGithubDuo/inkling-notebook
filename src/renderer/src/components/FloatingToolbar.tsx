import { Eraser, Highlighter, Lasso, PenLine, Sparkles } from 'lucide-react'
import { useStore, type Tool } from '@/store/store'
import { IconButton } from './ui/primitives'
import { ShapeGlyph } from './ToolControls'

const QUICK: { tool: Tool; label: string; icon: typeof PenLine }[] = [
  { tool: 'pen', label: 'Pen', icon: PenLine },
  { tool: 'highlighter', label: 'Highlighter', icon: Highlighter },
  { tool: 'eraser', label: 'Eraser', icon: Eraser }
]

/** Thumb-reach tool dock at the bottom of the canvas, as on tablets. */
export function FloatingToolbar({ onAskAi, compact }: { onAskAi: () => void; compact?: boolean }) {
  const tool = useStore((s) => s.tool)
  const shapeTool = useStore((s) => s.shapeTool)
  const { setTool, setShapeTool } = useStore.getState()
  const pill = (active: boolean): string => (active ? '!bg-[#eef0f4] text-ink' : '')
  return (
    <div className="pointer-events-none absolute right-0 bottom-5 left-0 z-10 flex justify-center">
      <div
        className={`pointer-events-auto flex items-center gap-1 rounded-[22px] border border-line bg-white/95 p-1.5 shadow-float backdrop-blur ${compact ? '' : 'pl-2.5'}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {!compact && QUICK.map(({ tool: t, label, icon: Icon }) => (
          <IconButton key={t} label={label} onClick={() => setTool(t)} className={pill(tool === t)}>
            <Icon size={20} strokeWidth={1.8} />
          </IconButton>
        ))}
        {!compact && (
          <>
            <IconButton label="Shapes" onClick={() => setShapeTool(shapeTool)} className={pill(tool === 'shape')}>
              <ShapeGlyph shape={shapeTool} size={20} />
            </IconButton>
            <IconButton label="Lasso select" onClick={() => setTool('lasso')} className={pill(tool === 'lasso')}>
              <Lasso size={20} strokeWidth={1.8} />
            </IconButton>
          </>
        )}
        <button
          type="button"
          onClick={onAskAi}
          className={`${compact ? '' : 'ml-1.5'} flex h-11 items-center gap-2 rounded-[16px] bg-gradient-to-r from-[#5b55e8] to-[#6d63f0] px-5 text-[15px] font-medium text-white shadow-[0_4px_14px_-4px_rgb(91_85_232/0.6)] hover:brightness-105`}
        >
          <Sparkles size={17} />
          Ask AI
        </button>
      </div>
    </div>
  )
}
