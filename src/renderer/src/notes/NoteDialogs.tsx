/** Small modal dialogs for editing formulas and links in notes. */
import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { useNoteEditor } from './editorStore'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#1f2430]/20 pt-[18vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label={title} className="animate-pop w-[460px] rounded-2xl bg-white p-5 shadow-pop">
        <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

const btn = 'rounded-lg px-3.5 py-1.5 text-[13px] font-medium'

export function MathDialog() {
  const dialog = useNoteEditor((s) => s.math)
  const editor = useNoteEditor((s) => s.editor)
  const close = useNoteEditor((s) => s.close)
  const [latex, setLatex] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    setLatex(dialog?.latex ?? '')
    requestAnimationFrame(() => area.current?.select())
  }, [dialog])

  const preview = useMemo(() => {
    try {
      return { html: katex.renderToString(latex || '\\;', { throwOnError: true, displayMode: dialog?.kind === 'block' }) }
    } catch (err) {
      return { error: (err as Error).message.replace(/^KaTeX parse error: /, '') }
    }
  }, [latex, dialog?.kind])

  if (!dialog || !editor) return null
  const editing = dialog.pos !== null
  const apply = (): void => {
    const chain = editor.chain().focus()
    const value = latex.trim()
    if (editing) {
      const pos = dialog.pos!
      if (!value) (dialog.kind === 'inline' ? chain.deleteInlineMath({ pos }) : chain.deleteBlockMath({ pos })).run()
      else (dialog.kind === 'inline' ? chain.updateInlineMath({ latex: value, pos }) : chain.updateBlockMath({ latex: value, pos })).run()
    } else if (value) {
      ;(dialog.kind === 'inline' ? chain.insertInlineMath({ latex: value }) : chain.insertBlockMath({ latex: value })).run()
    }
    close()
  }

  return (
    <Modal title={`${editing ? 'Edit' : 'Insert'} ${dialog.kind === 'inline' ? 'inline' : 'block'} formula`} onClose={close}>
      <textarea
        ref={area}
        data-testid="math-input"
        value={latex}
        onChange={(e) => setLatex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || dialog.kind === 'inline')) {
            e.preventDefault()
            apply()
          }
        }}
        rows={dialog.kind === 'block' ? 3 : 1}
        spellCheck={false}
        placeholder="LaTeX, e.g. x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}"
        className="w-full resize-none rounded-xl border border-line bg-[#fafafb] px-3 py-2 font-mono text-[13px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
      />
      <div className="mt-3 flex min-h-[56px] items-center justify-center overflow-x-auto rounded-xl border border-line-soft bg-paper px-3 py-2">
        {'html' in preview ? (
          <span dangerouslySetInnerHTML={{ __html: preview.html! }} />
        ) : (
          <span className="text-[12.5px] text-[#c93a3f]">{preview.error}</span>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={close} className={`${btn} text-ink-2 hover:bg-[#f2f3f5]`}>
          Cancel
        </button>
        <button type="button" data-testid="math-apply" onClick={apply} className={`${btn} bg-accent text-white hover:bg-accent-strong`}>
          {editing && !latex.trim() ? 'Remove' : editing ? 'Update' : 'Insert'}
        </button>
      </div>
    </Modal>
  )
}

export function LinkDialog() {
  const dialog = useNoteEditor((s) => s.link)
  const editor = useNoteEditor((s) => s.editor)
  const close = useNoteEditor((s) => s.close)
  const [href, setHref] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setHref(dialog?.href ?? '')
    requestAnimationFrame(() => input.current?.select())
  }, [dialog])
  if (!dialog || !editor) return null

  const normalized = /^[a-z][a-z0-9+.-]*:/i.test(href.trim()) ? href.trim() : href.trim() ? `https://${href.trim()}` : ''
  const valid = !normalized || /^(https?:|mailto:)/i.test(normalized)
  const apply = (): void => {
    if (!valid) return
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!normalized) chain.unsetLink().run()
    else if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: normalized, marks: [{ type: 'link', attrs: { href: normalized } }] }).run()
    } else chain.setLink({ href: normalized }).run()
    close()
  }
  return (
    <Modal title="Link" onClose={close}>
      <input
        ref={input}
        value={href}
        data-testid="link-input"
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), apply())}
        placeholder="https://…"
        className="w-full rounded-xl border border-line bg-[#fafafb] px-3 py-2 text-[13.5px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
      />
      {!valid && <p className="mt-2 text-[12px] text-[#c93a3f]">Only web (https) and email links are allowed.</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={close} className={`${btn} text-ink-2 hover:bg-[#f2f3f5]`}>
          Cancel
        </button>
        <button type="button" onClick={apply} disabled={!valid} className={`${btn} bg-accent text-white hover:bg-accent-strong disabled:opacity-40`}>
          {normalized ? 'Apply' : 'Remove link'}
        </button>
      </div>
    </Modal>
  )
}
