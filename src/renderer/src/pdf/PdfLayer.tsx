/**
 * Draws a PDF page underneath the canvas objects, re-rendered at the current
 * zoom (debounced) so text stays sharp. When the whole page would be too large
 * to render, only the visible part is rendered.
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { RenderTask } from 'pdfjs-dist'
import type { PdfBackground } from '@shared/schema'
import type { Camera, Size } from '@/canvas/viewport'
import { loadPdf } from './pdfjs'

/** Largest canvas we render into, in device pixels. */
const MAX_PIXELS = 4096 * 4096
const SETTLE_MS = 120

interface Region {
  /** CSS-pixel rect of the rendered canvas, relative to the viewport. */
  left: number
  top: number
  width: number
  height: number
}

export const PdfLayer = memo(function PdfLayer({
  notebookId,
  background,
  pageWidth,
  cam,
  view
}: {
  notebookId: string
  background: PdfBackground
  pageWidth: number
  cam: Camera
  view: Size
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const task = useRef<RenderTask | null>(null)
  const [rendered, setRendered] = useState<{ region: Region; cam: Camera } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(async () => {
      const el = canvas.current
      if (!el) return
      try {
        const doc = await loadPdf(notebookId, background.asset)
        const page = await doc.getPage(background.page + 1)
        const dpr = window.devicePixelRatio || 1
        // Screen pixels per PDF point.
        const cssScale = cam.scale * (pageWidth / background.width)
        const full = { left: cam.x, top: cam.y, width: background.width * cssScale, height: background.height * cssScale }
        let region: Region = full
        if (full.width * full.height * dpr * dpr > MAX_PIXELS) {
          // Only the visible part (plus a margin for panning) of a huge page.
          const margin = 256
          const left = Math.max(full.left, -margin)
          const top = Math.max(full.top, -margin)
          const right = Math.min(full.left + full.width, view.width + margin)
          const bottom = Math.min(full.top + full.height, view.height + margin)
          region = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
        }
        const pixelRatio = Math.min(dpr, Math.sqrt(MAX_PIXELS / (region.width * region.height)))
        const viewport = page.getViewport({ scale: cssScale * pixelRatio })
        task.current?.cancel()
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.ceil(region.width * pixelRatio)
        offscreen.height = Math.ceil(region.height * pixelRatio)
        const dx = (full.left - region.left) * pixelRatio
        const dy = (full.top - region.top) * pixelRatio
        const t = page.render({ canvas: offscreen, viewport, transform: [1, 0, 0, 1, dx, dy] })
        task.current = t
        await t.promise
        // Swap in only when finished, so the old rendering shows meanwhile.
        el.width = offscreen.width
        el.height = offscreen.height
        el.getContext('2d')!.drawImage(offscreen, 0, 0)
        el.dataset.renderScale = String(Math.round(cssScale * pixelRatio * 1000) / 1000)
        setRendered({ region, cam })
        setError(null)
      } catch (err) {
        if ((err as Error).name !== 'RenderingCancelledException') setError((err as Error).message)
      }
    }, rendered ? SETTLE_MS : 0)
    return () => clearTimeout(timer)
  }, [notebookId, background.asset, background.page, background.width, pageWidth, cam, view])

  useEffect(() => () => task.current?.cancel(), [])

  // Between renders, move and scale the last rendering with the camera.
  let style: React.CSSProperties = { display: 'none' }
  if (rendered) {
    const k = cam.scale / rendered.cam.scale
    const left = cam.x + (rendered.region.left - rendered.cam.x) * k
    const top = cam.y + (rendered.region.top - rendered.cam.y) * k
    style = { left, top, width: rendered.region.width * k, height: rendered.region.height * k }
  }

  return (
    <>
      <canvas ref={canvas} data-testid="pdf-layer" className="pointer-events-none absolute" style={style} aria-hidden />
      {error && (
        <div className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 rounded-lg bg-white px-3 py-2 text-[12.5px] text-[#c93a3f] shadow-float">
          Could not display this PDF page: {error}
        </div>
      )}
    </>
  )
})
