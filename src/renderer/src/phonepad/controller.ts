/**
 * PhonePad in the notebook: turns the phone's events into ordinary edits.
 *
 * - Infinite paper: the phone has its own camera over the page. Each stroke
 *   says which page rectangle the phone showed; ink maps into it exactly. Ink
 *   written past the page's edge grows the page (`extendPage`), in the same
 *   undo step as the stroke. Growing left or up moves the content, so the
 *   phone and this view are told how far, and keep their place.
 * - Ink becomes `createStroke` commands run through the store, exactly like
 *   the pen: one undo step per stroke, saved by the save queue, in PDF export.
 * - The pen colour and size are the computer's pen settings: the phone shows
 *   them and can change them.
 * - The eraser uses the same hit testing and commands as the canvas eraser.
 * - Undo/redo are the notebook's; clear removes ink inside the phone's view.
 * - The phone gets a picture of what it is looking at after each change.
 *
 * Talks to the rest of the app only through the ports below, so it is
 * unit-tested with fakes; install.ts connects the real store and canvas.
 */
import type { CanvasCommand } from '@/canvas/commands'
import { MAX_PAGE_SIZE } from '@/canvas/commands'
import type { RunResult } from '@/store/store'
import { outlinePath, type InkStyle } from '@/canvas/ink'
import { objectBounds } from '@/canvas/geometry'
import { clipRect } from '@/canvas/stageRef'
import type { Camera, Size } from '@/canvas/viewport'
import { eraseCommands, eraseSegment, newEraseState, simplify, type EraseState } from '@/canvas/strokeOps'
import type { PageDoc, Point } from '@shared/schema'
import type { InkMessage, InkPoint, PageRect, PhonePadEvent, PhonePadOutgoing } from '@shared/phonepad'
import { PEN_SIZE_RANGE, PHONEPAD_LIMITS } from '@shared/phonepad'
import { followCamera, growthFor, phoneArea, rectOf, toPage, type Area } from './region'
import { phoneLive } from './live'

/** Longest edge of the picture sent to the phone, in pixels. */
const VIEW_MAX_PX = 2400
/** The picture covers the phone's view plus this much on each side, so short pans show content at once. */
const OVERSCAN = 0.5
/** Room left beyond new ink when the page grows. */
const GROW_MARGIN = 160

export interface NotebookPort {
  /** The page the phone writes on: the open handwritten page, unless it can't be edited. */
  target(): { pageId: string; title: string } | null
  page(pageId: string): PageDoc | undefined
  /** The computer's pen settings. */
  pen(): { color: string; size: number; precise: boolean }
  setPen(color: string, size: number): void
  run(commands: CanvasCommand[], options: { label: string; pageId: string }): RunResult
  undo(): void
  redo(): void
  /** How far a page's content has moved (page grown left/up), with a change counter. */
  shift(pageId: string): { dx: number; dy: number; rev: number } | undefined
  /** Called on every change of page content, page, pen or page size. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void
}

export interface CanvasPort {
  camera(): { pageId: string; cam: Camera; view: Size; page: Size } | null
  /** Moves the computer's view (clamped by the canvas). */
  setCamera(cam: Camera): void
}

export interface ControllerDeps {
  notebook: NotebookPort
  canvas: CanvasPort
  send: (message: PhonePadOutgoing) => void
  /** Renders a page rectangle as a data URL at `pixelRatio` (null if the canvas isn't mounted). */
  render: (page: PageDoc, rect: { x: number; y: number; width: number; height: number }, pixelRatio: number) => Promise<string | null>
  /** Delay before refreshing the phone's picture after a change. */
  viewDelayMs?: number
}

/** Content moves of one page this session: origin[epoch] is the total move at that epoch. */
interface PageFrame {
  origins: [number, number][]
  rev: number
}

