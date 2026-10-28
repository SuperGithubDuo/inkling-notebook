import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { selectActiveKind, selectActiveMeta, selectActivePage, useStore } from './store/store'
import { useShortcuts } from './hooks/useShortcuts'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { PageNavigator } from './components/PageNavigator'
import { TutorPanel } from './components/TutorPanel'
import { FloatingToolbar } from './components/FloatingToolbar'
import { LibraryView } from './components/LibraryView'
import { SettingsDialog } from './components/SettingsDialog'
import { SearchPalette } from './components/SearchPalette'
import { PageCanvas } from './canvas/PageCanvas'
import { useAi } from './ai/aiStore'
import { ConsentDialog } from './ai/ConsentDialog'
import { NoteEditor } from './notes/NoteEditor'

const TUTOR_INPUT_ID = 'tutor-input'

export function App() {
  const ready = useStore((s) => s.ready)
  const loadError = useStore((s) => s.loadError)
  const view = useStore((s) => s.view)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const navigatorOpen = useStore((s) => s.navigatorOpen)
  const tutorOpen = useStore((s) => s.tutorOpen)
  const activeKind = useStore(selectActiveKind)
  const searchOpen = useStore((s) => s.searchOpen)
  const settings = useAi((s) => s.settingsOpen)
  const openSettings = useCallback(() => useAi.getState().openSettings(true), [])

  useShortcuts()
  useEffect(() => {
    // Wait for the UI font so canvas text is measured with the right metrics.
    void document.fonts.load('16px Inter').finally(() => useStore.getState().init())
  }, [])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        <LoaderCircle className="animate-spin" />
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <TriangleAlert className="text-[#e5484d]" />
        <p className="font-medium">Inkling couldn't open your library.</p>
        <p className="max-w-md text-[13px] text-ink-2">{loadError}</p>
      </div>
    )
  }

  const askAi = (): void => {
    if (!useStore.getState().tutorOpen) useStore.getState().toggle('tutorOpen')
    requestAnimationFrame(() => document.getElementById(TUTOR_INPUT_ID)?.scrollIntoView())
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <TopBar onOpenSettings={openSettings} />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar />}
        {view.kind === 'notebook' ? (
          <>
            {navigatorOpen && <PageNavigator />}
            <main className="relative min-w-0 flex-1 bg-paper">
              <Notices />
              <ActivePage />
              <FloatingToolbar onAskAi={askAi} compact={activeKind === 'note'} />
            </main>
          </>
        ) : (
          <LibraryView section={view.section} />
        )}
        {tutorOpen && (
          <div className="flex bg-paper">
            <TutorPanel onOpenSettings={openSettings} inputId={TUTOR_INPUT_ID} />
          </div>
        )}
      </div>
      {settings && <SettingsDialog onClose={() => useAi.getState().openSettings(false)} />}
      <ConsentDialog />
      {searchOpen && <SearchPalette onClose={() => useStore.getState().setSearchOpen(false)} />}
    </div>
  )
}

function ActivePage() {
  const page = useStore(selectActivePage)
  const meta = useStore(selectActiveMeta)
  const note = useStore((s) => (s.activePageId ? s.notes[s.activePageId] : undefined))
  if (meta?.kind === 'note' && note) return <NoteEditor key={note.id} pageId={note.id} />
  if (meta?.kind === 'note' || !page) {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        <LoaderCircle className="animate-spin" />
      </div>
    )
  }
  return <PageCanvas key={page.id} pageId={page.id} />
}

/** Recovery and conflict notices: data problems are never silent. */
function Notices() {
  const recovered = useStore((s) => s.recovered)
  const conflict = useStore((s) => s.conflicts.find((c) => c.pageId === s.activePageId))
  const resolve = useStore((s) => s.resolveConflictWithDisk)
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  const [dismissed, setDismissed] = useState(false)
  if (notice) {
    return (
      <div role="alert" className="absolute top-3 right-3 left-3 z-20 flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-[13px] shadow-float">
        <TriangleAlert size={16} className="shrink-0 text-[#c27c0e]" />
        <span className="flex-1">{notice}</span>
        <button type="button" onClick={() => setNotice(null)} className="text-ink-3 hover:text-ink">
          Dismiss
        </button>
      </div>
    )
  }
  if (conflict) {
    return (
      <div role="alert" className="absolute top-3 right-3 left-3 z-20 flex items-center gap-3 rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-4 py-2.5 text-[13px] shadow-float">
        <TriangleAlert size={16} className="shrink-0 text-[#c27c0e]" />
        <span className="flex-1">
          This page was changed by another program, so Inkling stopped saving it. Your version is safe in{' '}
          <code className="text-[12px]">{conflict.conflictPath}</code>.
        </span>
        <button type="button" onClick={() => void resolve(conflict.pageId)} className="shrink-0 rounded-lg bg-white px-3 py-1 font-medium shadow-[0_0_0_1px_#f0d9a8]">
          Load the other version
        </button>
      </div>
    )
  }
  if (recovered.length && !dismissed) {
    return (
      <div role="status" className="absolute top-3 right-3 left-3 z-20 flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-[13px] shadow-float">
        <TriangleAlert size={16} className="shrink-0 text-[#c27c0e]" />
        <span className="flex-1">Recovered from backup after a damaged file was found: {recovered.join(', ')}.</span>
        <button type="button" onClick={() => setDismissed(true)} className="text-ink-3 hover:text-ink">
          Dismiss
        </button>
      </div>
    )
  }
  return null
}
