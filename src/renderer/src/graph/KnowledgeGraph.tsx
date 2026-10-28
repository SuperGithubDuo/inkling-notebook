/**
 * Interactive knowledge graph of real notebook links.
 * Nodes are pages and notes, edges are internal links, shaded hulls group
 * connected clusters. Drag or scroll to pan, Ctrl/⌘+scroll or the buttons to
 * zoom. Click selects a node and highlights its connections; double-click,
 * Enter or "Open" opens it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileText, Maximize, Minus, Network, PenLine, Plus } from 'lucide-react'
import type { GraphData } from '@shared/search'
import { useStore } from '@/store/store'
import { IconButton, Menu } from '@/components/ui/primitives'
import { NotebookIcon } from '@/components/NotebookIcon'
import { convexHull, layoutGraph, neighbourhood, type Layout, type PlacedNode } from './layout'

type View = { x: number; y: number; k: number }
const MIN_K = 0.2
const MAX_K = 4

function fitView(layout: Layout, w: number, h: number): View {
  const { minX, minY, maxX, maxY } = layout.bounds
  const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(w / (maxX - minX), h / (maxY - minY)) * 0.95))
  return { k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k }
}

function hullPath(nodes: PlacedNode[]): string {
  const pts = nodes.flatMap((n): [number, number][] => [
    [n.x - n.r, n.y],
    [n.x + n.r, n.y],
    [n.x, n.y - n.r],
    [n.x, n.y + n.r]
  ])
  const hull = convexHull(pts)
  return hull.length ? `M${hull.map((p) => p.join(',')).join('L')}Z` : ''
}

export function KnowledgeGraph() {
  const library = useStore((s) => s.library)
  const openPage = useStore((s) => s.openPage)
  const [notebookId, setNotebookId] = useState<string | undefined>()
  const [showUnlinked, setShowUnlinked] = useState(true)
  const [data, setData] = useState<GraphData | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  // Real link data from the index; refetched when the library changes.
  useEffect(() => {
    let live = true
    window.inkling.graph({ notebookId }).then((g) => live && setData(g))
    return () => {
      live = false
    }
  }, [notebookId, library])

  const layout = useMemo(() => {
    if (!data) return null
    if (showUnlinked) return layoutGraph(data)
    return layoutGraph({ nodes: data.nodes.filter((n) => n.degree > 0), edges: data.edges })
  }, [data, showUnlinked])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const update = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (layout && size.w) setView(fitView(layout, size.w, size.h))
  }, [layout, size])
  useEffect(fit, [fit])
  useEffect(() => {
    if (selected && !layout?.nodes.some((n) => n.pageId === selected)) setSelected(null)
  }, [layout, selected])

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2): void =>
    setView((v) => {
      if (!v) return v
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
      return { k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k }
    })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      else setView((v) => (v ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const focusId = hover ?? selected
  const lit = useMemo(() => (layout && focusId ? neighbourhood(layout, focusId) : null), [layout, focusId])
  const clusters = useMemo(() => {
    const groups = new Map<number, PlacedNode[]>()
    layout?.nodes.forEach((n) => {
      if (!n.degree) return
      groups.set(n.cluster, [...(groups.get(n.cluster) ?? []), n])
    })
    return [...groups.values()].filter((g) => g.length >= 2)
  }, [layout])

  const notebooks = library?.notebooks.filter((n) => n.deletedAt === null) ?? []
  const selectedNode = layout?.nodes.find((n) => n.pageId === selected)
  const connected = selectedNode && layout ? [...neighbourhood(layout, selectedNode.pageId)].filter((id) => id !== selectedNode.pageId) : []
  const nodeById = new Map(layout?.nodes.map((n) => [n.pageId, n]))
  const linkCount = data?.edges.length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="knowledge-graph">
      <div className="flex items-center gap-3 px-10 pt-8 pb-4">
        <h1 className="text-[24px] font-semibold tracking-tight">Graph</h1>
        <span className="text-[13px] text-ink-3" data-testid="graph-summary">
          {layout ? `${layout.nodes.length} pages · ${linkCount} links` : ''}
        </span>
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={showUnlinked} onChange={(e) => setShowUnlinked(e.target.checked)} className="accent-[var(--color-accent)]" />
          Unlinked pages
        </label>
        <button
          type="button"
          data-testid="graph-filter"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom + 4 })
          }}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] text-ink-2 hover:border-[#d9dbe0]"
        >
          {notebooks.find((n) => n.id === notebookId)?.name ?? 'All notebooks'}
          <ChevronDown size={13} />
        </button>
      </div>

      <div
        ref={box}
        className="relative mx-10 mb-8 min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-white select-none"
        style={{ cursor: drag.current?.moved ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-node]')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
          d.x = e.clientX
          d.y = e.clientY
          setView((v) => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v))
        }}
        onPointerUp={() => {
          if (drag.current && !drag.current.moved) setSelected(null)
          drag.current = null
        }}
      >
        {layout && view && (
          <svg width={size.w} height={size.h} className="block" role="group" aria-label="Knowledge graph">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="#9aa3b5" />
              </marker>
              <marker id="arrow-lit" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="#6d63f0" />
              </marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`} data-testid="graph-viewport">
              {clusters.map((group, i) => (
                <path
                  key={i}
                  d={hullPath(group)}
                  fill="rgb(109 99 240 / 0.05)"
                  stroke="rgb(109 99 240 / 0.06)"
                  strokeWidth={56}
                  strokeLinejoin="round"
                  data-testid="graph-cluster"
                />
              ))}
              {layout.edges.map((e, i) => {
                const on = !lit || (lit.has(e.source.pageId) && lit.has(e.target.pageId) && (e.source.pageId === focusId || e.target.pageId === focusId))
                const dx = e.target.x - e.source.x
                const dy = e.target.y - e.source.y
                const len = Math.hypot(dx, dy) || 1
                return (
                  <line
                    key={i}
                    data-testid="graph-edge"
                    x1={e.source.x + (dx / len) * e.source.r}
                    y1={e.source.y + (dy / len) * e.source.r}
                    x2={e.target.x - (dx / len) * (e.target.r + 2)}
                    y2={e.target.y - (dy / len) * (e.target.r + 2)}
                    stroke={lit && on ? '#6d63f0' : '#c3c9d6'}
                    strokeOpacity={on ? 1 : 0.25}
                    strokeWidth={lit && on ? 2 : 1.3}
                    markerEnd={`url(#${lit && on ? 'arrow-lit' : 'arrow'})`}
                  />
                )
              })}
              {layout.nodes.map((n) => {
                const dim = lit && !lit.has(n.pageId)
                const isSel = n.pageId === selected
                return (
                  <g
                    key={n.pageId}
                    data-node
                    data-testid="graph-node"
                    data-page-id={n.pageId}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.title}, ${n.notebookName}, ${n.degree} link${n.degree === 1 ? '' : 's'}`}
                    aria-pressed={isSel}
                    transform={`translate(${n.x} ${n.y})`}
                    opacity={dim ? 0.25 : 1}
                    className="cursor-pointer outline-none"
                    onPointerEnter={() => setHover(n.pageId)}
                    onPointerLeave={() => setHover((h) => (h === n.pageId ? null : h))}
                    onClick={() => setSelected(n.pageId)}
                    onDoubleClick={() => void openPage(n.pageId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void openPage(n.pageId)
                      else if (e.key === ' ') (e.preventDefault(), setSelected(n.pageId))
                    }}
                    onFocus={() => setSelected(n.pageId)}
                  >
                    {isSel && <circle r={n.r + 6} fill="none" stroke="#6d63f0" strokeWidth={2} />}
                    {n.kind === 'note' ? (
                      <circle r={n.r} fill={n.notebookColor} stroke="white" strokeWidth={2} />
                    ) : (
                      <rect x={-n.r} y={-n.r} width={n.r * 2} height={n.r * 2} rx={3} fill={n.notebookColor} stroke="white" strokeWidth={2} />
                    )}
                    <text
                      y={n.r + 14}
                      textAnchor="middle"
                      fontSize={11.5}
                      fill={isSel ? '#1f2430' : '#4a5060'}
                      fontWeight={isSel ? 600 : 400}
                      style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: 3 }}
                    >
                      {n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {layout && layout.nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13.5px] text-ink-3">
            <Network size={24} />
            No linked pages yet. In a note, type [[ to link pages; links appear here.
          </div>
        )}

        <div className="absolute top-3 right-3 flex items-center rounded-[14px] border border-line bg-white/95 p-1 shadow-float" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton label="Zoom out" size="sm" onClick={() => zoomAt(0.8)}>
            <Minus size={15} />
          </IconButton>
          <span className="min-w-[46px] text-center text-[12px] text-ink-2 tabular-nums" data-testid="graph-zoom">
            {view ? `${Math.round(view.k * 100)}%` : ''}
          </span>
          <IconButton label="Zoom in" size="sm" onClick={() => zoomAt(1.25)}>
            <Plus size={15} />
          </IconButton>
          <IconButton label="Fit graph" size="sm" onClick={fit}>
            <Maximize size={14} />
          </IconButton>
        </div>

        <div className="absolute bottom-3 left-3 flex gap-3 rounded-xl bg-white/90 px-3 py-1.5 text-[11.5px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink-3" /> note
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-ink-3" /> handwritten page
          </span>
          <span>colour = notebook · click to select · double-click to open</span>
        </div>

        {selectedNode && (
          <div
            data-testid="graph-selection"
            className="animate-pop absolute top-3 left-3 w-[260px] rounded-2xl border border-line bg-white p-3 shadow-pop"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              {selectedNode.kind === 'note' ? <FileText size={16} className="mt-0.5 text-lav" /> : <PenLine size={16} className="mt-0.5 text-accent" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold" data-testid="graph-selection-title">
                  {selectedNode.title}
                </div>
                <div className="text-[12px] text-ink-3">{selectedNode.notebookName}</div>
              </div>
            </div>
            <div className="mt-2 mb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">Connected · {connected.length}</div>
            <div className="thin-scroll max-h-[180px] overflow-y-auto">
              {connected.map((id) => {
                const n = nodeById.get(id)
                if (!n) return null
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelected(id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-[#f4f5f7]"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: n.notebookColor }} />
                    <span className="truncate">{n.title}</span>
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              data-testid="graph-open"
              onClick={() => void openPage(selectedNode.pageId)}
              className="mt-2 w-full rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white hover:bg-accent-strong"
            >
              Open
            </button>
          </div>
        )}
      </div>

      <Menu
        at={menu}
        onClose={() => setMenu(null)}
        items={[
          { label: 'All notebooks', hint: notebookId ? undefined : '✓', onSelect: () => setNotebookId(undefined) },
          'separator',
          ...notebooks.map((n) => ({
            label: n.name,
            icon: <NotebookIcon color={n.color} icon={n.icon} size={13} />,
            hint: n.id === notebookId ? '✓' : undefined,
            onSelect: () => setNotebookId(n.id)
          }))
        ]}
      />
    </div>
  )
}
