import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasObject, PageDoc, ShapeObject, StrokeObject } from '../../src/shared/schema'
import { createPageDoc } from '../../src/shared/factory'
import { migratePage } from '../../src/shared/migrate'
import { buildTransaction, pasteCommands, transformObject, CommandError, type CommandContext } from '../../src/renderer/src/canvas/commands'
import { applyTransaction, invertTransaction } from '../../src/renderer/src/canvas/history'
import { lassoSelects, objectBounds, type Vec } from '../../src/renderer/src/canvas/geometry'
import { cutRuns, densify } from '../../src/renderer/src/canvas/eraser'
import { clamp, fitPage, fitWidth, screenToPage, zoomAt } from '../../src/renderer/src/canvas/viewport'
import { Storage, sniffImage } from '../../src/main/storage'

const page = (objects: CanvasObject[] = []): PageDoc => ({ ...createPageDoc('notebook-1', 'page-0001'), objects })
const user: CommandContext = { author: 'user' }
const ai: CommandContext = { author: 'ai' }

function run(p: PageDoc, cmds: Parameters<typeof buildTransaction>[1], ctx: CommandContext = user) {
  const r = buildTransaction(p, cmds, ctx)
  return { ...r, page: applyTransaction(p, r.transaction) }
}

const stroke = (id: string, pts: [number, number][]): StrokeObject => ({
  id,
  type: 'stroke',
  author: 'user',
  createdAt: 0,
  tool: 'pen',
  color: '#000000',
  size: 4,
  opacity: 1,
  hasPressure: false,
  points: pts
})

