/**
 * Typed canvas commands: the single way to change page content.
 *
 * Pointer tools, menus and shortcuts build commands; the future AI Tutor will
 * send the same commands as JSON. Every command is validated with zod and
 * against the current page (ids must exist, results must pass the page schema),
 * and a batch becomes ONE undoable transaction. Commands work in page (document)
 * coordinates and never touch the DOM or Konva.
 */
import { z } from 'zod'
import { newId } from '@shared/factory'
import {
  SHAPE_KINDS,
  assetNameSchema,
  canvasObjectSchema,
  idSchema,
  pointSchema,
  type CanvasObject,
  type PageDoc,
  type Point
} from '@shared/schema'
import { applyOp, removeOp, type Op, type Transaction } from './history'
import { objectBounds, unionRects, type Rect } from './geometry'

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const num = z.number().finite()
const ids = z.array(idSchema).min(1).max(5000)
const scale = num.refine((v) => Math.abs(v) >= 0.01 && Math.abs(v) <= 100, 'scale out of range')

export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('createStroke'),
    id: idSchema.optional(),
    /** Layer position; defaults to the top. */
    index: z.number().int().min(0).optional(),
    stroke: z.object({
      tool: z.enum(['pen', 'highlighter']).default('pen'),
      color: hex,
      size: z.number().min(0.5).max(80),
      opacity: z.number().min(0.05).max(1).default(1),
      hasPressure: z.boolean().default(false),
      points: z.array(pointSchema).min(1).max(20000)
    })
  }),
  z.object({
    type: z.literal('createShape'),
    id: idSchema.optional(),
    /** Layer position; defaults to the top. */
    index: z.number().int().min(0).optional(),
    shape: z.object({
      kind: z.enum(SHAPE_KINDS),
      x: num,
      y: num,
      width: num,
      height: num,
      rotation: num.default(0),
      color: hex,
      strokeWidth: z.number().min(0.5).max(40),
      fill: hex.nullable().default(null),
      fillOpacity: z.number().min(0).max(1).default(0.18)
    })
  }),
  z.object({
    type: z.literal('createText'),
    id: idSchema.optional(),
    /** Layer position; defaults to the top. */
    index: z.number().int().min(0).optional(),
    text: z.object({
      x: num,
      y: num,
      width: z.number().min(20).max(5000).default(560),
      text: z.string().min(1).max(20000),
      color: hex.default('#1f2430'),
      fontSize: z.number().min(6).max(200).default(26),
      font: z.enum(['sans', 'serif', 'hand']).default('sans')
    })
  }),
  z.object({
    type: z.literal('createImage'),
    id: idSchema.optional(),
    /** Layer position; defaults to the top. */
    index: z.number().int().min(0).optional(),
    image: z.object({
      asset: assetNameSchema,
      x: num,
      y: num,
      width: z.number().min(1).max(20000),
      height: z.number().min(1).max(20000),
      rotation: num.default(0),
      naturalWidth: z.number().min(1),
      naturalHeight: z.number().min(1)
    })
  }),
  z.object({ type: z.literal('updateObject'), id: idSchema, patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('deleteObjects'), ids }),
  z.object({ type: z.literal('moveObjects'), ids, dx: num, dy: num }),
  z.object({
    type: z.literal('resizeObjects'),
    ids,
    scaleX: scale,
    scaleY: scale,
    /** Fixed point of the resize; defaults to the selection's top-left corner. */
    originX: num.optional(),
    originY: num.optional()
  }),
  z.object({ type: z.literal('transformObjects'), ids, sx: scale, sy: scale, tx: num, ty: num }),
  z.object({ type: z.literal('duplicateObjects'), ids, dx: num.default(24), dy: num.default(24) }),
  z.object({ type: z.literal('selectObjects'), ids: z.array(idSchema).max(5000) })
])

export type CanvasCommand = z.input<typeof commandSchema>
type ParsedCommand = z.output<typeof commandSchema>

export interface CommandContext {
  author: 'user' | 'ai'
  /** AI commands may only change AI-authored objects unless this is granted. */
  allowEditUserContent?: boolean
}

export interface CommandResult {
  transaction: Transaction
  /** Ids created by the batch, in order. */
  created: string[]
  /** Selection requested by the batch (selectObjects / duplicates), if any. */
  selection: string[] | null
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly index: number
  ) {
    super(`Command ${index + 1}: ${message}`)
  }
}

