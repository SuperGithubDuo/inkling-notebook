/**
 * Wires WISP's independent parts together for the standalone app:
 *
 *   WebcamInput ─┐
 *                ├─► StrokeEngine ──events──► CanvasRenderer (active stroke, cursor)
 *   MouseInput ──┘         │
 *                          └─ strokeEnd ─► DocumentStore (undo/redo) ─► CanvasRenderer (ink)
 *
 * Exactly one input source is active at a time. React talks only to this
 * controller (and the store), never to MediaPipe or the canvas directly.
 */
import { CanvasRenderer } from '../canvas/renderer'
import { MouseInput } from '../input/mouseInput'
import { WebcamInput } from '../input/webcamInput'
import { DocumentStore } from '../strokes/documentStore'
import { parseDocument, serializeDocument, type ParseResult } from '../strokes/serialization'
import { StrokeEngine } from '../strokes/strokeEngine'
import { createDocument, type PenStyle } from '../strokes/types'
import { guideLines, restoreOriginal, tidyLines, type TidyReport } from '../strokes/layout'
import type { WispSettings } from './settings'

export type InputMode = 'webcam' | 'mouse'

export class WispController {
  readonly engine: StrokeEngine
  readonly store: DocumentStore
  private renderer: CanvasRenderer | null = null
  private webcam: WebcamInput | null = null
  private mouse: MouseInput | null = null
  private _mode: InputMode = 'mouse'
  private readonly unsubs: Array<() => void> = []
  private settings: WispSettings

  constructor(settings: WispSettings, pen: PenStyle) {
    this.settings = settings
    this.store = new DocumentStore(createDocument())
    this.engine = new StrokeEngine({ smoothing: settings.smoothing, stabilizer: settings.stabilizer, refine: settings.refine, style: pen })
  }

  get mode(): InputMode {
    return this._mode
  }

  get webcamInput(): WebcamInput | null {
    return this.webcam
  }

  /** Called once the DOM exists. */
  mount(canvasHost: HTMLElement, video: HTMLVideoElement): void {
    if (this.renderer) return
    this.renderer = new CanvasRenderer(canvasHost)
    this.unsubs.push(
      this.engine.onStrokeStart(({ stroke }) => this.renderer?.setActiveStroke(stroke)),
      this.engine.onStrokeUpdate(() => this.renderer?.setActiveStroke(this.engine.activeStroke)),
      this.engine.onStrokeEnd(({ stroke }) => {
        this.store.addStroke(stroke)
        this.renderer?.setActiveStroke(null)
      }),
      this.engine.onCursor((c) => this.renderer?.setCursor({ x: c.x, y: c.y, down: c.down, visible: true })),
      this.engine.events.on('cursorHidden', () => this.renderer?.setCursor({ visible: false })),
      this.store.subscribe(() => this.renderer?.setDocument(this.store.document))
    )
    this.renderer.setDocument(this.store.document)
    this.renderer.setPen(this.engine.style.color, this.engine.style.width)
    this.mouse = new MouseInput(this.renderer.eventTarget, this.engine, () => this.renderer!.fit)
    this.webcam = new WebcamInput(video, this.engine, {
      mirror: this.settings.mirror,
      writingSensitivity: this.settings.writingSensitivity,
      pinchSensitivity: this.settings.pinchSensitivity,
      releaseSensitivity: this.settings.releaseSensitivity,
      penPoint: this.settings.penPoint,
      pinchMetric: this.settings.pinchMetric,
      region: this.settings.region,
      keepScale: this.settings.writingMode === 'assist',
      pageAspect: this.store.document.canvas.width / this.store.document.canvas.height
    })
    if (this._mode === 'mouse') this.mouse.attach()
    this.applyGuides()
  }

  /** Guides follow the writing scale, so ruled lines match the size the mapping produces. */
  private guides() {
    return guideLines(this.store.document.canvas, this.settings.writingSensitivity)
  }

