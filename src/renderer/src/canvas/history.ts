/**
 * Undo/redo as reversible operations on a page's object list. Every user (and,
 * later, AI) edit is one Transaction, so a multi-object change undoes in one step.
 */
import type { CanvasObject, PageDoc } from '@shared/schema'

export type Op =
  | { kind: 'add'; items: { object: CanvasObject; index: number }[] }
  | { kind: 'remove'; items: { object: CanvasObject; index: number }[] }
  | { kind: 'update'; before: CanvasObject[]; after: CanvasObject[] }
  /**
   * The page's size changes. `shift` is how far the page's content moved with it
   * (growing left or up moves everything right or down); the objects themselves
   * move through an `update` op in the same transaction.
   */
  | { kind: 'size'; before: PageSize; after: PageSize; shift: [number, number] }

export interface PageSize {
  width: number
  height: number
}

export interface Transaction {
  label: string
  ops: Op[]
}

export interface PageHistory {
  undo: Transaction[]
  redo: Transaction[]
}

export const HISTORY_LIMIT = 300

export function applyOp(objects: readonly CanvasObject[], op: Op): CanvasObject[] {
  switch (op.kind) {
    case 'add': {
      const next = objects.slice()
      for (const { object, index } of [...op.items].sort((a, b) => a.index - b.index)) {
        next.splice(Math.min(index, next.length), 0, object)
      }
      return next
    }
    case 'remove': {
      const ids = new Set(op.items.map((i) => i.object.id))
      return objects.filter((o) => !ids.has(o.id))
    }
    case 'update': {
      const byId = new Map(op.after.map((o) => [o.id, o]))
      return objects.map((o) => byId.get(o.id) ?? o)
    }
    case 'size':
      return objects as CanvasObject[]
  }
}

export function invertOp(op: Op): Op {
  switch (op.kind) {
    case 'add':
      return { kind: 'remove', items: op.items }
    case 'remove':
      return { kind: 'add', items: op.items }
    case 'update':
      return { kind: 'update', before: op.after, after: op.before }
    case 'size':
      return { kind: 'size', before: op.after, after: op.before, shift: [-op.shift[0], -op.shift[1]] }
  }
}

export function applyTransaction(page: PageDoc, tx: Transaction): PageDoc {
  let { width, height } = page
  for (const op of tx.ops) if (op.kind === 'size') ({ width, height } = op.after)
  return { ...page, width, height, objects: tx.ops.reduce(applyOp, page.objects), updatedAt: Date.now() }
}

/** How far a transaction moved the page's content (non-zero only when a page grew left or up). */
export function contentShift(tx: Transaction): [number, number] {
  let dx = 0
  let dy = 0
  for (const op of tx.ops) if (op.kind === 'size') (dx += op.shift[0]), (dy += op.shift[1])
  return [dx, dy]
}

export function invertTransaction(tx: Transaction): Transaction {
  return { label: tx.label, ops: tx.ops.slice().reverse().map(invertOp) }
}

/** Builds a remove op that remembers each object's layer index for undo. */
export function removeOp(objects: readonly CanvasObject[], ids: ReadonlySet<string>): Op {
  const items: { object: CanvasObject; index: number }[] = []
  objects.forEach((object, index) => {
    if (ids.has(object.id)) items.push({ object, index })
  })
  return { kind: 'remove', items }
}
