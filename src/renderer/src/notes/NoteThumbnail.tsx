/** Page-navigator preview of a note: its title and opening lines, drawn as text. */
import { memo, useMemo } from 'react'
import type { NoteDoc } from '@shared/schema'
import { noteToPlainText } from '@shared/noteText'

export const NoteThumbnail = memo(function NoteThumbnail({ note, title }: { note: NoteDoc; title: string }) {
  const lines = useMemo(() => noteToPlainText(note.doc).split('\n').slice(0, 14), [note.doc])
  return (
    <span className="flex h-full w-full flex-col gap-[3px] overflow-hidden bg-paper px-[9%] pt-[12%] text-left" aria-hidden>
      <span className="truncate text-[7.5px] leading-tight font-semibold text-ink">{title || lines[0] || 'Untitled note'}</span>
      {(title ? lines : lines.slice(1)).map((line, i) => (
        <span key={i} className="line-clamp-2 text-[5px] leading-[1.35] text-ink-2">
          {line}
        </span>
      ))}
    </span>
  )
})
