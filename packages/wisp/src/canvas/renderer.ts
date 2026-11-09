/**
 * Canvas 2D renderer for the standalone prototype.
 *
 * Two stacked canvases:
 *   ink     – the page and all completed strokes; redrawn only when the
 *             document or the size changes.
 *   overlay – the stroke being written and the cursor; redrawn on the next
 *             animation frame after any input event.
 * Input events only mark the overlay dirty, so drawing cost is decoupled from
 * the tracking rate and React never re-renders while writing.
 *
 * Ink outlines come from perfect-freehand (MIT), the same library Inkling uses,
 * so WISP ink looks like Inkling ink. Points are densified with Catmull-Rom
 * first so 30 fps webcam strokes stay round instead of polygonal.
 */
import { getStroke } from 'perfect-freehand'
import { fitPage, pageToScreen, type PageFit } from '../strokes/coordinates'
import type { GuideLines } from '../strokes/layout'

/** Guides to draw (v0.1.4), or null. */
export type GuideOverlay = (GuideLines & { baseline: boolean; xHeightLine: boolean; capLine: boolean; lineSpacing: boolean }) | null
import { densify } from '../strokes/smoothing'
import type { CanvasMeta, Stroke, WispDocument } from '../strokes/types'

export interface CursorState {
  x: number
  y: number
  down: boolean
  visible: boolean
}

const PAGE_PADDING = 28
/** Corner radius of the page sheet (CSS px). Small, so the drawable corners are visible. */
const PAGE_RADIUS = 2

function outline(stroke: Pick<Stroke, 'points' | 'width'>, page: CanvasMeta, complete: boolean): Path2D {
  const pts = stroke.points.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))
  const dense = densify(pts, 3)
  const o = getStroke(
    dense.map((p) => [p.x, p.y, 0.5]),
    {
      size: stroke.width,
      thinning: 0,
      smoothing: 0.5,
      // Points are already filtered; keep streamline low to avoid extra lag.
      streamline: 0.2,
      simulatePressure: false,
      last: complete,
      start: { cap: true, taper: 0 },
      end: { cap: true, taper: 0 }
    }
  )
  const path = new Path2D()
  if (o.length === 0) return path
  if (o.length < 3) {
    path.arc(o[0]![0]!, o[0]![1]!, stroke.width / 2, 0, Math.PI * 2)
    return path
  }
  path.moveTo(o[0]![0]!, o[0]![1]!)
  for (let i = 1; i < o.length; i++) {
    const a = o[i]!
    const b = o[(i + 1) % o.length]!
    path.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2)
  }
  path.closePath()
  return path
}

export class CanvasRenderer {
  readonly ink: HTMLCanvasElement
  readonly overlay: HTMLCanvasElement
  private doc: WispDocument | null = null
  private active: Readonly<Stroke> | null = null
  private cursor: CursorState = { x: 0, y: 0, down: false, visible: false }
  private cursorColor = '#1f2430'
  private cursorWidth = 4
  private guides: GuideOverlay = null
  /** Ghost Whiteboard: page opacity (1 = normal opaque page) and whether the area around the page is veiled. */
  private boardAlpha = 1
  private ghost = false
  private _fit: PageFit = { left: 0, top: 0, width: 1, height: 1 }
  private cssW = 1
  private cssH = 1
  private dpr = 1
  private inkDirty = true
  private overlayDirty = true
  private raf: number | null = null
  private readonly cache = new WeakMap<Stroke, Path2D>()
  private readonly ro: ResizeObserver

  constructor(private readonly container: HTMLElement) {
    this.ink = document.createElement('canvas')
    this.overlay = document.createElement('canvas')
    for (const c of [this.ink, this.overlay]) {
      c.style.position = 'absolute'
      c.style.inset = '0'
      c.style.width = '100%'
      c.style.height = '100%'
      container.appendChild(c)
    }
    this.overlay.style.touchAction = 'none'
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
  }

  get fit(): PageFit {
    return this._fit
  }

  get eventTarget(): HTMLElement {
    return this.overlay
  }