interface Pending {
  pageId: string
  /** The content move (origin) the points below are expressed in. */
  origin: [number, number]
  tool: 'pen' | 'eraser'
  points: Point[]
  style?: InkStyle & { color: string; opacity: number }
  erase?: { state: EraseState; radius: number; last: Point | null }
}

export class PhonePadController {
  connected = false
  surface = { aspect: 2, width: 800, height: 400, dpr: 2 }
  /** Where the phone is looking, in page units (now). */
  viewport: Area | null = null
  private viewportPage: string | null = null
  private frames = new Map<string, PageFrame>()
  private pending = new Map<string, Pending>()
  private committed: string[] = []
  private viewRev = 0
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private rendering = false
  private renderAgain = false
  private lastStatus = ''
  private lastTarget: string | null = null
  private unsubscribe: (() => void)[] = []

  constructor(private readonly deps: ControllerDeps) {}

  start(): void {
    this.unsubscribe.push(this.deps.notebook.subscribe(() => this.onNotebookChange()))
  }

  dispose(): void {
    this.unsubscribe.forEach((u) => u())
    this.unsubscribe = []
    this.setConnected(false)
  }

  handle(event: PhonePadEvent): void {
    switch (event.type) {
      case 'status':
        return this.setConnected(event.status.state === 'connected' || event.status.state === 'reconnecting')
      case 'surface':
        this.surface = { aspect: event.aspect, width: event.width, height: event.height, dpr: event.dpr }
        if (!this.viewport) this.gotoVisible()
        return this.scheduleView(0)
      case 'ink':
        return this.ink(event.message)
      case 'command':
        return this.command(event.action)
      case 'viewport':
        return this.onViewport(event.rect, event.epoch)
      case 'pen':
        return this.deps.notebook.setPen(event.color, Math.min(PEN_SIZE_RANGE[1], Math.max(PEN_SIZE_RANGE[0], event.size)))
    }
  }

  // ---- Connection, page and content moves ----------------------------------

  private setConnected(connected: boolean): void {
    if (connected === this.connected) return
    this.connected = connected
    if (!connected) {
      phoneLive.ink.clear()
      phoneLive.area = null
      phoneLive.pageId = null
      phoneLive.changed()
      this.lastStatus = ''
      this.viewport = null
      this.viewportPage = null
      return
    }
    this.lastTarget = this.deps.notebook.target()?.pageId ?? null
    this.sendStatus(true)
    this.gotoVisible()
  }

  private frame(pageId: string): PageFrame {
    let f = this.frames.get(pageId)
    if (!f) {
      f = { origins: [[0, 0]], rev: this.deps.notebook.shift(pageId)?.rev ?? 0 }
      this.frames.set(pageId, f)
    }
    return f
  }

  private epoch(pageId: string): number {
    return this.frame(pageId).origins.length - 1
  }

  private origin(pageId: string, epoch?: number): [number, number] {
    const o = this.frame(pageId).origins
    return o[Math.min(o.length - 1, Math.max(0, epoch ?? o.length - 1))]!
  }

  /** Records content moves (page grown left/up, or undone) since we last looked. */
  private trackShift(pageId: string): boolean {
    const f = this.frame(pageId)
    const s = this.deps.notebook.shift(pageId)
    if (!s || s.rev === f.rev) return false
    f.rev = s.rev
    if (!s.dx && !s.dy) return true
    const [ox, oy] = f.origins[f.origins.length - 1]!
    f.origins.push([ox + s.dx, oy + s.dy])
    if (this.viewport && this.viewportPage === pageId) this.viewport = { ...this.viewport, x: this.viewport.x + s.dx, y: this.viewport.y + s.dy }
    return true
  }

  private onNotebookChange(): void {
    if (!this.connected) return
    const target = this.deps.notebook.target()
    const moved = target ? this.trackShift(target.pageId) : false
    if ((target?.pageId ?? null) !== this.lastTarget) {
      this.lastTarget = target?.pageId ?? null
      this.sendStatus(true)
      this.gotoVisible()
      return
    }
    this.sendStatus(moved)
    this.showFrame()
    this.scheduleView()
  }

