/**
 * Ghost Whiteboard: the webcam, faint and grey, behind a translucent board.
 *
 * - Reuses the stream the tracker already has (the camera panel's <video>
 *   srcObject): no second camera request, no extra decoding work for
 *   tracking, no extra inference. If that stream stops, this layer goes blank
 *   and the board becomes opaque again.
 * - Positioned every animation frame so the camera's writing region covers
 *   the board exactly (canvas/ghost.ts): the hand appears under the cursor.
 *   Only DOM styles change, and only when the geometry does.
 * - Display only. Nothing is recorded, stored, uploaded or exported.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { WispController } from '../core/wispController'
import { boardOpacity, ghostVideoBox } from '../canvas/ghost'

interface Props {
  ctl: WispController
  /** The tracking video (camera panel); its stream is shared, never re-opened. */
  source: RefObject<HTMLVideoElement | null>
  visibility: number
  mirror: boolean
}

const liveStream = (v: HTMLVideoElement | null): MediaStream | null => {
  const s = v?.srcObject
  if (!s || typeof (s as MediaStream).getVideoTracks !== 'function') return null
  return (s as MediaStream).getVideoTracks().some((t) => t.readyState === 'live') ? (s as MediaStream) : null
}

export function GhostLayer({ ctl, source, visibility, mirror }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const live = useRef(false)
  const vis = useRef(visibility)
  const mir = useRef(mirror)
  vis.current = visibility
  mir.current = mirror

  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      const v = ref.current
      const stream = liveStream(source.current)
      if (v && v.srcObject !== stream) {
        v.srcObject = stream
        if (stream) v.play().catch(() => {})
      }
      const isLive = stream !== null
      live.current = isLive
      // Every frame: cheap (the renderer ignores unchanged values) and robust to the
      // renderer being created after this layer (React runs child effects first).
      ctl.setBoard(boardOpacity(vis.current, isLive), true)
      if (v) {
        const cam = ctl.webcamInput
        const fit = ctl.pageFit
        const box = fit && cam ? ghostVideoBox(fit, cam.overlay.region, cam.overlay.mirror) : null
        // Until tracking has produced a writing region, simply cover the stage.
        const style = box
          ? `left:${box.left.toFixed(1)}px;top:${box.top.toFixed(1)}px;width:${box.width.toFixed(1)}px;height:${box.height.toFixed(1)}px;object-fit:fill;transform:${box.mirror ? 'scaleX(-1)' : 'none'};`
          : `left:0;top:0;width:100%;height:100%;object-fit:cover;transform:${mir.current ? 'scaleX(-1)' : 'none'};`
        const full = `${style}visibility:${isLive ? 'visible' : 'hidden'};`
        if (full !== last) {
          v.style.cssText = full
          last = full
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      if (ref.current) ref.current.srcObject = null
      live.current = false
      ctl.setBoard(1, false)
    }
  }, [ctl, source])

  return (
    <div className="ghost-layer" aria-hidden>
      <video ref={ref} muted playsInline />
    </div>
  )
}
