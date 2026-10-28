import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  /** Shortcut hint shown in the tooltip. */
  hint?: string
  size?: 'sm' | 'md'
}

/** Square icon button with an accessible label and hover tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, hint, size = 'md', className, children, disabled, onClick, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      // aria-disabled (not disabled) keeps the explanatory tooltip hoverable.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cx(
        'group relative inline-flex shrink-0 items-center justify-center rounded-[10px] text-ink-2 transition-colors duration-100',
        size === 'md' ? 'h-9 w-9' : 'h-7 w-7',
        active ? 'bg-[#eef0f4] text-ink' : 'hover:bg-[#f1f2f4] hover:text-ink',
        disabled && 'cursor-not-allowed opacity-35 hover:bg-transparent',
        className
      )}
      {...rest}
    >
      {children}
      {active && <span className="absolute -bottom-[3px] left-1/2 h-[2.5px] w-4 -translate-x-1/2 rounded-full bg-accent" />}
      <Tip text={hint ? `${label}  ·  ${hint}` : label} />
    </button>
  )
})

/** CSS-only tooltip; the parent needs `group relative`. */
export function Tip({ text, side = 'bottom' }: { text: string; side?: 'bottom' | 'top' | 'right' }) {
  return (
    <span
      role="presentation"
      className={cx(
        'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-[#262a33] px-2 py-1 text-[11.5px] font-medium text-white opacity-0 shadow-pop transition-opacity delay-300 duration-100 group-hover:opacity-100',
        side === 'bottom' && 'top-[calc(100%+8px)] left-1/2 -translate-x-1/2',
        side === 'top' && 'bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2',
        side === 'right' && 'left-[calc(100%+8px)] top-1/2 -translate-y-1/2'
      )}
    >
      {text}
    </span>
  )
}

function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, refs])
}

/** Small floating panel anchored below an element. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'center',
  className
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const refs = useRef([anchor, panel]).current
  useDismiss(open, onClose, refs)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const a = anchor.current.getBoundingClientRect()
    const w = panel.current?.offsetWidth ?? 0
    let left = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    setPos({ top: a.bottom + 8, left })
  }, [open, anchor, align])

  if (!open) return null
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={cx('animate-pop fixed z-50 rounded-xl border border-line bg-white p-2 shadow-pop', className)}
    >
      {children}
    </div>,
    document.body
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
}
export type MenuEntry = MenuItem | 'separator'

/** Context/dropdown menu rendered at a viewport point. */
export function Menu({
  at,
  items,
  onClose,
  header
}: {
  at: { x: number; y: number } | null
  items: MenuEntry[]
  onClose: () => void
  header?: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const refs = useRef([panel]).current
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useDismiss(!!at, onClose, refs)

  useLayoutEffect(() => {
    if (!at || !panel.current) return
    const { offsetWidth: w, offsetHeight: h } = panel.current
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8))
    })
    panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])

  if (!at) return null
  return createPortal(
    <div
      ref={panel}
      role="menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="animate-pop fixed z-50 min-w-[196px] rounded-xl border border-line bg-white p-1.5 shadow-pop"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }}
    >
      {header}
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 h-px bg-line-soft" />
        ) : (
          <button
            key={i}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] outline-none',
              item.danger ? 'text-[#d93d42] hover:bg-[#fdf0f0] focus:bg-[#fdf0f0]' : 'text-ink hover:bg-[#f2f3f5] focus:bg-[#f2f3f5]',
              item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent'
            )}
          >
            <span className="flex w-4 justify-center text-ink-3">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-[11px] text-ink-3">{item.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** Inline text field that commits on Enter/blur and cancels on Escape. */
export function InlineEdit({
  value,
  onCommit,
  onCancel,
  className
}: {
  value: string
  onCommit: (v: string) => void
  onCancel: () => void
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Name"
      maxLength={120}
      className={cx('w-full rounded-md border border-accent/50 bg-white px-1.5 py-0.5 text-[14px] outline-none ring-2 ring-accent/15', className)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          done.current = true
          onCommit(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          done.current = true
          onCancel()
        }
      }}
      onBlur={(e) => {
        if (!done.current) onCommit(e.currentTarget.value)
      }}
    />
  )
}