  private sendStatus(force = false): void {
    const target = this.deps.notebook.target()
    const page = target ? this.deps.notebook.page(target.pageId) : undefined
    const pen = this.deps.notebook.pen()
    const status: PhonePadOutgoing = {
      type: 'status',
      ready: !!page,
      title: target?.title.slice(0, 200) ?? '',
      pen: { color: pen.color, size: pen.size },
      page:
        target && page
          ? {
              key: target.pageId,
              width: page.width,
              height: page.height,
              paper: { ...page.paper },
              growable: !page.background,
              epoch: this.epoch(target.pageId),
              origin: this.origin(target.pageId)
            }
          : null
    }
    const key = JSON.stringify(status)
    if (!force && key === this.lastStatus) return
    this.lastStatus = key
    this.deps.send(status)
  }

  /** Points the phone at what the computer shows (on connect and when another page opens). */
  private gotoVisible(): void {
    const target = this.deps.notebook.target()
    const c = this.deps.canvas.camera()
    const page = target ? this.deps.notebook.page(target.pageId) : undefined
    if (!target || !page) {
      this.viewport = null
      this.viewportPage = null
      this.showFrame()
      return
    }
    const area =
      (c && c.pageId === target.pageId ? phoneArea(c.cam, c.view, c.page, this.surface.aspect) : null) ??
      // Not on screen yet: the top of the page, full width.
      { x: 0, y: 0, width: page.width, height: page.width / this.surface.aspect }
    this.viewport = area
    this.viewportPage = target.pageId
    this.deps.send({ type: 'goto', key: target.pageId, epoch: this.epoch(target.pageId), rect: [area.x, area.y, area.width, area.height] })
    this.showFrame()
    this.scheduleView(0)
  }

  private onViewport(rect: PageRect, epoch: number): void {
    const target = this.deps.notebook.target()
    if (!target) return
    const [dx, dy] = this.delta(target.pageId, epoch)
    const r = rectOf(rect)
    this.viewport = { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }
    this.viewportPage = target.pageId
    this.showFrame()
    // The computer keeps the phone's frame in sight.
    const c = this.deps.canvas.camera()
    if (c && c.pageId === target.pageId) {
      const next = followCamera(c.cam, c.view, this.viewport)
      if (next) this.deps.canvas.setCamera(next)
    }
    this.scheduleView()
  }

  /** How far content moved between `epoch` and now. */
  private delta(pageId: string, epoch: number | undefined): [number, number] {
    const now = this.origin(pageId)
    const then = this.origin(pageId, epoch)
    return [now[0] - then[0], now[1] - then[1]]
  }

  private showFrame(): void {
    const target = this.deps.notebook.target()
    const on = !!target && this.viewportPage === target.pageId && !!this.viewport
    phoneLive.area = on ? this.viewport : null
    phoneLive.pageId = on ? target!.pageId : null
    phoneLive.changed()
  }

  // ---- Ink -----------------------------------------------------------------

  private ink(m: InkMessage): void {
    if (m.phase === 'down') return this.down(m)
    const p = this.pending.get(m.stroke)
    if (!p) return
    if (m.phase === 'cancel') {
      this.pending.delete(m.stroke)
      phoneLive.ink.delete(m.stroke)
      phoneLive.changed()
      return
    }
    this.addPoints(m.stroke, p, m.points, this.areas.get(m.stroke)!)
    if (m.phase === 'up') this.finish(m.stroke, p)
  }

  private areas = new Map<string, Area>()

