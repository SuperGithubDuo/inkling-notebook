import { useEffect } from 'react'
import { livePages, selectActiveNotebook, useStore } from '@/store/store'

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      // Save and search work everywhere, including while typing.
      if (mod && key === 's') {
        e.preventDefault()
        void s.flush()
        return
      }
      if (mod && key === 'f') {
        e.preventDefault()
        if (!s.sidebarOpen) s.toggle('sidebarOpen')
        requestAnimationFrame(() => document.getElementById('notebook-search')?.focus())
        return
      }
      if (isEditable(e.target)) return
      const inNotebook = s.view.kind === 'notebook'

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        s.redo()
      } else if (mod && e.key === 'Enter' && inNotebook) {
        e.preventDefault()
        s.addPage()
      } else if (!mod && !e.altKey && inNotebook) {
        const tool = ({ p: 'pen', h: 'highlighter', e: 'eraser', t: 'text' } as const)[key as 'p']
        if (tool) s.setTool(tool)
        else if (e.key === 'Escape') s.setTool('pen')
        else if (e.key === 'PageDown' || e.key === 'PageUp') {
          const pages = livePages(selectActiveNotebook(s))
          const i = pages.findIndex((p) => p.id === s.activePageId)
          const next = pages[i + (e.key === 'PageDown' ? 1 : -1)]
          if (next) {
            e.preventDefault()
            s.selectPage(next.id)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
