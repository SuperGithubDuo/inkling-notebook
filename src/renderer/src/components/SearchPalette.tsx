/**
 * Universal search (Ctrl+F). Queries the local index in the main process as
 * you type; results open the matching page or note directly.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronDown, CornerDownLeft, FileText, Link2, PenLine, Search, SearchX, Tag } from 'lucide-react'
import type { SearchHit } from '@shared/search'
import { useStore } from '@/store/store'
import { Menu, cx } from './ui/primitives'
import { NotebookIcon } from './NotebookIcon'

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, a)}</Fragment>)
    parts.push(
      <mark key={`m${i}`} className="rounded-[3px] bg-[#fde68a]/70 px-px text-inherit">
        {text.slice(a, b)}
      </mark>
    )
    at = b
  })
  if (at < text.length) parts.push(<Fragment key="end">{text.slice(at)}</Fragment>)
  return <>{parts}</>
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const library = useStore((s) => s.library)
  const openPage = useStore((s) => s.openPage)
  const [query, setQuery] = useState('')
  const [notebookId, setNotebookId] = useState<string | undefined>()
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const request = useRef(0)

  useEffect(() => input.current?.focus(), [])
  // Esc closes the palette wherever focus is (open menus close themselves first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const filterBy = (id: string | undefined): void => {
    setNotebookId(id)
    requestAnimationFrame(() => input.current?.focus())
  }

  useEffect(() => {
    const q = query.trim()
    const id = ++request.current
    if (!q) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      window.inkling.search(q, { notebookId, limit: 60 }).then(
        (results) => {
          // Ignore responses to older keystrokes.
          if (id !== request.current) return
          setHits(results)
          setActive(0)
          setSearching(false)
        },
        () => id === request.current && setSearching(false)
      )
    }, 60)
    return () => clearTimeout(timer)
  }, [query, notebookId])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (hit: SearchHit): void => {
    onClose()
    void openPage(hit.page.pageId)
  }

  const notebooks = library?.notebooks.filter((n) => n.deletedAt === null) ?? []
  const filterName = notebooks.find((n) => n.id === notebookId)?.name ?? 'All notebooks'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#1f2430]/25 pt-[10vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label="Search" data-testid="search-palette" className="animate-pop flex max-h-[76vh] w-[min(680px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl bg-white shadow-pop">
        <div className="flex items-center gap-3 border-b border-line-soft px-5">
          <Search size={18} className="shrink-0 text-ink-3" />
          <input
            ref={input}
            value={query}
            data-testid="search-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
              else if (e.key === 'Enter' && hits[active]) (e.preventDefault(), go(hits[active]!))
            }}
            placeholder="Search notes, pages, text boxes, #tags…"
            className="min-w-0 flex-1 py-4 text-[16px] outline-none placeholder:text-ink-3"
          />
          <button
            type="button"
            data-testid="search-filter"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setFilterMenu({ x: r.left, y: r.bottom + 4 })
            }}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-[#f2f3f5]"
          >
            {filterName}
            <ChevronDown size={13} />
          </button>
        </div>

        <div ref={list} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2" role="listbox" aria-label="Results">
          {!query.trim() && (
            <div className="px-4 py-8 text-center text-[13px] leading-relaxed text-ink-3">
              Search note text, page titles, tags (<code>#algebra</code>), notebook names, text boxes on handwritten pages and PDF
              text.
              <br />
              Handwriting itself isn’t searchable until handwriting recognition is added.
            </div>
          )}
          {query.trim() && !searching && hits.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-[13.5px] text-ink-3">
              <SearchX size={22} />
              No results for “{query.trim()}”
            </div>
          )}
          {hits.map((hit, i) => (
            <button
              key={hit.page.pageId}
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              data-testid="search-result"
              onMouseMove={() => setActive(i)}
              onClick={() => go(hit)}
              className={cx('flex w-full gap-3 rounded-xl px-3 py-2.5 text-left', i === active && 'bg-accent-softer')}
            >
              <span className="mt-0.5 shrink-0">
                {hit.page.kind === 'note' ? <FileText size={17} className="text-lav" /> : <PenLine size={17} className="text-accent" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[14.5px] font-medium text-ink" data-testid="result-title">
                    <Highlighted text={hit.page.title} ranges={hit.titleRanges} />
                  </span>
                  {hit.page.tags.slice(0, 3).map((t) => (
                    <span key={t} className="shrink-0 rounded-full bg-lav-softer px-1.5 text-[11px] text-lav">
                      #{t}
                    </span>
                  ))}
                </span>
                {hit.snippet && (
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-ink-2" data-testid="result-snippet">
                    <Highlighted text={hit.snippet} ranges={hit.snippetRanges} />
                  </span>
                )}
                {hit.linkedTitles.length > 0 && (
                  <span className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-3">
                    <Link2 size={12} /> links to {hit.linkedTitles.join(', ')}
                  </span>
                )}
                {hit.fields.length === 1 && hit.fields[0] === 'tag' && (
                  <span className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-3">
                    <Tag size={12} /> tag match
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 self-start text-[12px] text-ink-3">
                <span className="h-2 w-2 rounded-full" style={{ background: hit.page.notebookColor }} />
                {hit.page.notebookName}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-line-soft px-5 py-2 text-[11.5px] text-ink-3">
          <span>↑↓ to move</span>
          <span className="flex items-center gap-1">
            <CornerDownLeft size={11} /> to open
          </span>
          <span>Esc to close</span>
          <span className="ml-auto">{hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : ''}</span>
        </div>
      </div>

      <Menu
        at={filterMenu}
        onClose={() => setFilterMenu(null)}
        items={[
          { label: 'All notebooks', hint: notebookId ? undefined : '✓', onSelect: () => filterBy(undefined) },
          'separator',
          ...notebooks.map((n) => ({
            label: n.name,
            icon: <NotebookIcon color={n.color} icon={n.icon} size={13} />,
            hint: n.id === notebookId ? '✓' : undefined,
            onSelect: () => filterBy(n.id)
          }))
        ]}
      />
    </div>
  )
}
