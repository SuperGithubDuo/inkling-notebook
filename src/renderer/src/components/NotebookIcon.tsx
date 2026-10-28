import { Atom, Book, Code, FlaskConical, Globe, Leaf, Music, Pen, Sigma, User, type LucideIcon } from 'lucide-react'
import type { NotebookIcon as IconName } from '@shared/schema'

export const ICONS: Record<IconName, LucideIcon> = {
  book: Book,
  sigma: Sigma,
  atom: Atom,
  flask: FlaskConical,
  leaf: Leaf,
  user: User,
  code: Code,
  globe: Globe,
  music: Music,
  pen: Pen
}

export const NOTEBOOK_COLORS = ['#3b6fe0', '#6d63f0', '#0ea5e9', '#2f9e8f', '#22a35a', '#f2a516', '#ea8a2c', '#e5484d', '#d9468f', '#64748b']

/** A small notebook cover: colored body, darker spine, subject glyph. */
export function NotebookIcon({ color, icon, size = 20 }: { color: string; icon: IconName; size?: number }) {
  const Glyph = ICONS[icon]
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center rounded-[5px] text-white"
      style={{
        width: size,
        height: size * 1.1,
        background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 82%, black))`,
        boxShadow: `inset ${Math.max(2, size * 0.16)}px 0 0 color-mix(in srgb, ${color} 70%, black), 0 1px 2px rgb(0 0 0 / 0.12)`
      }}
    >
      <Glyph size={size * 0.52} strokeWidth={2.4} style={{ marginLeft: size * 0.12 }} />
    </span>
  )
}
