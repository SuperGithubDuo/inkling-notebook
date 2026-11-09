/**
 * What the page canvas draws for PhonePad on its live layer: strokes still
 * being written on the phone, and the frame showing where the phone writes.
 * Kept outside React (like the canvas's own in-progress ink) so phone points
 * never cause React renders; the canvas subscribes and redraws its live layer.
 */
import type { Point } from '@shared/schema'
import type { Area } from './region'

export type PhoneInk =
  | { kind: 'ink'; path: Path2D; color: string; opacity: number; highlighter: boolean }
  | { kind: 'erase'; points: Point[]; radius: number }

type Listener = () => void

class LiveHub {
  /** The page the frame and live ink belong to. */
  pageId: string | null = null
  area: Area | null = null
  ink = new Map<string, PhoneInk>()
  private listeners = new Set<Listener>()
  private cameraListeners = new Set<Listener>()
  private frame = 0

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Redraw on the next animation frame (coalesces many updates). */
  changed(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.listeners.forEach((fn) => fn())
    })
  }

  /** The canvas reports camera or size changes; PhonePad recomputes its area. */
  onCamera(fn: Listener): () => void {
    this.cameraListeners.add(fn)
    return () => this.cameraListeners.delete(fn)
  }

  cameraChanged(): void {
    this.cameraListeners.forEach((fn) => fn())
  }
}

export const phoneLive = new LiveHub()

const ACCENT = '#2f6be4'

/** Draws PhonePad's live layer content in page coordinates (`scale` = camera scale). */
export function drawPhoneLive(c: CanvasRenderingContext2D, pageId: string, scale: number): void {
  if (phoneLive.pageId !== pageId) return
  const area = phoneLive.area
  if (area) {
    c.save()
    c.setLineDash([8 / scale, 5 / scale])
    c.lineWidth = 1.5 / scale
    c.strokeStyle = ACCENT
    c.globalAlpha = 0.7
    c.strokeRect(area.x, area.y, area.width, area.height)
    // A small tab on the frame's corner says what it is.
    c.setLineDash([])
    c.globalAlpha = 1
    c.translate(area.x, area.y)
    c.scale(1 / scale, 1 / scale)
    c.font = '600 11px Inter, system-ui, sans-serif'
    const label = 'PhonePad'
    const w = c.measureText(label).width + 14
    c.fillStyle = ACCENT
    c.beginPath()
    c.roundRect(0, -20, w, 18, [6, 6, 6, 0])
    c.fill()
    c.fillStyle = '#ffffff'
    c.fillText(label, 7, -7)
    c.restore()
  }
  for (const ink of phoneLive.ink.values()) {
    c.save()
    if (ink.kind === 'ink') {
      c.globalAlpha = ink.opacity
      if (ink.highlighter) c.globalCompositeOperation = 'multiply'
      c.fillStyle = ink.color
      c.fill(ink.path)
    } else if (ink.points.length) {
      // The eraser's trail, so the computer shows what the phone is erasing.
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.lineWidth = ink.radius * 2
      c.strokeStyle = 'rgba(138, 143, 156, 0.22)'
      c.beginPath()
      ink.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
      if (ink.points.length === 1) c.lineTo(ink.points[0]![0] + 0.01, ink.points[0]![1])
      c.stroke()
    }
    c.restore()
  }
}
