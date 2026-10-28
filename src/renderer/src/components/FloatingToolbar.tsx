import { Eraser, Highlighter, Lasso, PenLine, Sparkles, Type } from 'lucide-react'
import { useStore, type Tool } from '@/store/store'
import { IconButton } from './ui/primitives'

const QUICK: { tool: Tool; label: string; icon: typeof PenLine }[] = [
  { tool: 'pen', label: 'Pen', icon: PenLine },
  { tool: 'highlighter', label: 'Highlighter', icon: Highlighter },
  { tool: 'eraser', label: 'Eraser', icon: Eraser },
  { tool: 'text', label: 'Text', icon: Type }
]

/** Thumb-reach tool dock at the bottom of the canvas, as on tablets. */
export function FloatingToolbar({ onAskAi }: { onAskAi: () => void }) {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  return (
    <div className="pointer-events-none absolute right-0 bottom-5 left-0 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-[22px] border border-line bg-white/95 p-1.5 pl-2.5 shadow-float backdrop-blur">
        {QUICK.map(({ tool: t, label, icon: Icon }) => (
          <IconButton key={t} label={label} onClick={() => setTool(t)} className={tool === t ? '!bg-[#eef0f4] text-ink' : ''}>
            <Icon size={20} strokeWidth={1.8} />
          </IconButton>
        ))}
        <IconButton label="Lasso select — coming in Phase 2" disabled>
          <Lasso size={20} strokeWidth={1.8} />
        </IconButton>
        <button
          type="button"
          onClick={onAskAi}
          className="ml-1.5 flex h-11 items-center gap-2 rounded-[16px] bg-gradient-to-r from-[#5b55e8] to-[#6d63f0] px-5 text-[15px] font-medium text-white shadow-[0_4px_14px_-4px_rgb(91_85_232/0.6)] hover:brightness-105"
        >
          <Sparkles size={17} />
          Ask AI
        </button>
      </div>
    </div>
  )
}