  private down(m: InkMessage): void {
    const target = this.deps.notebook.target()
    if (!target || !m.view) {
      this.sendStatus(true)
      return
    }
    // The stroke maps into the rectangle the phone showed, corrected for content moves since.
    const [dx, dy] = this.delta(target.pageId, m.epoch)
    const v = rectOf(m.view)
    const area = { x: v.x + dx, y: v.y + dy, width: v.width, height: v.height }
    const pen = this.deps.notebook.pen()
    const p: Pending = { pageId: target.pageId, origin: this.origin(target.pageId), tool: m.tool ?? 'pen', points: [] }
    if (p.tool === 'eraser') {
      p.erase = { state: newEraseState(pen.precise), radius: (m.radius ?? 0.02) * area.width, last: null }
    } else {
      const first = m.points[0]
      p.style = {
        tool: 'pen',
        // The pen the phone drew with; the computer's pen if an older phone page didn't say.
        color: m.color?.toLowerCase() ?? pen.color,
        size: m.size ?? pen.size,
        opacity: 1,
        // Real pressure only from a stylus that reports it.
        hasPressure: m.pointer === 'pen' && !!first && first.length === 4 && first[3]! > 0
      }
    }
    this.pending.set(m.stroke, p)
    this.areas.set(m.stroke, area)
    this.addPoints(m.stroke, p, m.points, area)
  }

  private addPoints(id: string, p: Pending, points: InkPoint[], area: Area): void {
    for (const q of points) {
      if (p.points.length >= PHONEPAD_LIMITS.maxPointsPerStroke) break
      const [x, y] = toPage(area, q[0], q[1])
      const pt: Point = p.style?.hasPressure ? [x, y, Math.min(1, Math.max(0, q[3] ?? 0.5))] : [x, y]
      p.points.push(pt)
      if (p.erase) {
        const page = this.deps.notebook.page(p.pageId)
        if (page) eraseSegment(p.erase.state, page.objects, p.erase.last ?? pt, pt, p.erase.radius)
        p.erase.last = pt
      }
    }
    if (!p.points.length) return
    if (p.erase) phoneLive.ink.set(id, { kind: 'erase', points: p.points, radius: p.erase.radius })
    else if (p.style) {
      phoneLive.ink.set(id, { kind: 'ink', path: new Path2D(outlinePath(p.points, p.style, false)), color: p.style.color, opacity: 1, highlighter: false })
    }
    phoneLive.changed()
  }

  private finish(id: string, p: Pending): void {
    this.pending.delete(id)
    this.areas.delete(id)
    phoneLive.ink.delete(id)
    phoneLive.changed()
    if (!p.points.length) return
    // Content moved while the stroke was written (another stroke grew the page): follow it.
    const now = this.origin(p.pageId)
    const mx = now[0] - p.origin[0]
    const my = now[1] - p.origin[1]
    const points = mx || my ? p.points.map((q) => [q[0] + mx, q[1] + my, ...q.slice(2)] as Point) : p.points
    const page = this.deps.notebook.page(p.pageId)
    if (!page) return
    let result: RunResult | null = null
    if (p.erase) {
      if (p.erase.state.hits.size) result = this.deps.notebook.run(eraseCommands(p.erase.state, page.objects), { label: 'Erase', pageId: p.pageId })
    } else if (p.style) {
      const { tool, color, size, opacity, hasPressure } = p.style
      const commands: CanvasCommand[] = []
      let ink = simplify(points)
      // Infinite paper: ink past the edge grows the page (PDF pages keep their size).
      const grow = page.background ? null : growthFor(inkBounds(ink, size), page, page.paper.spacing, GROW_MARGIN, MAX_PAGE_SIZE)
      if (grow) {
        commands.push({ type: 'extendPage', ...grow })
        if (grow.left || grow.top) ink = ink.map((q) => [q[0] + grow.left, q[1] + grow.top, ...q.slice(2)] as Point)
      }
      commands.push({ type: 'createStroke', stroke: { tool, color, size, opacity, hasPressure, points: ink } })
      result = this.deps.notebook.run(commands, { label: 'Draw', pageId: p.pageId })
    }
    if (result && !result.ok) console.error('PhonePad:', result.error)
    this.committed.push(id)
    if (this.committed.length > 200) this.committed.splice(0, this.committed.length - 200)
    this.scheduleView()
  }

