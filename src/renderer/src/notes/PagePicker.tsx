/** Picker for inserting a link to another page or note (opened by `[[` or the toolbar). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileText, PenLine } from 'lucide-react'
import type { PageRef } from '@shared/library'
import { cx } from '@/components/ui/primitives'
import { useNoteEditor } from './editorStore'
import { usePageRefs } from './pages'

const foldText = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function PagePicker({ currentPageId }: { currentPageId: string }) {
  const open = useNoteEditor((s) => s.pagePicker)
  const editor = useNoteEditor((s) => s.editor)
  const close = useNoteEditor((s) => s.close)
  const refs = usePageRefs()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // Focus synchronously on open so no keystroke lands in the note meanwhile.
  useLayoutEffect(() => {
    if (!open) return
    setQuery(useNoteEditor.getState().pickerSeed)
    setActive(0)
    input.current?.focus()
  }, [open])

  const results = useMemo(() => {
    const terms = foldText(query).split(/\s+/).filter(Boolean)
    const currentNotebook = refs.get(currentPageId)?.notebookId
    return [...refs.values()]
      .filter((r) => !r.trashed && r.pageId !== currentPageId)
      .filter((r) => {
        const hay = foldText(`${r.title} ${r.notebookName} ${r.tags.join(' ')}`)
        return terms.every((t) => hay.includes(t))
      })
      // Same notebook first, then most recently edited.
      .sort((a, b) => Number(b.notebookId === currentNotebook) - Number(a.notebookId === currentNotebook) || b.updatedAt - a.updatedAt)
      .slice(0, 50)
  }, [refs, query, currentPageId])

  const choose = (r: PageRef): void => {
    if (!editor) return
    close()
    editor.chain()
      .focus()
      .insertContent([{ type: 'noteRef', attrs: { pageId: r.pageId, label: r.title } }, { type: 'text', text: ' ' }])
      .run()
    // TipTap refocuses on the next frame; do it now so the next keystroke lands.
    editor.view.focus()
  }

  useEffect(() => setActive(0), [query])
  // Enter pressed while the picker was still opening.
  useEffect(() => {
    if (!open || !useNoteEditor.getState().pickerChoose || !results[0] || !editor) return
    useNoteEditor.setState({ pickerChoose: false })
    choose(results[0])
  })
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open || !editor) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#1f2430]/20 pt-[14vh]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal aria-label="Link to a page" className="animate-pop w-[520px] overflow-hidden rounded-2xl bg-white shadow-pop">
        <input
          ref={input}
          value={query}
          data-testid="page-picker-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
            else if (e.key === 'Enter' && results[active]) (e.preventDefault(), choose(results[active]!))
            else if (e.key === 'Escape') (e.preventDefault(), close(), editor.view.focus())
          }}
          placeholder="Link to a page or note…"
          className="w-full border-b border-line-soft px-5 py-4 text-[15px] outline-none placeholder:text-ink-3"
        />
        <div ref={list} className="thin-scroll max-h-[340px] overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">No matching pages.</p>}
          {results.map((r, i) => (
            <button
              key={r.pageId}
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
              className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left', i === active && 'bg-accent-softer')}
            >
              {r.kind === 'note' ? <FileText size={16} className="shrink-0 text-lav" /> : <PenLine size={16} className="shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 truncate text-[14px]">{r.title}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3">
                <span className="h-2 w-2 rounded-full" style={{ background: r.notebookColor }} />
                {r.notebookName}
              </span>
            </button>
          ))}
        </div>
        <div className="flex gap-4 border-t border-line-soft px-5 py-2 text-[11.5px] text-ink-3">
          <span>↑↓ choose</span>
          <span>↵ insert link</span>
          <span>Esc cancel</span>
        </div>
      </div>
    </div>
  )
}
