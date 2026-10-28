/**
 * Knowledge-graph layout: a d3-force (ISC) simulation run to rest up front, so
 * the drawing is stable and deterministic for the same data.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type SimulationNodeDatum } from 'd3-force'
import type { GraphData, GraphNode } from '@shared/search'

export interface PlacedNode extends GraphNode {
  x: number
  y: number
  r: number
}

export interface Layout {
  nodes: PlacedNode[]
  edges: { source: PlacedNode; target: PlacedNode }[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export const nodeRadius = (degree: number): number => 7 + Math.min(10, Math.sqrt(degree) * 3.2)

type SimNode = GraphNode & SimulationNodeDatum & { r: number }

export function layoutGraph(data: GraphData): Layout {
  // No initial x/y: d3 seeds positions on a deterministic phyllotaxis spiral.
  const nodes: SimNode[] = data.nodes.map((n) => ({ ...n, r: nodeRadius(n.degree) }))
  const byId = new Map(nodes.map((n) => [n.pageId, n]))
  const links = data.edges.map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)! })).filter((l) => l.source && l.target)
  const linkedCount = nodes.filter((n) => n.degree > 0).length
  const ring = 200 + Math.sqrt(linkedCount) * 70

  const sim = forceSimulation<SimNode>(nodes)
    .force('link', forceLink<SimNode, { source: SimNode; target: SimNode }>(links).distance(150).strength(0.6))
    .force('charge', forceManyBody<SimNode>().strength((n) => (n.degree ? -260 : -60)))
    .force('collide', forceCollide<SimNode>((n) => n.r + 48))
    .force('center', forceCenter(0, 0))
    // Unlinked pages settle on an outer ring, keeping linked clusters readable.
    .force('ring', forceRadial<SimNode>(ring, 0, 0).strength((n) => (n.degree ? 0 : 0.35)))
    .stop()
  for (let i = 0; i < 360; i++) sim.tick()

  const placed = nodes as unknown as PlacedNode[]
  const pad = 60
  const bounds = placed.reduce(
    (b, n) => ({ minX: Math.min(b.minX, n.x - pad), minY: Math.min(b.minY, n.y - pad), maxX: Math.max(b.maxX, n.x + pad), maxY: Math.max(b.maxY, n.y + pad) }),
    { minX: -pad, minY: -pad, maxX: pad, maxY: pad }
  )
  return { nodes: placed, edges: links as unknown as Layout['edges'], bounds }
}

/** Convex hull (monotone chain) of points, counter-clockwise. */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Nodes directly connected to `id`, plus `id` itself. */
export function neighbourhood(layout: Layout, id: string): Set<string> {
  const out = new Set([id])
  for (const e of layout.edges) {
    if (e.source.pageId === id) out.add(e.target.pageId)
    if (e.target.pageId === id) out.add(e.source.pageId)
  }
  return out
}
