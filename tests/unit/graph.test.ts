import { describe, expect, it } from 'vitest'
import { convexHull, layoutGraph, neighbourhood } from '../../src/renderer/src/graph/layout'
import type { GraphData, GraphNode } from '../../src/shared/search'

const node = (id: string, degree: number, cluster: number): GraphNode => ({
  pageId: id, notebookId: 'nb', notebookName: 'Math', notebookColor: '#3b6fe0', kind: 'note', title: id,
  tags: [], position: 1, trashed: false, updatedAt: 0, degree, cluster
})

const data: GraphData = {
  nodes: [node('a', 2, 0), node('b', 1, 0), node('c', 1, 0), node('lonely', 0, 1)],
  edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]
}

describe('graph layout', () => {
  it('is deterministic and keeps linked pages closer than unlinked ones', () => {
    const one = layoutGraph(data)
    const two = layoutGraph(data)
    expect(one.nodes.map((n) => [n.x, n.y])).toEqual(two.nodes.map((n) => [n.x, n.y]))
    const at = (id: string) => one.nodes.find((n) => n.pageId === id)!
    const dist = (p: string, q: string) => Math.hypot(at(p).x - at(q).x, at(p).y - at(q).y)
    expect(dist('a', 'b')).toBeLessThan(dist('a', 'lonely'))
    expect(at('a').r).toBeGreaterThan(at('lonely').r)
    for (const n of one.nodes) {
      expect(n.x).toBeGreaterThan(one.bounds.minX)
      expect(n.y).toBeLessThan(one.bounds.maxY)
    }
  })

  it('finds direct neighbours for highlighting', () => {
    const l = layoutGraph(data)
    expect([...neighbourhood(l, 'b')].sort()).toEqual(['a', 'b'])
    expect([...neighbourhood(l, 'a')].sort()).toEqual(['a', 'b', 'c'])
  })

  it('computes convex hulls for cluster outlines', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])
    expect(hull).toHaveLength(4)
    expect(hull).not.toContainEqual([5, 5])
  })
})
