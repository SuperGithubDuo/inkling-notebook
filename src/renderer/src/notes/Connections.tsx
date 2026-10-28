/** Outgoing links, backlinks and related pages for the open page. */
import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, FileText, Link2, PenLine, Waypoints } from 'lucide-react'
import type { PageRef } from '@shared/library'
import type { Connections as ConnectionsData } from '@shared/search'
import { useStore } from '@/store/store'
import { Popover, cx } from '@/components/ui/primitives'

/** Fetches connections and refreshes them after every completed save. */
export function useConnections(pageId: string): ConnectionsData | null {
  const [data, setData] = useState<ConnectionsData | null>(null)
  const saved = useStore((s) => s.saveStatus.state === 'saved')
  const library = useStore((s) => s.library)
  useEffect(() => {
    if (!saved) return
    let live = true
    window.inkling.connections(pageId).then(
      (d) => live && setData(d),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [pageId, saved, library])
  return data
}

function PageLink({ page, detail }: { page: PageRef; detail?: string }) {
  const openPage = useStore((s) => s.openPage)
  return (
    <button
      type="button"
      data-testid="connection"
      onClick={() => void openPage(page.pageId)}
      disabled={page.trashed}
      className={cx(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] leading-snug hover:bg-white',
        page.trashed && 'cursor-not-allowed opacity-50'
      )}
    >
      {page.kind === 'note' ? <FileText size={14} className="mt-0.5 shrink-0 text-lav" /> : <PenLine size={14} className="mt-0.5 shrink-0 text-accent" />}
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate', page.trashed && 'line-through')}>{page.title}</span>
        <span className="block truncate text-[11.5px] text-ink-3">{page.trashed ? 'in Trash' : (detail ?? page.notebookName)}</span>
      </span>
    </button>
  )
}

function Group({ title, icon, pages, empty, testId }: { title: string; icon: React.ReactNode; pages: (PageRef & { reason?: string })[]; empty: string; testId: string }) {
  return (
    <section data-testid={testId}>
      <h4 className="mb-1 flex items-center gap-1.5 px-2.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
        {icon}
        {title}
        <span className="font-normal">{pages.length || ''}</span>
      </h4>
      {pages.length ? pages.map((p) => <PageLink key={p.pageId} page={p} detail={p.reason} />) : <p className="px-2.5 py-1 text-[12.5px] text-ink-3">{empty}</p>}
    </section>
  )
}

/** Panel at the end of a note. */
export function Connections({ pageId }: { pageId: string }) {
  const data = useConnections(pageId)
  if (!data) return null
  return (
    <footer data-testid="connections" className="mt-14 grid gap-4 rounded-2xl border border-line-soft bg-[#f7f7f9] p-3 sm:grid-cols-3">
      <Group testId="outgoing" title="Links to" icon={<ArrowUpRight size={12} />} pages={data.outgoing} empty="Type [[ to link a page." />
      <Group testId="backlinks" title="Linked from" icon={<ArrowDownLeft size={12} />} pages={data.backlinks} empty="No backlinks yet." />
      <Group testId="related" title="Related" icon={<Waypoints size={12} />} pages={data.related} empty="Shared tags show up here." />
    </footer>
  )
}

/** Small pill on handwritten pages, shown when other notes link to the page. */
export function BacklinksPill({ pageId }: { pageId: string }) {
  const data = useConnections(pageId)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const count = data ? data.backlinks.length : 0
  if (!data || (!count && !data.related.length)) return null
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-testid="backlinks-pill"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
        className="absolute top-3 left-3 z-10 flex h-8 items-center gap-1.5 rounded-[12px] border border-line bg-white/95 px-3 text-[12.5px] text-ink-2 shadow-float backdrop-blur hover:text-ink"
      >
        <Link2 size={14} className="text-lav" />
        {count ? `${count} backlink${count === 1 ? '' : 's'}` : 'Related'}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="start" className="w-[320px] bg-[#f7f7f9] p-2">
        <div className="grid gap-3" onPointerDown={(e) => e.stopPropagation()}>
          <Group testId="backlinks" title="Linked from" icon={<ArrowDownLeft size={12} />} pages={data.backlinks} empty="No backlinks yet." />
          {data.related.length > 0 && <Group testId="related" title="Related" icon={<Waypoints size={12} />} pages={data.related} empty="" />}
        </div>
      </Popover>
    </>
  )
}
