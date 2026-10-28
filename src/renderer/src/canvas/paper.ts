import type { CSSProperties } from 'react'
import type { Paper } from '@shared/schema'

export const PAPER_FILL = '#fdfcfa'
const LINED_MARGIN = 120

/** Paper pattern as CSS for the live canvas (cheap; never redrawn on input). */
export function paperStyle(paper: Paper, scale: number): CSSProperties {
  const s = paper.spacing * scale
  const c = paper.color
  switch (paper.type) {
    case 'grid':
      return {
        backgroundColor: PAPER_FILL,
        backgroundImage: `linear-gradient(to right, ${c} 1px, transparent 1px), linear-gradient(to bottom, ${c} 1px, transparent 1px)`,
        backgroundSize: `${s}px ${s}px`
      }
    case 'lined':
      return {
        backgroundColor: PAPER_FILL,
        backgroundImage: `linear-gradient(to right, transparent ${LINED_MARGIN * scale}px, #f3c6c6 ${LINED_MARGIN * scale}px, #f3c6c6 ${LINED_MARGIN * scale + 1}px, transparent ${LINED_MARGIN * scale + 1}px), linear-gradient(to bottom, transparent ${s - 1}px, ${c} ${s - 1}px)`,
        backgroundSize: `100% 100%, 100% ${s}px`,
        backgroundRepeat: 'no-repeat, repeat'
      }
    case 'dotted':
      return {
        backgroundColor: PAPER_FILL,
        backgroundImage: `radial-gradient(circle, ${c} ${Math.max(0.9, 1.4 * scale)}px, transparent ${Math.max(1, 1.5 * scale)}px)`,
        backgroundSize: `${s}px ${s}px`,
        backgroundPosition: `${-s / 2}px ${-s / 2}px`
      }
    case 'blank':
      return { backgroundColor: PAPER_FILL }
  }
}

/** Draws the same paper into a 2D context at page scale (for export). */
export function drawPaper(ctx: CanvasRenderingContext2D, paper: Paper, width: number, height: number): void {
  ctx.fillStyle = PAPER_FILL
  ctx.fillRect(0, 0, width, height)
  const s = paper.spacing
  ctx.fillStyle = paper.color
  if (paper.type === 'grid') {
    for (let x = 0; x < width; x += s) ctx.fillRect(x, 0, 1, height)
    for (let y = 0; y < height; y += s) ctx.fillRect(0, y, width, 1)
  } else if (paper.type === 'lined') {
    for (let y = s - 1; y < height; y += s) ctx.fillRect(0, y, width, 1)
    ctx.fillStyle = '#f3c6c6'
    ctx.fillRect(LINED_MARGIN, 0, 1, height)
  } else if (paper.type === 'dotted') {
    for (let x = s / 2; x < width; x += s)
      for (let y = s / 2; y < height; y += s) {
        ctx.beginPath()
        ctx.arc(x, y, 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
  }
}
