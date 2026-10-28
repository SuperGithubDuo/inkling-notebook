/**
 * Persistent data model. Every file on disk is validated against these schemas
 * when read (main process) and before it is written, so a corrupted or
 * hand-edited file can never crash the editor or be silently overwritten.
 */
import { z } from 'zod'

export const LIBRARY_SCHEMA_VERSION = 1
export const PAGE_SCHEMA_VERSION = 2

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'invalid id')

export const PAPER_TYPES = ['grid', 'lined', 'dotted', 'blank'] as const
export const paperSchema = z.object({
  type: z.enum(PAPER_TYPES),
  spacing: z.number().min(8).max(200),
  color: z.string().max(32)
})

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const finite = z.number().finite()

const baseObject = {
  id: idSchema,
  createdAt: z.number(),
  /** Distinguishes the user's own work from AI-generated content. */
  author: z.enum(['user', 'ai'])
}

/** A point is [x, y] or [x, y, pressure] in page coordinates. */
export const pointSchema = z.union([z.tuple([finite, finite]), z.tuple([finite, finite, z.number().min(0).max(1)])])

export const strokeSchema = z.object({
  ...baseObject,
  type: z.literal('stroke'),
  tool: z.enum(['pen', 'highlighter']),
  color: hex,
  size: z.number().min(0.5).max(80),
  opacity: z.number().min(0.05).max(1),
  /** True only when the points carry real hardware pressure. */
  hasPressure: z.boolean(),
  points: z.array(pointSchema).min(1).max(20000)
})

export const textSchema = z.object({
  ...baseObject,
  type: z.literal('text'),
  x: finite,
  y: finite,
  width: z.number().min(20).max(5000),
  text: z.string().max(20000),
  color: hex,
  fontSize: z.number().min(6).max(200),
  font: z.enum(['sans', 'serif', 'hand'])
})

export const SHAPE_KINDS = ['line', 'arrow', 'rect', 'ellipse', 'triangle'] as const
const extent = z.number().finite().min(-20000).max(20000)
const rotation = z.number().finite().min(-360).max(360)

/**
 * Shapes live in a box: (x, y) is the top-left corner and `rotation` (degrees)
 * turns the box around that corner. For lines and arrows the box is the
 * vector from start (x, y) to end (x + width, y + height), so width and height
 * may be negative.
 */
export const shapeSchema = z.object({
  ...baseObject,
  type: z.literal('shape'),
  kind: z.enum(SHAPE_KINDS),
  x: finite,
  y: finite,
  width: extent,
  height: extent,
  rotation,
  color: hex,
  strokeWidth: z.number().min(0.5).max(40),
  fill: hex.nullable(),
  fillOpacity: z.number().min(0).max(1)
})

/** Image file name inside the notebook's assets folder. */
export const assetNameSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}\.(png|jpg|jpeg|gif|webp)$/, 'invalid asset name')

export const imageSchema = z.object({
  ...baseObject,
  type: z.literal('image'),
  asset: assetNameSchema,
  x: finite,
  y: finite,
  width: z.number().min(1).max(20000),
  height: z.number().min(1).max(20000),
  rotation,
  naturalWidth: z.number().min(1).max(100000),
  naturalHeight: z.number().min(1).max(100000)
})

export const canvasObjectSchema = z.discriminatedUnion('type', [strokeSchema, textSchema, shapeSchema, imageSchema])

export const pageDocSchema = z.object({
  schemaVersion: z.literal(PAGE_SCHEMA_VERSION),
  id: idSchema,
  notebookId: idSchema,
  width: z.number().min(100).max(20000),
  height: z.number().min(100).max(20000),
  paper: paperSchema,
  /** Array order is layer order: later objects draw on top. */
  objects: z.array(canvasObjectSchema),
  updatedAt: z.number()
})

export const pageMetaSchema = z.object({
  id: idSchema,
  title: z.string().max(200),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable()
})

export const NOTEBOOK_ICONS = ['book', 'sigma', 'atom', 'flask', 'leaf', 'user', 'code', 'globe', 'music', 'pen'] as const

export const notebookMetaSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  color: hex,
  icon: z.enum(NOTEBOOK_ICONS),
  favorite: z.boolean(),
  folderId: idSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
  pages: z.array(pageMetaSchema)
})

export const folderSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  parentId: idSchema.nullable()
})

export const librarySchema = z.object({
  schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
  notebooks: z.array(notebookMetaSchema),
  folders: z.array(folderSchema)
})

export type Paper = z.infer<typeof paperSchema>
export type PaperType = Paper['type']
export type Point = z.infer<typeof pointSchema>
export type StrokeObject = z.infer<typeof strokeSchema>
export type TextObject = z.infer<typeof textSchema>
export type ShapeKind = (typeof SHAPE_KINDS)[number]
export type ShapeObject = z.infer<typeof shapeSchema>
export type ImageObject = z.infer<typeof imageSchema>
export type CanvasObject = z.infer<typeof canvasObjectSchema>
export type ObjectType = CanvasObject['type']
export type PageDoc = z.infer<typeof pageDocSchema>
export type PageMeta = z.infer<typeof pageMetaSchema>
export type NotebookIcon = (typeof NOTEBOOK_ICONS)[number]
export type NotebookMeta = z.infer<typeof notebookMetaSchema>
export type Folder = z.infer<typeof folderSchema>
export type Library = z.infer<typeof librarySchema>
