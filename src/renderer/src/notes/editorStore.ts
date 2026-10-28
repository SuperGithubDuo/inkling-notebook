/** The mounted note editor and its small dialogs, shared with the top toolbar. */
import { create } from 'zustand'
import type { Editor } from '@tiptap/core'

export type MathDialog = { kind: 'inline' | 'block'; latex: string; pos: number | null }

interface EditorState {
  editor: Editor | null
  math: MathDialog | null
  link: { href: string } | null
  setEditor(editor: Editor | null): void
  openMath(dialog: MathDialog): void
  openLink(): void
  close(): void
}

export const useNoteEditor = create<EditorState>()((set, get) => ({
  editor: null,
  math: null,
  link: null,
  setEditor: (editor) => set({ editor }),
  openMath: (math) => set({ math, link: null }),
  openLink: () => {
    const href = (get().editor?.getAttributes('link').href as string | undefined) ?? ''
    set({ link: { href }, math: null })
  },
  close: () => set({ math: null, link: null })
}))