  setDocument(doc: WispDocument): void {
    if (doc === this.doc) return
    const sizeChanged = !this.doc || this.doc.canvas.width !== doc.canvas.width || this.doc.canvas.height !== doc.canvas.height
    this.doc = doc
    if (sizeChanged) this.computeFit()
    this.inkDirty = true
    this.overlayDirty = true
    this.schedule()
  }

  setActiveStroke(s: Readonly<Stroke> | null): void {
    this.active = s
    this.overlayDirty = true
    this.schedule()
  }

  setCursor(c: Partial<CursorState>): void {
    this.cursor = { ...this.cursor, ...c }
    this.overlayDirty = true
    this.schedule()
  }

  /**
   * Ghost Whiteboard: draw the page at `opacity` (the webcam shows through
   * it) and veil the area around the page. Ink, guides and cursor stay fully
   * opaque. Display only: exports never include it.
   */
  setBoard(opacity: number, ghost: boolean): void {
    const a = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
    if (a === this.boardAlpha && ghost === this.ghost) return
    this.boardAlpha = a
    this.ghost = ghost
    this.inkDirty = true
    this.schedule()
  }

  /** Writing guides drawn under the ink (never exported). */
  setGuides(g: GuideOverlay): void {
    this.guides = g
    this.inkDirty = true
    this.schedule()
  }

  private drawGuides(ctx: CanvasRenderingContext2D, page: CanvasMeta): void {
    const g = this.guides
    if (!g) return
    const px = page.width / this._fit.width // page px per CSS px: keeps lines 1 CSS px thick
    ctx.save()
    g.baselines.forEach((b, i) => {
      if (g.lineSpacing && i % 2 === 0) {
        // Faint band for every other line: shows line spacing at a glance.
        ctx.fillStyle = 'rgba(47, 107, 228, 0.035)'
        ctx.fillRect(0, b - g.pitch * 0.85, page.width, g.pitch)
      }
      const line = (y: number, color: string, dash: number[]) => {
        ctx.strokeStyle = color
        ctx.lineWidth = px
        ctx.setLineDash(dash.map((d) => d * px))
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(page.width, y)
        ctx.stroke()
      }
      if (g.baseline) line(b, 'rgba(47, 107, 228, 0.38)', [])
      if (g.xHeightLine) line(b - g.xHeight, 'rgba(47, 107, 228, 0.28)', [6, 5])
      if (g.capLine) line(b - g.capHeight, 'rgba(47, 107, 228, 0.18)', [2, 5])
    })
    ctx.restore()
  }

  setPen(color: string, width: number): void {
    this.cursorColor = color
    this.cursorWidth = width
    this.overlayDirty = true
    this.schedule()
  }

  /** Renders the document to a PNG at `scale` × logical page size. */
  static async exportPng(doc: WispDocument, scale = 1): Promise<Blob> {
    const c = document.createElement('canvas')
    c.width = Math.round(doc.canvas.width * scale)
    c.height = Math.round(doc.canvas.height * scale)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = doc.canvas.background
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.scale(scale, scale)
    for (const s of doc.strokes) {
      ctx.fillStyle = s.color
      ctx.fill(outline(s, doc.canvas, true))
    }
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'))
  }

  dispose(): void {
    this.ro.disconnect()
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.ink.remove()
    this.overlay.remove()
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    this.cssW = Math.max(1, r.width)
    this.cssH = Math.max(1, r.height)
    this.dpr = Math.min(3, window.devicePixelRatio || 1)
    for (const c of [this.ink, this.overlay]) {
      c.width = Math.round(this.cssW * this.dpr)
      c.height = Math.round(this.cssH * this.dpr)
    }
    this.computeFit()
    this.inkDirty = true
    this.overlayDirty = true
    this.draw() // synchronous: avoids a blank flash while resizing
  }

  private computeFit(): void {
    const page = this.doc?.canvas ?? { width: 1600, height: 1000 }
    this._fit = fitPage(this.cssW, this.cssH, page.width, page.height, PAGE_PADDING)
  }

