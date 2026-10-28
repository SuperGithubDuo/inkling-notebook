import type { TextObject } from '@shared/schema'

export const FONT_FAMILY: Record<TextObject['font'], string> = {
  sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  // Handwriting style, used for the AI tutor's notes on the page.
  hand: 'Caveat, Inter, ui-sans-serif, system-ui, sans-serif'
}

export const TEXT_DEFAULT_SIZE = 26
export const TEXT_DEFAULT_WIDTH = 560

/** Greedy word wrap used where we render text without a layout engine (thumbnails). */
export function wrapLines(t: TextObject): string[] {
  const max = Math.max(1, Math.floor(t.width / (t.fontSize * 0.55)))
  const out: string[] = []
  for (const para of t.text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (next.length > max && line) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}
