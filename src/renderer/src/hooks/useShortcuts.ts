import { useEffect } from 'react'
import { livePages, selectActiveNotebook, useStore, type Tool } from '@/store/store'
import { activeCanvas } from '@/canvas/stageRef'

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

const TOOL_KEYS: Record<string, Tool> = { p: 'pen', h: 'highlighter', e: 'eraser', t: 'text', l: 'lasso', s: 'shape' }

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
      if (!inNotebook) return
      const hasSel = s.selection.length > 0

      if (mod) {
        const zoom = activeCanvas.handle?.zoom
        switch (key) {
          case 'z':
            e.preventDefault()
            if (e.shiftKey) s.redo()
            else s.undo()
            return
          case 'y':
            e.preventDefault()
            s.redo()
            return
          case 'enter':
            e.preventDefault()
            s.addPage()
            return
          case 'c':
            if (hasSel) (e.preventDefault(), s.copySelection())
            return
          case 'x':
            if (hasSel) (e.preventDefault(), s.cutSelection())
            return
          case 'd':
            if (hasSel) (e.preventDefault(), s.duplicateSelection())
            return
          case 'a': {
            e.preventDefault()
            const page = s.activePageId ? s.pages[s.activePageId] : undefined
            if (page) useStore.setState({ tool: 'lasso', selection: page.objects.map((o) => o.id) })
            return
          }
          case '=':
          case '+':
            e.preventDefault()
            zoom?.('in')
            return
          case '-':
            e.preventDefault()
            zoom?.('out')
            return
          case '0':
            e.preventDefault()
            zoom?.('fit-width')
            return
          case '9':
            e.preventDefault()
            zoom?.('fit-page')
            return
        }
        return
      }
      if (e.altKey) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && hasSel) {
        e.preventDefault()
        s.deleteSelection()
      } else if (e.key === 'Escape') {
        if (hasSel) s.setSelection([])
        else s.setTool('pen')
      } else if (TOOL_KEYS[key]) {
        if (key === 's') s.setShapeTool(s.shapeTool)
        else s.setTool(TOOL_KEYS[key]!)
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        const pages = livePages(selectActiveNotebook(s))
        const i = pages.findIndex((p) => p.id === s.activePageId)
        const next = pages[i + (e.key === 'PageDown' ? 1 : -1)]
        if (next) {
          e.preventDefault()
          s.selectPage(next.id)
        }
      } else if (hasSel && e.key.startsWith('Arrow')) {
        // Nudge the selection; Shift moves further.
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        s.run([{ type: 'moveObjects', ids: s.selection, dx, dy }], { label: 'Nudge' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
