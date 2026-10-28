import { useEffect, useState } from 'react'
import { RotateCcw, Star, Trash2, Users } from 'lucide-react'
import type { NoteDoc, NotebookMeta, PageDoc } from '@shared/schema'
import { createNoteDoc, createPageDoc } from '@shared/factory'
import { NoteThumbnail } from '@/notes/NoteThumbnail'
import { livePages, useStore, type Section } from '@/store/store'
import { PageThumbnail } from '@/canvas/PageThumbnail'
import { NotebookIcon } from './NotebookIcon'
import { NotebookMenu } from './NotebookMenu'
import { InlineEdit } from './ui/primitives'

const TITLES: Record<Section, string> = {
  notebooks: 'Notebooks',
  all: 'All Notes',
  favorites: 'Favourites',
  shared: 'Shared',
  trash: 'Trash'
}

/** Read-only page loader for library previews (doesn't touch the editor cache). */
function usePreview(notebookId: string, pageId: string | undefined): PageDoc | undefined {
  const cached = useStore((s) => (pageId ? s.pages[pageId] : undefined))
  const [loaded, setLoaded] = useState<PageDoc>()
  useEffect(() => {
    if (cached || !pageId) return
    let live = true
    window.inkling.loadPage(notebookId, pageId).then(
      // A page that was never written is simply blank.
      (r) => live && setLoaded(r.page ?? createPageDoc(notebookId, pageId)),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [cached, notebookId, pageId])
  return cached ?? loaded
}

const when = (t: number): string =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })

