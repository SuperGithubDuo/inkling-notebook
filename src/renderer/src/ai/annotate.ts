/**
 * Turns the tutor's annotation proposal into canvas commands.
 *
 * Gemini returns boxes as [ymin, xmin, ymax, xmax] in 0–1000 over the image
 * it was sent; the image shows a known page rectangle, so each box maps back
 * to page coordinates exactly. Marks (✓, ✗, circles, underlines) go on or
 * next to the work they refer to; written notes and corrections go in a
 * column beside the work (or below it when there is no room), never on top
 * of the student's writing. Everything is ordinary, editable canvas content,
 * created as AI-authored objects in one undoable step.
 */
import { newId } from '@shared/factory'
import { latexToPlain } from '@shared/mathText'
import type { Annotation, AnnotationKind } from '@shared/tutor'
import type { CanvasCommand } from '@/canvas/commands'
import type { Rect } from '@/canvas/geometry'

export const AI_COLORS = {
  good: '#1f9a5a',
  wrong: '#e5484d',
  note: '#6d63f0'
} as const

const COLOR: Record<AnnotationKind, string> = {
  check: AI_COLORS.good,
  cross: AI_COLORS.wrong,
  circle: AI_COLORS.wrong,
  underline: AI_COLORS.wrong,
  correction: AI_COLORS.wrong,
  note: AI_COLORS.note,
  arrow: AI_COLORS.note
}

export interface PlacedAnnotation {
  annotation: Annotation
  /** The page area the annotation refers to. */
  target: Rect
  commands: CanvasCommand[]
}

/** Maps a 0–1000 box over the image back to page coordinates. */
export function boxToPage(box: readonly number[], rect: Rect): Rect {
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.min(1000, Math.max(0, v))) as [number, number, number, number]
  return {
    x: rect.x + (xmin / 1000) * rect.width,
    y: rect.y + (ymin / 1000) * rect.height,
    width: ((xmax - xmin) / 1000) * rect.width,
    height: ((ymax - ymin) / 1000) * rect.height
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Rough width of handwriting-style text (Caveat is narrow). */
const textWidth = (text: string, size: number): number => Math.max(...text.split('\n').map((l) => l.length)) * size * 0.46 + 12

function checkMark(x: number, y: number, h: number, color: string): CanvasCommand {
  return {
    type: 'createStroke',
    id: newId(),
    stroke: { tool: 'pen', color, size: clamp(h * 0.09, 3, 6), points: [[x, y + h * 0.55], [x + h * 0.15, y + h * 0.72], [x + h * 0.32, y + h * 0.92], [x + h * 0.6, y + h * 0.45], [x + h * 0.95, y + h * 0.05]] }
  }
}

function crossMark(x: number, y: number, h: number, color: string): CanvasCommand[] {
  const size = clamp(h * 0.09, 3, 6)
  return [
    { type: 'createStroke', id: newId(), stroke: { tool: 'pen', color, size, points: [[x, y + h * 0.1], [x + h * 0.4, y + h * 0.5], [x + h * 0.8, y + h * 0.9]] } },
    { type: 'createStroke', id: newId(), stroke: { tool: 'pen', color, size, points: [[x + h * 0.8, y + h * 0.1], [x + h * 0.4, y + h * 0.5], [x, y + h * 0.9]] } }
  ]
}

export interface PlanOptions {
  /** Page rectangle the image showed. */
  region: Rect
  page: { width: number; height: number }
}

/**
 * Lays out every annotation. Returns one entry per annotation so the user
 * can leave some out; the commands of the kept ones form one transaction.
 */
export function planAnnotations(annotations: readonly Annotation[], { region, page }: PlanOptions): PlacedAnnotation[] {
  const margin = 16
  const regionRight = region.x + region.width
  const regionBottom = region.y + region.height
  // Notes go in a column right of the work if there is room, else below it.
  const columnX = regionRight + 56
  const columnWidth = page.width - margin - columnX
  const besideWork = columnWidth >= 220
  const taken: Rect[] = []
  let belowY = regionBottom + 18

  const placeText = (target: Rect, text: string, size: number): { x: number; y: number; width: number } => {
    const want = textWidth(text, size)
    if (besideWork) {
      const width = Math.min(want, columnWidth)
      const lines = Math.ceil(want / width) * text.split('\n').length
      const height = lines * size * 1.25
      let y = clamp(target.y + target.height / 2 - height / 2, margin, page.height - height - margin)
      // Slide down past notes already placed.
      for (const r of [...taken].sort((a, b) => a.y - b.y)) {
        if (y < r.y + r.height + 6 && y + height > r.y - 6) y = r.y + r.height + 6
      }
      taken.push({ x: columnX, y, width, height })
      return { x: columnX, y, width }
    }
    const width = Math.min(want, page.width - 2 * margin - (region.x - margin > 0 ? region.x - margin : 0))
    const x = clamp(region.x, margin, page.width - width - margin)
    const lines = Math.ceil(want / width) * text.split('\n').length
    const y = Math.min(belowY, page.height - lines * size * 1.25 - margin)
    belowY = y + lines * size * 1.25 + 8
    return { x, y, width }
  }

  return annotations.map((annotation) => {
    const target = boxToPage(annotation.box_2d, region)
    const color = COLOR[annotation.kind]
    const h = clamp(target.height, 22, 64)
    const markX = Math.min(target.x + target.width + 10, page.width - h - margin)
    const markY = clamp(target.y + target.height / 2 - h / 2, margin, page.height - h - margin)
    const text = annotation.text ? latexToPlain(annotation.text).slice(0, 240) : ''
    const size = clamp(h * 0.75, 24, 34)
    const commands: CanvasCommand[] = []

    switch (annotation.kind) {
      case 'check':
        commands.push(checkMark(markX, markY, h * 0.8, color))
        break
      case 'cross':
        commands.push(...crossMark(markX, markY + h * 0.1, h * 0.8, color))
        break
      case 'circle': {
        const pad = 6
        commands.push({
          type: 'createShape',
          id: newId(),
          shape: { kind: 'ellipse', x: target.x - pad, y: target.y - pad, width: Math.max(16, target.width + 2 * pad), height: Math.max(16, target.height + 2 * pad), color, strokeWidth: 3, fill: null }
        })
        break
      }
      case 'underline':
        commands.push({
          type: 'createShape',
          id: newId(),
          shape: { kind: 'line', x: target.x, y: target.y + target.height + 4, width: Math.max(12, target.width), height: 0, color, strokeWidth: 3.5, fill: null }
        })
        break
      case 'correction':
      case 'note':
      case 'arrow':
        break
    }

    if (text) {
      const at = placeText(target, text, size)
      commands.push({ type: 'createText', id: newId(), text: { x: at.x, y: at.y, width: Math.max(40, at.width), text, color, fontSize: size, font: 'hand' } })
      // Corrections and arrows point from the note to the work they are about.
      if ((annotation.kind === 'arrow' || annotation.kind === 'correction') && besideWork) {
        const fromX = at.x - 8
        const fromY = at.y + size * 0.6
        const toX = Math.min(target.x + target.width + 4, fromX - 12)
        const toY = clamp(fromY, target.y, target.y + target.height)
        if (fromX - toX > 16) {
          commands.push({ type: 'createShape', id: newId(), shape: { kind: 'arrow', x: fromX, y: fromY, width: toX - fromX, height: toY - fromY, color, strokeWidth: 2.5, fill: null } })
        }
      }
    }
    return { annotation, target, commands }
  })
}