describe('canvas commands', () => {
  it('creates every object type with fresh ids, the caller as author, in one transaction', () => {
    const r = run(
      page(),
      [
        { type: 'createStroke', stroke: { color: '#112233', size: 3, points: [[1, 1], [5, 5]] } },
        { type: 'createShape', shape: { kind: 'arrow', x: 10, y: 10, width: 50, height: -20, color: '#e5484d', strokeWidth: 3 } },
        { type: 'createText', text: { x: 20, y: 40, text: 'x = -2' } },
        { type: 'createImage', image: { asset: 'abcdef123456.png', x: 0, y: 0, width: 100, height: 50, naturalWidth: 400, naturalHeight: 200 } }
      ],
      ai
    )
    expect(r.created).toHaveLength(4)
    expect(r.transaction.ops).toHaveLength(4)
    expect(r.page.objects.map((o) => o.type)).toEqual(['stroke', 'shape', 'text', 'image'])
    expect(r.page.objects.every((o) => o.author === 'ai')).toBe(true)
    // The whole batch undoes in one step.
    expect(applyTransaction(r.page, invertTransaction(r.transaction)).objects).toHaveLength(0)
  })

  it('rejects a batch atomically when any command is invalid', () => {
    const p = page([stroke('stroke-0001', [[0, 0], [10, 10]])])
    expect(() =>
      buildTransaction(p, [{ type: 'moveObjects', ids: ['stroke-0001'], dx: 5, dy: 5 }, { type: 'deleteObjects', ids: ['missing-id-1'] }], user)
    ).toThrow(CommandError)
    expect(() => buildTransaction(p, [{ type: 'createText', text: { x: 'a', y: 0, text: 'hi' } } as never], user)).toThrow(/x/)
    expect(() => buildTransaction(p, [{ type: 'updateObject', id: 'stroke-0001', patch: { id: 'other-id-01' } }], user)).toThrow(/cannot be changed/)
  })

  it('keeps AI edits away from user content unless allowed, and on the page', () => {
    const p = page([stroke('stroke-0001', [[0, 0], [10, 10]])])
    expect(() => buildTransaction(p, [{ type: 'deleteObjects', ids: ['stroke-0001'] }], ai)).toThrow(/permission/)
    expect(() => buildTransaction(p, [{ type: 'deleteObjects', ids: ['stroke-0001'] }], { author: 'ai', allowEditUserContent: true })).not.toThrow()
    expect(() => buildTransaction(p, [{ type: 'createText', text: { x: 5000, y: 10, text: 'off page' } }], ai)).toThrow(/outside the page/)
  })

  it('moves and resizes strokes point-by-point, preserving pressure', () => {
    const s: StrokeObject = { ...stroke('stroke-0001', [[0, 0], [10, 10]]), hasPressure: true, points: [[0, 0, 0.3], [10, 10, 0.8]] }
    const moved = run(page([s]), [{ type: 'moveObjects', ids: [s.id], dx: 100, dy: 50 }]).page.objects[0] as StrokeObject
    expect(moved.points).toEqual([[100, 50, 0.3], [110, 60, 0.8]])
    const resized = run(page([s]), [{ type: 'resizeObjects', ids: [s.id], scaleX: 2, scaleY: 2, originX: 0, originY: 0 }]).page
      .objects[0] as StrokeObject
    expect(resized.points).toEqual([[0, 0, 0.3], [20, 20, 0.8]])
    expect(resized.size).toBe(8)
    expect(resized.points).toHaveLength(s.points.length)
  })

  it('resizes about the selection corner by default and flips boxes to positive extents', () => {
    const rect: ShapeObject = {
      id: 'shape-0001', type: 'shape', author: 'user', createdAt: 0, kind: 'rect', x: 100, y: 100, width: 50, height: 20,
      rotation: 0, color: '#000000', strokeWidth: 2, fill: null, fillOpacity: 0.2
    }
    const r = run(page([rect]), [{ type: 'resizeObjects', ids: [rect.id], scaleX: 2, scaleY: 3 }]).page.objects[0] as ShapeObject
    // Origin is the selection's top-left including half the stroke width (99, 99).
    expect([r.x, r.y, r.width, r.height]).toEqual([101, 102, 100, 60])
    const flipped = transformObject(rect, { sx: -1, sy: 1, tx: 0, ty: 0 }) as ShapeObject
    expect(flipped.width).toBe(50)
    expect(flipped.x).toBe(-150)
  })

  it('duplicates on top, offset, and selects the copies', () => {
    const r = run(page([stroke('stroke-0001', [[0, 0], [10, 10]])]), [{ type: 'duplicateObjects', ids: ['stroke-0001'] }])
    expect(r.page.objects).toHaveLength(2)
    expect(r.selection).toEqual([r.created[0]])
    expect((r.page.objects[1] as StrokeObject).points[0]).toEqual([24, 24])
  })

  it('inserts at a layer index when asked', () => {
    const p = page([stroke('stroke-0001', [[0, 0], [1, 1]]), stroke('stroke-0002', [[2, 2], [3, 3]])])
    const r = run(p, [{ type: 'createStroke', index: 1, stroke: { color: '#000000', size: 2, points: [[5, 5], [6, 6]] } }])
    expect(r.page.objects.map((o) => o.id)[1]).toBe(r.created[0])
  })

  it('paste commands recreate copied objects with new identities', () => {
    const src = stroke('stroke-0001', [[0, 0], [10, 10]])
    const r = run(page([src]), pasteCommands([src], 24, 24))
    expect(r.page.objects[1]!.id).not.toBe(src.id)
    expect((r.page.objects[1] as StrokeObject).points[0]).toEqual([24, 24])
  })
})

