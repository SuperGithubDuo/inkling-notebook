import {
  LIBRARY_SCHEMA_VERSION,
  PAGE_SCHEMA_VERSION,
  type Library,
  type NotebookIcon,
  type NotebookMeta,
  type PageDoc,
  type PageMeta,
  type Paper,
  type PaperType
} from './schema'

export const newId = (): string => crypto.randomUUID()

/** Default page: portrait, roughly A4 proportions in CSS pixels at 1.5x. */
export const PAGE_WIDTH = 1240
export const PAGE_HEIGHT = 1754

export const PAPER_DEFAULTS: Record<PaperType, Paper> = {
  grid: { type: 'grid', spacing: 31, color: '#e8eaee' },
  lined: { type: 'lined', spacing: 40, color: '#dbe3ef' },
  dotted: { type: 'dotted', spacing: 31, color: '#c9ced8' },
  blank: { type: 'blank', spacing: 31, color: '#e4e7ec' }
}

export function createPageMeta(title = ''): PageMeta {
  const now = Date.now()
  return { id: newId(), title, createdAt: now, updatedAt: now, deletedAt: null }
}

export function createPageDoc(notebookId: string, pageId: string, paperType: PaperType = 'grid'): PageDoc {
  return {
    schemaVersion: PAGE_SCHEMA_VERSION,
    id: pageId,
    notebookId,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    paper: { ...PAPER_DEFAULTS[paperType] },
    objects: [],
    updatedAt: Date.now()
  }
}

export function createNotebook(name: string, color: string, icon: NotebookIcon): NotebookMeta {
  const now = Date.now()
  return {
    id: newId(),
    name,
    color,
    icon,
    favorite: false,
    folderId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    pages: [createPageMeta()]
  }
}

/** First-run library: empty subject notebooks so the shelf isn't bare. */
export function createStarterLibrary(): Library {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    folders: [],
    notebooks: [
      createNotebook('Math Notes', '#3b6fe0', 'sigma'),
      createNotebook('Physics', '#f2a516', 'atom'),
      createNotebook('Chemistry', '#ea8a2c', 'flask'),
      createNotebook('Biology', '#2f9e8f', 'leaf'),
      createNotebook('Personal', '#e5484d', 'user')
    ]
  }
}
