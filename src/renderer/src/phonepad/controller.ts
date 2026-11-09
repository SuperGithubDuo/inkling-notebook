/**
 * PhonePad in the notebook: turns the phone's events into ordinary edits.
 *
 * - Ink becomes `createStroke` commands run through the store, exactly like
 *   the pen: one undo step per stroke, saved by the save queue, in PDF export.
 *   It uses the pen (or highlighter) colour and size picked on the computer.
 * - The eraser uses the same hit testing and commands as the canvas eraser.
 * - Undo/redo are the notebook's; clear removes ink inside the writing area
 *   as one undoable step.
 * - The phone gets a picture of its writing area after each change, so it
 *   shows paper, PDF pages and existing ink under the pen.
 *
 * Talks to the rest of the app only through the ports below, so it is
 * unit-tested with fakes; install.ts connects the real store and canvas.
 */
import type { CanvasCommand } from '@/canvas/commands'
import type { RunResult } from '@/store/store'
import { outlinePath, type InkStyle } from '@/canvas/ink'
import { objectBounds } from '@/canvas/geometry'
import { clipRect } from '@/canvas/stageRef'
import type { Camera, Size } from '@/canvas/viewport'
import { eraseCommands, eraseSegment, newEraseState, simplify, type EraseState } from '@/canvas/strokeOps'
import type { PageDoc, Point } from '@shared/schema'
import type { InkMessage, InkPoint, PhonePadEvent, PhonePadOutgoing } from '@shared/phonepad'
import { PHONEPAD_LIMITS } from '@shared/phonepad'
import { phoneArea, panToScreen, toArea, toPage, zoomOrigin, type Area } from './region'
import { phoneLive } from './live'

const HIGHLIGHTER_OPACITY = 0.45
/** Longest edge of the picture sent to the phone, in pixels. */
const VIEW_MAX_PX = 1600

