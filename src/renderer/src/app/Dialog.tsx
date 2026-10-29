/** A centred modal dialog: Escape and the backdrop close it, focus moves into it and returns afterwards. */
import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton, cx } from '@/components/ui/primitives'

export function Dialog({ title, onClose, children, width = 520, testId, hideTitle }: { title: string; onClose: () => void; children: ReactNode; width?: number; testId?: string; hideTitle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-[#1f2430]/25" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label={title}
        data-testid={testId}
        style={{ width }}
        className="animate-pop thin-scroll max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl bg-white p-6 shadow-pop outline-none"
      >
        <div className={cx('flex items-center justify-between', hideTitle ? 'mb-0' : 'mb-4')}>
          {hideTitle ? <span /> : <h2 className="text-[18px] font-semibold">{title}</h2>}
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  )
}
