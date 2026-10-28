/** Live page titles for internal links, backed by the library in the store. */
import { useMemo } from 'react'
import { pageRefs, type PageRef } from '@shared/library'
import type { Library } from '@shared/schema'
import { useStore } from '@/store/store'
import type { NoteRefOptions, PageInfo } from './noteRef'

let cachedFor: Library | null = null
let cached = new Map<string, PageRef>()

export function currentPageRefs(): Map<string, PageRef> {
  const library = useStore.getState().library
  if (library !== cachedFor) {
    cachedFor = library
    cached = library ? pageRefs(library) : new Map()
  }
  return cached
}

export function resolvePage(pageId: string): PageInfo | null {
  const ref = currentPageRefs().get(pageId)
  return ref ? { title: ref.title, trashed: ref.trashed } : null
}

/** Options for the page-link extension, wired to the app store. */
export function pageLinkOptions(onTrigger: () => void): Partial<NoteRefOptions> {
  return {
    resolve: resolvePage,
    subscribe: (onChange) => useStore.subscribe((s, prev) => s.library !== prev.library && onChange()),
    open: (pageId) => void useStore.getState().openPage(pageId),
    onTrigger
  }
}

/** All pages, for pickers and the graph, recomputed when the library changes. */
export function usePageRefs(): Map<string, PageRef> {
  const library = useStore((s) => s.library)
  return useMemo(() => (library ? pageRefs(library) : new Map<string, PageRef>()), [library])
}