function useNotePreview(notebookId: string, pageId: string | undefined): NoteDoc | undefined {
  const cached = useStore((s) => (pageId ? s.notes[pageId] : undefined))
  const [loaded, setLoaded] = useState<NoteDoc>()
  useEffect(() => {
    if (cached || !pageId) return
    let live = true
    window.inkling.loadNote(notebookId, pageId).then(
      (r) => live && setLoaded(r.note ?? createNoteDoc(notebookId, pageId)),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [cached, notebookId, pageId])
  return cached ?? loaded
}

function NotePreview({ notebookId, pageId, title }: { notebookId: string; pageId: string; title: string }) {
  const note = useNotePreview(notebookId, pageId)
  return note ? <NoteThumbnail note={note} title={title} /> : <div className="h-full w-full bg-[#f7f7f8]" />
}

function CanvasPreview({ notebookId, pageId }: { notebookId: string; pageId?: string }) {
  const page = usePreview(notebookId, pageId)
  return page ? <PageThumbnail page={page} /> : <div className="h-full w-full bg-[#f7f7f8]" />
}

/** Preview of a page of either kind. */
function Preview({ notebookId, pageId }: { notebookId: string; pageId?: string }) {
  const meta = useStore((s) => s.library?.notebooks.find((n) => n.id === notebookId)?.pages.find((p) => p.id === pageId))
  if (meta?.kind === 'note') return <NotePreview notebookId={notebookId} pageId={meta.id} title={meta.title} />
  return <CanvasPreview notebookId={notebookId} pageId={pageId} />
}

function NotebookCard({ nb }: { nb: NotebookMeta }) {
  const open = useStore((s) => s.openNotebook)
  const rename = useStore((s) => s.renameNotebook)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const pages = livePages(nb)
  return (
    <div
      className="group"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <button
        type="button"
        onClick={() => void open(nb.id)}
        className="relative block aspect-[3/4] w-full overflow-hidden rounded-[12px] bg-white shadow-[0_0_0_1px_var(--color-line),0_2px_6px_-2px_rgb(30_36_60/0.08)] transition-shadow group-hover:shadow-[0_0_0_1px_#cfd3da,0_8px_20px_-6px_rgb(30_36_60/0.18)]"
      >
        <Preview notebookId={nb.id} pageId={pages[0]?.id} />
        <span className="absolute inset-y-0 left-0 w-2.5" style={{ background: nb.color }} />
      </button>
      <div className="mt-2.5 flex items-start gap-2">
        <NotebookIcon color={nb.color} icon={nb.icon} size={15} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <InlineEdit
              value={nb.name}
              onCommit={(v) => {
                rename(nb.id, v)
                setRenaming(false)
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <div className="truncate text-[14px] font-medium" onDoubleClick={() => setRenaming(true)}>
              {nb.name}
            </div>
          )}
          <div className="text-[12px] text-ink-3">
            {pages.length} {pages.length === 1 ? 'page' : 'pages'} · {when(nb.updatedAt)}
          </div>
        </div>
        {nb.favorite && <Star size={13} className="mt-0.5 fill-[#f2b316] text-[#f2b316]" />}
      </div>
      <NotebookMenu notebook={nb} at={menu} onClose={() => setMenu(null)} onRename={() => setRenaming(true)} />
    </div>
  )
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="mx-auto mt-20 flex max-w-sm flex-col items-center text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-softer text-accent">{icon}</span>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{body}</p>
    </div>
  )
}

export function LibraryView({ section }: { section: Section }) {
  const library = useStore((s) => s.library)
  const st = useStore.getState()
  if (!library) return null

  const live = library.notebooks.filter((n) => n.deletedAt === null)
  let content: React.ReactNode

  if (section === 'notebooks' || section === 'favorites') {
    const list = section === 'favorites' ? live.filter((n) => n.favorite) : live
    content = list.length ? (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-6 gap-y-7">
        {list.map((nb) => (
          <NotebookCard key={nb.id} nb={nb} />
        ))}
      </div>
    ) : section === 'favorites' ? (
      <Empty icon={<Star size={22} />} title="No favourites yet" body="Right-click a notebook and choose “Add to Favourites” to keep it here." />
    ) : (
      <Empty icon={<Star size={22} />} title="No notebooks" body="Create one with “New Notebook” in the sidebar." />
    )
  } else if (section === 'all') {
    const rows = live
      .flatMap((nb) => livePages(nb).map((p, i) => ({ nb, page: p, index: i })))
      .sort((a, b) => b.page.updatedAt - a.page.updatedAt)
    content = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-5 gap-y-6">
        {rows.map(({ nb, page, index }) => (
          <button key={page.id} type="button" onClick={() => void st.openNotebook(nb.id, page.id)} className="group text-left">
            <span className="block aspect-[1240/1754] overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_var(--color-line)] group-hover:shadow-[0_0_0_1px_#cfd3da,0_8px_20px_-6px_rgb(30_36_60/0.18)]">
              <Preview notebookId={nb.id} pageId={page.id} />
            </span>
            <span className="mt-2 flex items-center gap-1.5 text-[13px] font-medium">
              <NotebookIcon color={nb.color} icon={nb.icon} size={12} />
              <span className="truncate">
                {page.title || `${nb.name} · ${index + 1}`}
              </span>
            </span>
            <span className="text-[11.5px] text-ink-3">Edited {when(page.updatedAt)}</span>
          </button>
        ))}
      </div>
    )
  } else if (section === 'shared') {
    content = (
      <Empty
        icon={<Users size={22} />}
        title="Sharing isn't available yet"
        body="Inkling currently keeps everything on this computer. Sharing needs a sync service, which hasn't been built. You can export any page as a PNG from the notebook toolbar."
      />
    )
  } else {
    const trashedNotebooks = library.notebooks.filter((n) => n.deletedAt !== null)
    const trashedPages = library.notebooks
      .filter((n) => n.deletedAt === null)
      .flatMap((nb) => nb.pages.filter((p) => p.deletedAt !== null).map((p) => ({ nb, page: p })))
    content =
      trashedNotebooks.length + trashedPages.length === 0 ? (
        <Empty icon={<Trash2 size={22} />} title="Trash is empty" body="Deleted notebooks and pages land here until you restore or permanently delete them." />
      ) : (
        <div className="max-w-3xl space-y-1.5">
          {trashedNotebooks.map((nb) => (
            <TrashRow
              key={nb.id}
              icon={<NotebookIcon color={nb.color} icon={nb.icon} size={18} />}
              title={nb.name}
              detail={`Notebook · ${livePages(nb).length} pages · deleted ${when(nb.deletedAt!)}`}
              onRestore={() => st.restoreNotebook(nb.id)}
              onDelete={() => void st.deleteNotebookForever(nb.id)}
            />
          ))}
          {trashedPages.map(({ nb, page }) => (
            <TrashRow
              key={page.id}
              icon={
                <span className="block h-9 w-[26px] overflow-hidden rounded-[4px] shadow-[0_0_0_1px_var(--color-line)]">
                  <Preview notebookId={nb.id} pageId={page.id} />
                </span>
              }
              title={page.title || (page.kind === 'note' ? 'Untitled note' : 'Untitled page')}
              detail={`Page from ${nb.name} · deleted ${when(page.deletedAt!)}`}
              onRestore={() => st.restorePage(nb.id, page.id)}
              onDelete={() => void st.deletePageForever(nb.id, page.id)}
            />
          ))}
        </div>
      )
  }

  return (
    <main className="thin-scroll min-w-0 flex-1 overflow-y-auto bg-paper px-10 py-8" data-testid={`library-${section}`}>
      <h1 className="mb-6 text-[24px] font-semibold tracking-tight">{TITLES[section]}</h1>
      {content}
    </main>
  )
}

function TrashRow(props: { icon: React.ReactNode; title: string; detail: string; onRestore: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3" data-testid="trash-row">
      {props.icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{props.title}</div>
        <div className="text-[12px] text-ink-3">{props.detail}</div>
      </div>
      <button type="button" onClick={props.onRestore} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-accent hover:bg-accent-softer">
        <RotateCcw size={14} /> Restore
      </button>
      {confirm ? (
        <button type="button" onClick={props.onDelete} onBlur={() => setConfirm(false)} autoFocus className="rounded-lg bg-[#e5484d] px-3 py-1.5 text-[13px] font-medium text-white">
          Delete forever?
        </button>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="rounded-lg px-3 py-1.5 text-[13px] text-[#d93d42] hover:bg-[#fdf0f0]">
          Delete…
        </button>
      )}
    </div>
  )
}