  /** Strokes still being written (nothing commits until they end). */
  get writing(): number {
    return this.pending.size
  }

  // ---- Commands ------------------------------------------------------------

  private command(action: 'undo' | 'redo' | 'clear'): void {
    const target = this.deps.notebook.target()
    if (!target) return
    if (action === 'undo') return this.deps.notebook.undo()
    if (action === 'redo') return this.deps.notebook.redo()
    const page = this.deps.notebook.page(target.pageId)
    const area = this.viewportPage === target.pageId ? this.viewport : null
    if (!page || !area) return
    // Clear = the ink (pen and highlighter strokes) entirely inside the phone's view.
    const inside = page.objects.filter((o) => {
      if (o.type !== 'stroke') return false
      const b = objectBounds(o)
      return b.x >= area.x - 0.5 && b.y >= area.y - 0.5 && b.x + b.width <= area.x + area.width + 0.5 && b.y + b.height <= area.y + area.height + 0.5
    })
    if (inside.length) this.deps.notebook.run([{ type: 'deleteObjects', ids: inside.map((o) => o.id) }], { label: 'Clear PhonePad area', pageId: target.pageId })
  }

  // ---- The phone's picture --------------------------------------------------

  scheduleView(delay = this.deps.viewDelayMs ?? 150): void {
    if (!this.connected) return
    if (this.viewTimer) clearTimeout(this.viewTimer)
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null
      void this.refreshView()
    }, delay)
  }

  async refreshView(): Promise<void> {
    if (!this.connected) return
    // A stroke in progress: the phone draws it itself; refresh once it ends.
    if (this.pending.size) return this.scheduleView()
    if (this.rendering) {
      this.renderAgain = true
      return
    }
    const target = this.deps.notebook.target()
    const vp = this.viewport
    const page = target ? this.deps.notebook.page(target.pageId) : undefined
    if (!target || !vp || !page || this.viewportPage !== target.pageId) return
    // What the phone sees, plus a margin, clipped to the page (outside it, the phone draws its own paper).
    const over = { x: vp.x - vp.width * OVERSCAN, y: vp.y - vp.height * OVERSCAN, width: vp.width * (1 + 2 * OVERSCAN), height: vp.height * (1 + 2 * OVERSCAN) }
    const x0 = Math.max(0, over.x)
    const y0 = Math.max(0, over.y)
    const x1 = Math.min(page.width, over.x + over.width)
    const y1 = Math.min(page.height, over.y + over.height)
    if (x1 - x0 < 1 || y1 - y0 < 1) return
    this.rendering = true
    try {
      const rect = clipRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, page, 0)
      const phonePx = (this.surface.width * this.surface.dpr) / vp.width
      const pixelRatio = Math.max(0.05, Math.min(8, phonePx, VIEW_MAX_PX / Math.max(rect.width, rect.height)))
      const strokes = [...this.committed]
      const epoch = this.epoch(target.pageId)
      const image = await this.deps.render(page, rect, pixelRatio)
      // A move during rendering would misplace the picture; the next refresh replaces it.
      if (image && epoch === this.epoch(target.pageId)) {
        this.deps.send({ type: 'view', rev: ++this.viewRev, key: target.pageId, epoch, image, rect: [rect.x, rect.y, rect.width, rect.height], strokes })
      }
    } finally {
      this.rendering = false
      if (this.renderAgain) {
        this.renderAgain = false
        this.scheduleView()
      }
    }
  }
}

/** Bounds of ink including its thickness. */
function inkBounds(points: Point[], size: number): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const r = size / 2 + 1
  return { x: x0 - r, y: y0 - r, width: x1 - x0 + 2 * r, height: y1 - y0 + 2 * r }
}