  private schedule(): void {
    if (this.raf !== null) return
    this.raf = requestAnimationFrame(() => {
      this.raf = null
      this.draw()
    })
  }

  private pageTransform(ctx: CanvasRenderingContext2D, page: CanvasMeta): void {
    const f = this._fit
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.translate(f.left, f.top)
    ctx.scale(f.width / page.width, f.height / page.height)
  }

  private draw(): void {
    if (this.inkDirty) this.drawInk()
    if (this.overlayDirty) this.drawOverlay()
  }

  private drawInk(): void {
    this.inkDirty = false
    const ctx = this.ink.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.ink.width, this.ink.height)
    const doc = this.doc
    if (!doc) return
    const f = this._fit
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.ghost) {
      // Ghost Whiteboard: veil everything around the board, so the board is the main surface.
      ctx.save()
      ctx.fillStyle = 'rgba(246, 246, 247, 0.94)'
      ctx.beginPath()
      ctx.rect(0, 0, this.cssW, this.cssH)
      ctx.rect(f.left, f.top, f.width, f.height)
      ctx.fill('evenodd')
      ctx.restore()
    }
    ctx.save()
    if (this.boardAlpha >= 1) {
      // Page with a soft shadow, like a sheet on Inkling's shell.
      ctx.shadowColor = 'rgba(30, 36, 60, 0.10)'
      ctx.shadowBlur = 24
      ctx.shadowOffsetY = 6
    }
    // A translucent board gets no shadow (it would show through as a grey tint).
    ctx.globalAlpha = this.boardAlpha
    ctx.fillStyle = doc.canvas.background
    ctx.beginPath()
    ctx.roundRect(f.left, f.top, f.width, f.height, PAGE_RADIUS)
    ctx.fill()
    ctx.restore()
    if (this.boardAlpha < 1) {
      // The board's edge, so all four edges stay visible over the webcam.
      ctx.save()
      ctx.strokeStyle = 'rgba(30, 36, 60, 0.18)'
      ctx.lineWidth = 1
      ctx.strokeRect(f.left - 0.5, f.top - 0.5, f.width + 1, f.height + 1)
      ctx.restore()
    }
    ctx.save()
    // v0.1.4: clip ink to the page RECTANGLE. v0.1–v0.1.3 clipped to the
    // rounded page shape (10 px radius), which hid ink drawn into the corners.
    ctx.beginPath()
    ctx.rect(f.left, f.top, f.width, f.height)
    ctx.clip()
    this.pageTransform(ctx, doc.canvas)
    this.drawGuides(ctx, doc.canvas)
    for (const s of doc.strokes) {
      let p = this.cache.get(s)
      if (!p) this.cache.set(s, (p = outline(s, doc.canvas, true)))
      ctx.fillStyle = s.color
      ctx.fill(p)
    }
    ctx.restore()
  }

  private drawOverlay(): void {
    this.overlayDirty = false
    const ctx = this.overlay.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height)
    const doc = this.doc
    if (!doc) return
    if (this.active && this.active.points.length > 0) {
      ctx.save()
      // Same clip as the finished ink, so live and final strokes look the same at the edges.
      const f = this._fit
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.beginPath()
      ctx.rect(f.left, f.top, f.width, f.height)
      ctx.clip()
      this.pageTransform(ctx, doc.canvas)
      ctx.fillStyle = this.active.color
      ctx.fill(outline(this.active, doc.canvas, false))
      ctx.restore()
    }
    if (this.cursor.visible) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      const s = pageToScreen(this.cursor, this._fit)
      const penR = Math.max(2, (this.cursorWidth * this._fit.width) / doc.canvas.width / 2)
      if (this.cursor.down) {
        ctx.fillStyle = this.cursorColor
        ctx.beginPath()
        ctx.arc(s.x, s.y, penR + 1, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // Hover: hollow ring, so it's obvious the pen is up.
        ctx.strokeStyle = 'rgba(47, 107, 228, 0.9)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(s.x, s.y, penR + 7, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = 'rgba(47, 107, 228, 0.9)'
        ctx.beginPath()
        ctx.arc(s.x, s.y, 2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}