const IMMUTABLE_KEYS = new Set(['id', 'type', 'createdAt', 'author'])
/** AI content must stay on (or very near) the page. */
const AI_PAGE_MARGIN = 40

export interface Affine {
  sx: number
  sy: number
  tx: number
  ty: number
}

const map = (a: Affine, x: number, y: number): [number, number] => [x * a.sx + a.tx, y * a.sy + a.ty]
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const round = (v: number): number => Math.round(v * 100) / 100

/**
 * Applies a scale+translate to an object while keeping its vector data:
 * stroke points are mapped one by one (pressure untouched), boxes are mapped
 * by their corners. Thickness and font size follow the geometric mean scale.
 */
export function transformObject(o: CanvasObject, a: Affine): CanvasObject {
  const uniform = Math.sqrt(Math.abs(a.sx * a.sy))
  switch (o.type) {
    case 'stroke':
      return {
        ...o,
        size: clamp(o.size * uniform, 0.5, 80),
        points: o.points.map((p) => {
          const [x, y] = map(a, p[0], p[1])
          return (p.length === 3 ? [round(x), round(y), p[2]] : [round(x), round(y)]) as Point
        })
      }
    case 'text': {
      const [x, y] = map(a, o.x, o.y)
      return { ...o, x, y, width: clamp(o.width * Math.abs(a.sx), 20, 5000), fontSize: clamp(o.fontSize * uniform, 6, 200) }
    }
    case 'shape':
    case 'image': {
      if (o.type === 'shape' && (o.kind === 'line' || o.kind === 'arrow')) {
        const [x, y] = map(a, o.x, o.y)
        const [x2, y2] = map(a, o.x + o.width, o.y + o.height)
        return { ...o, x, y, width: x2 - x, height: y2 - y, strokeWidth: clamp(o.strokeWidth * uniform, 0.5, 40) }
      }
      const scaled = o.type === 'shape' ? { strokeWidth: clamp(o.strokeWidth * uniform, 0.5, 40) } : {}
      if (o.rotation === 0) {
        // Axis-aligned: map both corners, so flips normalise to a positive box.
        const [x1, y1] = map(a, o.x, o.y)
        const [x2, y2] = map(a, o.x + o.width, o.y + o.height)
        return {
          ...o,
          ...scaled,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.max(1, Math.abs(x2 - x1)),
          height: Math.max(1, Math.abs(y2 - y1))
        }
      }
      // Rotated boxes scale about their corner (exact for uniform scaling).
      const [x, y] = map(a, o.x, o.y)
      return { ...o, ...scaled, x, y, width: Math.max(1, o.width * Math.abs(a.sx)), height: Math.max(1, o.height * Math.abs(a.sy)) }
    }
  }
}

export function selectionBounds(objects: readonly CanvasObject[], selected: ReadonlySet<string>): Rect | null {
  return unionRects(objects.filter((o) => selected.has(o.id)).map(objectBounds))
}

/**
 * Validates a batch of commands against `page` and turns it into a single
 * transaction. Throws CommandError (and changes nothing) if any command is
 * invalid, so a batch is applied completely or not at all.
 */
