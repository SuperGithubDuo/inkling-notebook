/**
 * The drawing document plus undo/redo history. Separate from rendering and
 * from the stroke engine; the UI subscribes with `subscribe` (compatible with
 * React's useSyncExternalStore). State is replaced immutably on every change.
 *
 * History holds operations, not snapshots:
 *   add     – one completed stroke (undo removes it)
 *   replace – clear or import (undo restores the previous strokes)
 * Any new operation clears the redo stack, so "undo, then draw" behaves like
 * every other editor: the undone stroke can no longer be redone.
 */
import { createDocument, type CanvasMeta, type Stroke, type WispDocument } from './types'

type Op = { type: 'add'; stroke: Stroke } | { type: 'replace'; before: WispDocument; after: WispDocument }

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

export class DocumentStore {
  private doc: WispDocument
  private undoStack: Op[] = []
  private redoStack: Op[] = []
  private readonly listeners = new Set<() => void>()
  private snapshot: { doc: WispDocument; history: HistoryState }

  constructor(
    initial: WispDocument = createDocument(),
    private readonly maxHistory = 500
  ) {
    this.doc = initial
    this.snapshot = this.makeSnapshot()
  }

  get document(): WispDocument {
    return this.doc
  }

  /** Stable snapshot object for useSyncExternalStore. */
  getSnapshot = (): { doc: WispDocument; history: HistoryState } => this.snapshot

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  addStroke(stroke: Stroke): void {
    if (stroke.points.length === 0) return
    const frozen: Stroke = { ...stroke, points: stroke.points.slice() }
    this.doc = { ...this.doc, strokes: [...this.doc.strokes, frozen], updatedAt: Date.now() }
    this.push({ type: 'add', stroke: frozen })
  }

  clear(): void {
    if (this.doc.strokes.length === 0) return
    const before = this.doc
    this.doc = { ...this.doc, strokes: [], updatedAt: Date.now() }
    this.push({ type: 'replace', before, after: this.doc })
  }

  /** Replaces the whole document (import). Undoable. */
  replace(next: WispDocument): void {
    const before = this.doc
    this.doc = next
    this.push({ type: 'replace', before, after: next })
  }

  setCanvas(canvas: CanvasMeta): void {
    this.doc = { ...this.doc, canvas: { ...canvas } }
    this.notify()
  }

  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    if (op.type === 'add') {
      const i = this.doc.strokes.lastIndexOf(op.stroke)
      const strokes = this.doc.strokes.slice()
      if (i >= 0) strokes.splice(i, 1)
      this.doc = { ...this.doc, strokes, updatedAt: Date.now() }
    } else {
      this.doc = op.before
    }
    this.redoStack.push(op)
    this.notify()
    return true
  }

  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    if (op.type === 'add') {
      this.doc = { ...this.doc, strokes: [...this.doc.strokes, op.stroke], updatedAt: Date.now() }
    } else {
      this.doc = op.after
    }
    this.undoStack.push(op)
    this.notify()
    return true
  }

  private push(op: Op): void {
    this.undoStack.push(op)
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift()
    this.redoStack = []
    this.notify()
  }

  private makeSnapshot(): { doc: WispDocument; history: HistoryState } {
    return { doc: this.doc, history: { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 } }
  }

  private notify(): void {
    this.snapshot = this.makeSnapshot()
    for (const fn of [...this.listeners]) fn()
  }
}