  private applyGuides(): void {
    const s = this.settings
    this.renderer?.setGuides(
      s.showGuides ? { ...this.guides(), baseline: s.guideBaseline, xHeightLine: s.guideXHeight, capLine: s.guideCapHeight, lineSpacing: s.guideLineSpacing } : null
    )
  }

  /**
   * Writing Assist: straighten slightly tilted lines and, with guides shown,
   * align them to the nearest ruled line. Whole lines move rigidly; nothing is
   * resized; reversible (undo, or restoreOriginal). See strokes/layout.ts.
   */
  tidyLines(): TidyReport {
    this.engine.end('stopped')
    const doc = this.store.document
    const g = this.settings.showGuides && this.settings.guideBaseline ? this.guides() : null
    const { strokes, report } = tidyLines(doc.strokes, doc.canvas, { guides: g ? { firstBaseline: g.baselines[0]!, pitch: g.pitch } : null })
    if (report.straightened + report.aligned > 0) this.store.replace({ ...doc, strokes, updatedAt: Date.now() })
    return report
  }

  /** Puts every tidied stroke back exactly where it was written. Returns how many moved. */
  restoreOriginal(): number {
    this.engine.end('stopped')
    const doc = this.store.document
    const n = doc.strokes.filter((s) => s.assist).length
    if (n > 0) this.store.replace({ ...doc, strokes: restoreOriginal(doc.strokes, doc.canvas), updatedAt: Date.now() })
    return n
  }

  /** Measure the hand again for the automatic writing area. */
  refitWritingArea(): void {
    this.webcam?.refit()
  }

  setMode(mode: InputMode): void {
    if (mode === this._mode) return
    this.engine.end('source-changed')
    this._mode = mode
    if (mode === 'mouse') {
      this.webcam?.stop()
      this.mouse?.attach()
    } else {
      this.mouse?.detach()
    }
  }

  async startWebcam(): Promise<void> {
    this.setMode('webcam')
    await this.webcam?.start()
  }

  stopWebcam(): void {
    this.webcam?.stop()
  }

  applySettings(s: WispSettings): void {
    this.settings = s
    this.engine.setSmoothing(s.smoothing)
    this.engine.setStabilizer(s.stabilizer)
    this.engine.setRefine(s.refine)
    this.webcam?.configure({
      mirror: s.mirror,
      writingSensitivity: s.writingSensitivity,
      pinchSensitivity: s.pinchSensitivity,
      releaseSensitivity: s.releaseSensitivity,
      penPoint: s.penPoint,
      pinchMetric: s.pinchMetric,
      region: s.region,
      keepScale: s.writingMode === 'assist'
    })
    this.applyGuides()
  }

  setPen(pen: Partial<PenStyle>): void {
    this.engine.setStyle(pen)
    this.renderer?.setPen(this.engine.style.color, this.engine.style.width)
  }

  undo(): void {
    if (this.engine.activeStroke) return // finish the stroke first
    this.store.undo()
  }

  redo(): void {
    if (this.engine.activeStroke) return
    this.store.redo()
  }

  clear(): void {
    this.engine.end('stopped')
    this.store.clear()
  }

  exportJson(): string {
    return serializeDocument(this.store.document, true)
  }

  importJson(text: string): ParseResult {
    const res = parseDocument(text)
    if (res.ok) {
      this.engine.end('stopped')
      this.store.replace(res.doc)
      this.webcam?.configure({ pageAspect: res.doc.canvas.width / res.doc.canvas.height })
    }
    return res
  }

  exportPng(): Promise<Blob> {
    return CanvasRenderer.exportPng(this.store.document, 1)
  }

  /**
   * Releases everything mount() created: camera, model, loops, DOM listeners,
   * canvases. The document survives, so mount() can be called again
   * (React StrictMode mounts effects twice in development).
   */
  unmount(): void {
    this.engine.end('stopped')
    this.unsubs.splice(0).forEach((u) => u())
    this.mouse?.detach()
    this.webcam?.dispose()
    this.renderer?.dispose()
    this.renderer = null
    this.webcam = null
    this.mouse = null
  }
}