export function buildTransaction(page: PageDoc, commands: readonly CanvasCommand[], ctx: CommandContext, label?: string): CommandResult {
  let objects: CanvasObject[] = page.objects.slice()
  const ops: Op[] = []
  const created: string[] = []
  let selection: string[] | null = null
  const now = Date.now()

  const push = (op: Op): void => {
    ops.push(op)
    objects = applyOp(objects, op)
  }

  commands.forEach((raw, index) => {
    const fail = (msg: string): never => {
      throw new CommandError(msg, index)
    }
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`).join('; '))
    const cmd = parsed.data as ParsedCommand

    const existing = (list: readonly string[]): CanvasObject[] => {
      const byId = new Map(objects.map((o) => [o.id, o]))
      return list.map((id) => byId.get(id) ?? fail(`no object with id ${id} on this page`))
    }
    const assertEditable = (targets: CanvasObject[]): void => {
      if (ctx.author === 'ai' && !ctx.allowEditUserContent && targets.some((o) => o.author === 'user')) {
        fail("the AI may not change the user's own content without permission")
      }
    }
    const validate = (o: unknown): CanvasObject => {
      const r = canvasObjectSchema.safeParse(o)
      if (!r.success) fail(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      const obj = r.data as CanvasObject
      if (ctx.author === 'ai') {
        const b = objectBounds(obj)
        const m = AI_PAGE_MARGIN
        if (b.x < -m || b.y < -m || b.x + b.width > page.width + m || b.y + b.height > page.height + m) {
          fail('content would fall outside the page')
        }
      }
      return obj
    }
    const create = (id: string | undefined, index: number | undefined, body: Record<string, unknown>): void => {
      const newIdValue = id ?? newId()
      if (objects.some((o) => o.id === newIdValue)) fail(`id ${newIdValue} already exists`)
      const obj = validate({ ...body, id: newIdValue, createdAt: now, author: ctx.author })
      push({ kind: 'add', items: [{ object: obj, index: Math.min(index ?? objects.length, objects.length) }] })
      created.push(obj.id)
    }
    const transformMany = (list: readonly string[], a: Affine): void => {
      const before = existing(list)
      assertEditable(before)
      push({ kind: 'update', before, after: before.map((o) => validate(transformObject(o, a))) })
    }

    switch (cmd.type) {
      case 'createStroke':
        create(cmd.id, cmd.index, { type: 'stroke', ...cmd.stroke })
        break
      case 'createShape':
        create(cmd.id, cmd.index, { type: 'shape', ...cmd.shape })
        break
      case 'createText':
        create(cmd.id, cmd.index, { type: 'text', ...cmd.text })
        break
      case 'createImage':
        create(cmd.id, cmd.index, { type: 'image', ...cmd.image })
        break
      case 'updateObject': {
        const [target] = existing([cmd.id])
        assertEditable([target!])
        const bad = Object.keys(cmd.patch).find((k) => IMMUTABLE_KEYS.has(k))
        if (bad) fail(`"${bad}" cannot be changed`)
        const next = validate({ ...target, ...cmd.patch })
        if (next.type !== target!.type) fail('object type cannot change')
        push({ kind: 'update', before: [target!], after: [next] })
        break
      }
      case 'deleteObjects': {
        assertEditable(existing(cmd.ids))
        push(removeOp(objects, new Set(cmd.ids)))
        break
      }
      case 'moveObjects':
        transformMany(cmd.ids, { sx: 1, sy: 1, tx: cmd.dx, ty: cmd.dy })
        break
      case 'resizeObjects': {
        const b = selectionBounds(objects, new Set(existing(cmd.ids).map((o) => o.id)))!
        const ox = cmd.originX ?? b.x
        const oy = cmd.originY ?? b.y
        transformMany(cmd.ids, { sx: cmd.scaleX, sy: cmd.scaleY, tx: ox * (1 - cmd.scaleX), ty: oy * (1 - cmd.scaleY) })
        break
      }
      case 'transformObjects':
        transformMany(cmd.ids, { sx: cmd.sx, sy: cmd.sy, tx: cmd.tx, ty: cmd.ty })
        break
      case 'duplicateObjects': {
        const sources = existing(cmd.ids)
        // Keep the originals' relative layer order, on top of everything.
        const ordered = objects.filter((o) => sources.includes(o))
        const copies = ordered.map((o) =>
          validate({ ...transformObject(o, { sx: 1, sy: 1, tx: cmd.dx, ty: cmd.dy }), id: newId(), createdAt: now, author: ctx.author })
        )
        push({ kind: 'add', items: copies.map((object, i) => ({ object, index: objects.length + i })) })
        created.push(...copies.map((c) => c.id))
        selection = copies.map((c) => c.id)
        break
      }
      case 'selectObjects':
        selection = existing(cmd.ids).map((o) => o.id)
        break
    }
  })

  return { transaction: { label: label ?? defaultLabel(commands), ops }, created, selection }
}

function defaultLabel(commands: readonly CanvasCommand[]): string {
  const first = commands[0]?.type ?? 'Edit'
  return commands.length > 1 ? `${first} (+${commands.length - 1})` : first
}

/** Builds commands that paste previously copied objects at an offset. */
export function pasteCommands(clip: readonly CanvasObject[], dx: number, dy: number): CanvasCommand[] {
  return clip.map((o) => {
    const moved = transformObject(o, { sx: 1, sy: 1, tx: dx, ty: dy })
    // Strip identity fields; the command layer assigns fresh ones.
    const { id, createdAt, author, type, ...body } = moved
    switch (moved.type) {
      case 'stroke':
        return { type: 'createStroke', stroke: body as never }
      case 'shape':
        return { type: 'createShape', shape: body as never }
      case 'text':
        return { type: 'createText', text: body as never }
      case 'image':
        return { type: 'createImage', image: body as never }
    }
  })
}
