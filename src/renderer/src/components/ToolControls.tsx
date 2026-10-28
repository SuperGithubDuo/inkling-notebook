/** Compact toolbar controls with contextual popovers: shapes and image insert. */
import { useRef, useState } from 'react'
import { Image, PaintBucket } from 'lucide-react'
import { selectActiveNotebook, useStore, type ShapeTool } from '@/store/store'
import { activeCanvas } from '@/canvas/stageRef'
import { IconButton, Popover, cx } from './ui/primitives'

export const SHAPE_TOOLS: { id: ShapeTool; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'circle', label: 'Circle' },
  { id: 'triangle', label: 'Triangle' }
]

/** Small line-art glyph for each shape tool. */
export function ShapeGlyph({ shape, size = 19 }: { shape: ShapeTool; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {shape === 'line' && <path d="M5 19L19 5" {...common} />}
      {shape === 'arrow' && <path d="M5 19L19 5M11 5h8v8" {...common} />}
      {shape === 'rect' && <rect x="4" y="6" width="16" height="12" rx="1.5" {...common} />}
      {shape === 'ellipse' && <ellipse cx="12" cy="12" rx="9" ry="6" {...common} />}
      {shape === 'circle' && <circle cx="12" cy="12" r="8" {...common} />}
      {shape === 'triangle' && <path d="M12 4.5L20 19H4z" {...common} />}
    </svg>
  )
}

export function ShapePicker() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const tool = useStore((s) => s.tool)
  const shapeTool = useStore((s) => s.shapeTool)
  const fill = useStore((s) => s.shapeFill)
  const { setShapeTool, setShapeFill } = useStore.getState()
  const active = tool === 'shape'
  return (
    <>
      <IconButton
        ref={ref}
        label="Shapes"
        hint="S"
        active={active}
        data-testid="tool-shape"
        onClick={() => {
          // First click picks the tool; clicking the active tool opens its options.
          if (active) setOpen((o) => !o)
          else setShapeTool(shapeTool)
        }}
      >
        <ShapeGlyph shape={shapeTool} />
      </IconButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="w-[204px] p-2">
        <div className="grid grid-cols-3 gap-1">
          {SHAPE_TOOLS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`shape-${s.id}`}
              aria-label={s.label}
              aria-pressed={shapeTool === s.id}
              onClick={() => {
                setShapeTool(s.id)
                setOpen(false)
              }}
              className={cx(
                'flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10.5px]',
                shapeTool === s.id ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-[#f2f3f5]'
              )}
            >
              <ShapeGlyph shape={s.id} size={18} />
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShapeFill(!fill)}
          aria-pressed={fill}
          className="mt-2 flex w-full items-center justify-between rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-[#f7f7f9]"
        >
          <span className="flex items-center gap-2">
            <PaintBucket size={14} /> Fill shapes
          </span>
          <span className={cx('relative h-[18px] w-8 rounded-full transition-colors', fill ? 'bg-accent' : 'bg-[#d9dbe0]')}>
            <span className={cx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all', fill ? 'left-[16px]' : 'left-[2px]')} />
          </span>
        </button>
        <p className="mt-1.5 px-1 text-[11px] text-ink-3">Hold Shift for squares, circles and 45° lines.</p>
      </Popover>
    </>
  )
}

export function ImageButton() {
  const notebook = useStore(selectActiveNotebook)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="relative">
      <IconButton
        label="Insert image"
        hint="or drop / paste"
        disabled={busy || !notebook}
        data-testid="insert-image"
        onClick={async () => {
          if (!notebook) return
          setBusy(true)
          setError(null)
          try {
            const result = await window.inkling.importImage(notebook.id)
            if ('asset' in result) await activeCanvas.handle?.placeImage(result.asset)
            else if ('error' in result) setError(result.error)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Image size={19} strokeWidth={1.8} />
      </IconButton>
      {error && (
        <span
          role="alert"
          onClick={() => setError(null)}
          className="animate-pop absolute top-11 left-1/2 z-40 w-56 -translate-x-1/2 rounded-lg bg-[#262a33] px-3 py-2 text-[12px] text-white shadow-pop"
        >
          {error}
        </span>
      )}
    </span>
  )
}