export interface NotebookPort {
  /** The page the phone writes on: the open handwritten page, unless it can't be edited. */
  target(): { pageId: string; title: string } | null
  page(pageId: string): PageDoc | undefined
  /** The computer's current pen settings. */
  style(): { color: string; size: number; highlighter: boolean; highlightColor: string; highlightSize: number; precise: boolean }
  run(commands: CanvasCommand[], options: { label: string; pageId: string }): RunResult
  undo(): void
  redo(): void
  /** Called on every change of page content, page, tool or style. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void
}

export interface CanvasPort {
  camera(): { pageId: string; cam: Camera; view: Size; page: Size } | null
  navigate(op: { pan?: [number, number]; zoom?: { factor: number; sx: number; sy: number } }): void
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

interface Pending {
  pageId: string
  area: Area
  tool: 'pen' | 'eraser'
  points: Point[]
  style?: InkStyle & { color: string; opacity: number }
  erase?: { state: EraseState; radius: number; last: Point | null }
}

export class PhonePadController {
  connected = false
  surface = { aspect: 2, width: 800, height: 400, dpr: 2 }
  area: Area | null = null
  private pending = new Map<string, Pending>()
  private committed: string[] = []
  private viewRev = 0
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private rendering = false
  private renderAgain = false
  private lastStatus = ''
  private unsubscribe: (() => void)[] = []

  constructor(private readonly deps: ControllerDeps) {}

  start(): void {
    this.unsubscribe.push(
      this.deps.notebook.subscribe(() => this.onNotebookChange()),
      phoneLive.onCamera(() => this.onCameraChange())
    )
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
        this.updateArea()
        this.sendStatus(true)
        return this.scheduleView(0)
      case 'ink':
        return this.ink(event.message)
      case 'command':
        return this.command(event.action)
      case 'pan':
        return this.pan(event.du, event.dv)
      case 'zoom':
        return this.zoom(event.factor, event.u, event.v)
    }
  }

  // ---- Connection and area ---------------------------------------------------

  private setConnected(connected: boolean): void {
    if (connected === this.connected) return
    this.connected = connected
    if (!connected) {
      // Drop previews; strokes are already committed or will be by the server's timeout.
      phoneLive.ink.clear()
      phoneLive.area = null
      phoneLive.pageId = null
      phoneLive.changed()
      this.lastStatus = ''
      return
    }
    this.updateArea()
    this.sendStatus(true)
    this.scheduleView(0)
  }

  private onCameraChange(): void {
    if (!this.connected) return
    const before = JSON.stringify(this.area)
    this.updateArea()
    if (JSON.stringify(this.area) !== before) {
      this.sendStatus()
      this.scheduleView()
    }
  }

  private onNotebookChange(): void {
    if (!this.connected) return
    this.updateArea()
    this.sendStatus()
    this.scheduleView()
  }

  private updateArea(): void {
    const target = this.deps.notebook.target()
    const c = this.deps.canvas.camera()
    this.area = target && c && c.pageId === target.pageId ? phoneArea(c.cam, c.view, c.page, this.surface.aspect) : null
    phoneLive.area = this.area
    phoneLive.pageId = this.area ? target!.pageId : null
    phoneLive.changed()
  }

  private sendStatus(force = false): void {
    const target = this.area ? this.deps.notebook.target() : null
    const s = this.deps.notebook.style()
    const size = s.highlighter ? s.highlightSize : s.size
    const status: PhonePadOutgoing = {
      type: 'status',
      page: target ? 'ready' : 'none',
      title: target?.title.slice(0, 200) ?? '',
      color: s.highlighter ? s.highlightColor : s.color,
      highlighter: s.highlighter,
      width: this.area ? Math.min(1, size / this.area.width) : 0
    }
    const key = JSON.stringify(status)
    if (!force && key === this.lastStatus) return
    this.lastStatus = key
    this.deps.send(status)
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
    this.addPoints(m.stroke, p, m.points)
    if (m.phase === 'up') this.finish(m.stroke, p)
  }

  private down(m: InkMessage): void {
    const target = this.deps.notebook.target()
    const c = this.deps.canvas.camera()
    // Each stroke keeps the area it started in (rotation or zoom mid-stroke can't bend it).
    const area = target && c && c.pageId === target.pageId ? phoneArea(c.cam, c.view, c.page, m.aspect ?? this.surface.aspect) : null
    if (!target || !area) {
      this.sendStatus(true)
      return
    }
    const s = this.deps.notebook.style()
    const p: Pending = { pageId: target.pageId, area, tool: m.tool ?? 'pen', points: [] }
    if (p.tool === 'eraser') {
      p.erase = { state: newEraseState(s.precise), radius: (m.radius ?? 0.02) * area.width, last: null }
    } else {
      const first = m.points[0]
      p.style = {
        tool: s.highlighter ? 'highlighter' : 'pen',
        color: s.highlighter ? s.highlightColor : s.color,
        size: s.highlighter ? s.highlightSize : s.size,
        opacity: s.highlighter ? HIGHLIGHTER_OPACITY : 1,
        // Real pressure only from a stylus that reports it.
        hasPressure: m.pointer === 'pen' && !!first && first.length === 4 && first[3]! > 0
      }
    }
    this.pending.set(m.stroke, p)
    this.addPoints(m.stroke, p, m.points)
  }

  private addPoints(id: string, p: Pending, points: InkPoint[]): void {
    for (const q of points) {
      if (p.points.length >= PHONEPAD_LIMITS.maxPointsPerStroke) break
      const [x, y] = toPage(p.area, q[0], q[1])
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
      phoneLive.ink.set(id, {
        kind: 'ink',
        path: new Path2D(outlinePath(p.points, p.style, false)),
        color: p.style.color,
        opacity: p.style.opacity,
        highlighter: p.style.tool === 'highlighter'
      })
    }
    phoneLive.pageId = phoneLive.pageId ?? p.pageId
    phoneLive.changed()
  }

  private finish(id: string, p: Pending): void {
    this.pending.delete(id)
    phoneLive.ink.delete(id)
    phoneLive.changed()
    if (!p.points.length) return
    let result: RunResult | null = null
    if (p.erase) {
      const page = this.deps.notebook.page(p.pageId)
      if (page && p.erase.state.hits.size) result = this.deps.notebook.run(eraseCommands(p.erase.state, page.objects), { label: 'Erase', pageId: p.pageId })
    } else if (p.style) {
      const { tool, color, size, opacity, hasPressure } = p.style
      result = this.deps.notebook.run([{ type: 'createStroke', stroke: { tool, color, size, opacity, hasPressure, points: simplify(p.points) } }], {
        label: tool === 'pen' ? 'Draw' : 'Highlight',
        pageId: p.pageId
      })
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

  // ---- Commands and navigation ---------------------------------------------

  private command(action: 'undo' | 'redo' | 'clear'): void {
    if (!this.deps.notebook.target()) return
    if (action === 'undo') return this.deps.notebook.undo()
    if (action === 'redo') return this.deps.notebook.redo()
    const target = this.deps.notebook.target()!
    const page = this.deps.notebook.page(target.pageId)
    const area = this.area
    if (!page || !area) return
    // Clear = the ink (pen and highlighter strokes) entirely inside the writing area.
    const inside = page.objects.filter((o) => {
      if (o.type !== 'stroke') return false
      const b = objectBounds(o)
      return b.x >= area.x - 0.5 && b.y >= area.y - 0.5 && b.x + b.width <= area.x + area.width + 0.5 && b.y + b.height <= area.y + area.height + 0.5
    })
    if (inside.length) this.deps.notebook.run([{ type: 'deleteObjects', ids: inside.map((o) => o.id) }], { label: 'Clear PhonePad area', pageId: target.pageId })
  }

  private pan(du: number, dv: number): void {
    const c = this.deps.canvas.camera()
    if (!this.area || !c) return
    this.deps.canvas.navigate({ pan: panToScreen(this.area, c.cam, du, dv) })
  }

  private zoom(factor: number, u: number, v: number): void {
    const c = this.deps.canvas.camera()
    if (!this.area || !c) return
    // Spreading fingers magnifies the phone's area: the computer zooms in on that spot.
    const [sx, sy] = zoomOrigin(this.area, c.cam, u, v)
    this.deps.canvas.navigate({ zoom: { factor, sx, sy } })
  }

  // ---- The phone's picture --------------------------------------------------

  scheduleView(delay = this.deps.viewDelayMs ?? 120): void {
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
    const area = this.area
    const page = target ? this.deps.notebook.page(target.pageId) : undefined
    if (!target || !area || !page) return
    this.rendering = true
    try {
      const rect = clipRect(area, page, 0)
      const longest = Math.max(this.surface.width, this.surface.height) * this.surface.dpr
      const pixelRatio = Math.min(VIEW_MAX_PX, longest) / Math.max(area.width, area.height)
      const strokes = [...this.committed]
      const image = await this.deps.render(page, rect, Math.max(0.1, Math.min(8, pixelRatio)))
      if (image) this.deps.send({ type: 'view', rev: ++this.viewRev, image, rect: toArea(area, rect), strokes })
    } finally {
      this.rendering = false
      if (this.renderAgain) {
        this.renderAgain = false
        this.scheduleView()
      }
    }
  }
}
