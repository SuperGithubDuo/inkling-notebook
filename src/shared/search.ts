/** Result types of the local search, link and graph index (see main/searchIndex.ts). */
import type { PageRef } from './library'

export type MatchField = 'title' | 'tag' | 'notebook' | 'text' | 'link'

export interface SearchHit {
  page: PageRef
  score: number
  fields: MatchField[]
  /** Character ranges in `page.title` to highlight. */
  titleRanges: [number, number][]
  /** A short excerpt of the matching text (empty if only metadata matched). */
  snippet: string
  snippetRanges: [number, number][]
  /** Titles of linked pages that matched the query. */
  linkedTitles: string[]
}

export interface SearchOptions {
  notebookId?: string
  limit?: number
}

export interface Connections {
  outgoing: PageRef[]
  backlinks: PageRef[]
  /** Pages sharing tags, or linked through a common page. */
  related: (PageRef & { reason: string })[]
}

export interface GraphNode extends PageRef {
  degree: number
  cluster: number
}
export interface GraphData {
  nodes: GraphNode[]
  edges: { source: string; target: string }[]
}