describe('lasso geometry', () => {
  const loop: Vec[] = [[0, 0], [100, 0], [100, 100], [0, 100]]
  it('selects a stroke mostly inside the loop but not one mostly outside', () => {
    expect(lassoSelects(stroke('stroke-0001', [[10, 10], [50, 50], [90, 90]]), loop)).toBe(true)
    expect(lassoSelects(stroke('stroke-0002', [[90, 90], [150, 150], [200, 200], [250, 250]]), loop)).toBe(false)
  })
  it('uses the real lasso polygon, not its bounding box', () => {
    const triangle: Vec[] = [[0, 0], [100, 0], [0, 100]]
    // Inside the triangle's bounding box but outside the triangle itself.
    expect(lassoSelects(stroke('stroke-0003', [[80, 80], [90, 90]]), triangle)).toBe(false)
    expect(lassoSelects(stroke('stroke-0004', [[10, 10], [20, 20]]), triangle)).toBe(true)
  })
  it('accounts for rotation in shape bounds', () => {
    const r: ShapeObject = {
      id: 'shape-0001', type: 'shape', author: 'user', createdAt: 0, kind: 'rect', x: 0, y: 0, width: 100, height: 0.0001 + 10,
      rotation: 90, color: '#000000', strokeWidth: 0.5, fill: null, fillOpacity: 0
    }
    const b = objectBounds(r)
    expect(b.height).toBeGreaterThan(99)
  })
})

describe('precise eraser', () => {
  it('splits a stroke where the eraser crosses it', () => {
    const line = densify([[0, 0], [100, 0]], 2)
    const runs = cutRuns([line], [50, -10], [50, 10], 5)!
    expect(runs).toHaveLength(2)
    expect(runs[0]!.at(-1)![0]).toBeLessThan(46)
    expect(runs[1]![0]![0]).toBeGreaterThan(54)
  })
  it('reports no change when the eraser misses', () => {
    expect(cutRuns([densify([[0, 0], [100, 0]], 2)], [50, 30], [60, 30], 5)).toBeNull()
  })
  it('interpolates pressure when densifying', () => {
    const d = densify([[0, 0, 0], [10, 0, 1]], 2)
    expect(d.length).toBeGreaterThan(4)
    expect(d[2]![2]).toBeCloseTo(0.4, 5)
  })
})

describe('viewport', () => {
  const pg = { width: 1240, height: 1754 }
  const view = { width: 800, height: 900 }
  it('fit width fills the view horizontally', () => {
    const c = fitWidth(pg, view)
    expect(c.scale * pg.width).toBeCloseTo(800)
    expect(c.x).toBe(0)
  })
  it('zooming keeps the page point under the cursor fixed', () => {
    const c = fitWidth(pg, view)
    const before = screenToPage(c, 300, 400)
    const z = zoomAt(c, 2, 300, 400, pg, view)
    const after = screenToPage(z, 300, 400)
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
  })
  it('centres a page smaller than the view and limits panning', () => {
    const fp = fitPage(pg, view)
    expect(fp.scale * pg.height).toBeLessThan(view.height)
    const c = clamp({ ...fp, x: -5000, y: -5000 }, pg, view)
    expect(c.x).toBeCloseTo((view.width - pg.width * fp.scale) / 2)
  })
})

describe('migration and assets', () => {
  it('upgrades v1 pages to v2 without touching objects', () => {
    const v1 = { schemaVersion: 1, id: 'page-0001', objects: [{ a: 1 }] }
    expect(migratePage(v1)).toEqual({ ...v1, schemaVersion: 2 })
  })

  it('loads a v1 page file written by Phase 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkling-mig-'))
    try {
      const storage = new Storage(root)
      const p = page([stroke('stroke-0001', [[0, 0], [5, 5]])])
      const file = storage.pagePath(p.notebookId, p.id)
      await storage.savePage(p)
      await writeFile(file, JSON.stringify({ ...p, schemaVersion: 1 }))
      const loaded = await new Storage(root).loadPage(p.notebookId, p.id)
      expect(loaded.page?.schemaVersion).toBe(2)
      expect(loaded.page?.objects).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores images by content type and rejects non-images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkling-asset-'))
    try {
      const storage = new Storage(root)
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
      const name = await storage.saveAsset('notebook-1', png)
      expect(name).toMatch(/\.png$/)
      expect(new Uint8Array(await storage.readAsset('notebook-1', name))).toEqual(png)
      await expect(storage.saveAsset('notebook-1', new TextEncoder().encode('<script>'))).rejects.toThrow(/Unsupported/)
      expect(() => storage.assetPath('notebook-1', '../library.json')).toThrow()
      expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
