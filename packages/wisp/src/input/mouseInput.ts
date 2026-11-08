/**
 * Mouse simulation input: the pointer stands in for the fingertip and the
 * left button for the pinch. It feeds the SAME StrokeEngine as the webcam,
 * so smoothing, outlier rejection, storage, undo and export are all shared.
 */
import { screenToPage, type PageFit } from '../strokes/coordinates'
import type { StrokeEngine } from '../strokes/strokeEngine'

export class MouseInput {
  private down = false
  private attached = false

  constructor(
    private readonly target: HTMLElement,
    private readonly engine: StrokeEngine,
    private readonly getFit: () => PageFit
  ) {}

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.target.addEventListener('pointerdown', this.onDown)
    this.target.addEventListener('pointermove', this.onMove)
    this.target.addEventListener('pointerup', this.onUp)
    this.target.addEventListener('pointercancel', this.onCancel)
    this.target.addEventListener('pointerleave', this.onLeave)
    this.target.addEventListener('lostpointercapture', this.onCancel)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.target.removeEventListener('pointerdown', this.onDown)
    this.target.removeEventListener('pointermove', this.onMove)
    this.target.removeEventListener('pointerup', this.onUp)
    this.target.removeEventListener('pointercancel', this.onCancel)
    this.target.removeEventListener('pointerleave', this.onLeave)
    this.target.removeEventListener('lostpointercapture', this.onCancel)
    if (this.down) this.engine.end('source-changed')
    this.down = false
    this.engine.hideCursor(performance.now())
  }

  private feed(e: PointerEvent, down: boolean): void {
    const rect = this.target.getBoundingClientRect()
    const p = screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top }, this.getFit())
    this.engine.input({ x: p.x, y: p.y, t: e.timeStamp || performance.now(), source: 'mouse' }, down)
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    this.down = true
    try {
      this.target.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events in tests can't be captured */
    }
    this.feed(e, true)
  }

  private readonly onMove = (e: PointerEvent): void => {
    // Coalesced events give every hardware sample between frames, for accuracy.
    const events = this.down && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    if (events.length > 0) for (const c of events) this.feed(c, this.down)
    else this.feed(e, this.down)
  }

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.down) return
    this.feed(e, true)
    this.down = false
    this.engine.end('released')
  }

  private readonly onCancel = (): void => {
    if (!this.down) return
    this.down = false
    this.engine.end('released')
  }

  private readonly onLeave = (): void => {
    if (!this.down) this.engine.hideCursor(performance.now())
  }
}
