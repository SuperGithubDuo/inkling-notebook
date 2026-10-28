/** The mounted note editor and its small dialogs, shared with the top toolbar. */
import { create } from 'zustand'
import type { Editor } from '@tiptap/core'

export type MathDialog = { kind: 'inline' | 'block'; latex: string; pos: number | null }

interface EditorState {
  editor: Editor | null
  math: MathDialog | null
  link: { href: string } | null
  pagePicker: boolean
  /** Text typed into the editor while the picker was opening; becomes its query. */
  pickerSeed: string
  /** Enter was pressed before the picker opened: take the top result. */
  pickerChoose: boolean
  setEditor(editor: Editor | null): void
  openMath(dialog: MathDialog): void
  openLink(): void
  openPagePicker(): void
  close(): void
}

export const useNoteEditor = create<EditorState>()((set, get) => ({
  editor: null,
  math: null,
  link: null,
  pagePicker: false,
  pickerSeed: '',
  pickerChoose: false,
  setEditor: (editor) => set({ editor }),
  openMath: (math) => set({ math, link: null, pagePicker: false }),
  openPagePicker: () => set({ pagePicker: true, pickerSeed: '', pickerChoose: false, math: null, link: null }),
  openLink: () => {
    const href = (get().editor?.getAttributes('link').href as string | undefined) ?? ''
    set({ link: { href }, math: null, pagePicker: false })
  },
  close: () => set({ math: null, link: null, pagePicker: false })
}))
