import { useEffect, useRef, useState, type RefObject } from 'react'
import { Activity, Camera, CameraOff, Crosshair, MousePointer2 } from 'lucide-react'
import type { WispController } from '../core/wispController'
import type { WispSettings } from '../core/settings'
import type { CalibrationStep, WebcamDiagnostics, WebcamStatus } from '../input/webcamInput'
import { HAND_CONNECTIONS, LM } from '../tracking/landmarks'

/**
 * Records a landmark trace (21 hand points per frame, no images) for the
 * replay harness: `npm run replay -- wisp-trace-….json`.
 */
function TraceButton({ ctl, on, settings }: { ctl: WispController; on: boolean; settings: WispSettings }) {
  const [rec, setRec] = useState(false)
  const [frames, setFrames] = useState(0)
  const cam = ctl.webcamInput
  useEffect(() => {
    if (!rec) return
    const id = setInterval(() => {
      setFrames(cam?.recorder.length ?? 0)
      if (cam && !cam.recorder.recording) setRec(false)
    }, 250)
    return () => clearInterval(id)
  }, [rec, cam])
  if (!cam) return null
  const stop = () => {
    const trace = cam.recorder.stop(undefined, { ...settings, version: '0.1.3' })
    setRec(false)
    if (trace.frames.length === 0) return
    const blob = new Blob([JSON.stringify(trace)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wisp-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="trace">
      {rec ? (
        <button className="btn ghost sm" onClick={stop}>
          <span className="rec-dot" /> Stop &amp; save trace ({frames} frames)
        </button>
      ) : (
        <button className="btn ghost sm" disabled={!on} onClick={() => (cam.recorder.start(), setFrames(0), setRec(true))}>
          Record landmark trace
        </button>
      )}
      <p className="muted small">Saves hand-landmark positions and WISP’s per-frame measurements (pinch ratio, pen state, pen position) — never video — so your writing can be replayed and tuned offline.</p>
    </div>
  )
}

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  ctl: WispController
  mode: 'webcam' | 'mouse'
  status: WebcamStatus
  settings: WispSettings
  strokeCount: number
  pointCount: number
  onStart(): void
  onStop(): void
  onUseMouse(): void
  onSettings(p: Partial<WispSettings>): void
}

export function CameraPanel(p: Props) {
  const overlay = useRef<HTMLCanvasElement>(null)
  const [diag, setDiag] = useState<WebcamDiagnostics | null>(null)
  const [calib, setCalib] = useState<Extract<CalibrationStep, { corner: string }> | null>(null)
  const on = p.status.camera === 'on'
  const busy = p.status.camera === 'starting'
  const { mirror, showLandmarks, showPreview, showDiagnostics } = p.settings

  // Landmark / writing-area overlay: its own animation loop, only while the camera runs.
  useEffect(() => {
    const cam = p.ctl.webcamInput
    const canvas = overlay.current
    if (!on || !cam || !canvas || !showPreview) return
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const r = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(r.width * dpr)
      const h = Math.round(r.height * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, w, h)
      const o = cam.overlay
      // Writing area (view space).
      if (o.region) {
        const { x0, y0, x1, y1 } = o.region
        ctx.save()
        ctx.setLineDash([6 * dpr, 5 * dpr])
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'
        ctx.lineWidth = 1.5 * dpr
        ctx.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h)
        ctx.restore()
      }
      if (!showLandmarks || !o.landmarks) return
      const px = (i: number) => {
        const l = o.landmarks![i]!
        return [(o.mirror ? 1 - l.x : l.x) * w, l.y * h] as const
      }
      ctx.strokeStyle = 'rgba(109, 99, 240, 0.85)'
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      for (const [a, b] of HAND_CONNECTIONS) {
        const [ax, ay] = px(a)
        const [bx, by] = px(b)
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
      }
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      for (let i = 0; i < 21; i++) {
        const [x, y] = px(i)
        ctx.beginPath()
        ctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
      const writing = cam.diagnostics.gesture === 'writing'
      // The virtual pen point (view space, already mirrored).
      if (o.viewPoint) {
        ctx.beginPath()
        ctx.arc(o.viewPoint.x * w, o.viewPoint.y * h, 5 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = writing ? '#2f6be4' : 'rgba(47,107,228,0.25)'
        ctx.fill()
        ctx.lineWidth = 2 * dpr
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
      }
      for (const i of [LM.INDEX_TIP, LM.THUMB_TIP]) {
        const [x, y] = px(i)
        ctx.beginPath()
        ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.strokeStyle = '#2f6be4'
        ctx.lineWidth = 1.5 * dpr
        ctx.stroke()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [on, p.ctl, showLandmarks, showPreview])

  // Diagnostics: polled 4×/s, never pushed from the tracking loop.
  useEffect(() => {
    if (!showDiagnostics) return
    const id = setInterval(() => {
      const d = p.ctl.webcamInput?.diagnostics
      setDiag(d ? { ...d } : null)
    }, 250)
    return () => clearInterval(id)
  }, [showDiagnostics, p.ctl])

  // Orientation hint (v0.1.3): polled twice a second while the camera is on.
  const [quality, setQuality] = useState<WebcamDiagnostics['quality']>(null)
  useEffect(() => {
    if (!on) return void setQuality(null)
    const id = setInterval(() => setQuality(p.ctl.webcamInput?.diagnostics.quality ?? null), 500)
    return () => clearInterval(id)
  }, [on, p.ctl])

  useEffect(() => {
    const cam = p.ctl.webcamInput
    if (!cam) return
    return cam.events.on('calibration', (c) => {
      setCalib('corner' in c ? c : null)
      if (c.step === 'done') p.onSettings({ region: c.region })
    })
  }, [p.ctl, p.ctl.webcamInput, p.onSettings])

  const trackerText =
    p.status.tracker === 'ready'
      ? `Ready${p.status.delegate ? ` · ${p.status.delegate}` : ''}`
      : p.status.tracker === 'loading'
        ? 'Loading model…'
        : p.status.tracker === 'error'
          ? 'Unavailable'
          : 'Not loaded'
  const cameraError = p.status.camera === 'error' && p.status.tracker !== 'error'
  const cameraText = on ? 'On' : busy ? 'Starting…' : cameraError ? 'Unavailable' : 'Off'
  const handText = !on ? '—' : diag?.handDetected || (!showDiagnostics && p.ctl.webcamInput?.diagnostics.handDetected) ? 'Detected' : 'Not in view'

  return (
    <aside className="side">
      <section className="card camera">
        <div className="card-head">
          <h2>Camera</h2>
          {p.mode === 'webcam' && (on || busy) ? (
            <button className="btn ghost sm" onClick={p.onStop}>
              <CameraOff size={14} /> Turn off
            </button>
          ) : (
            <button className="btn primary sm" onClick={p.onStart} disabled={busy}>
              <Camera size={14} /> Turn on
            </button>
          )}
        </div>
        <div className={`preview ${showPreview ? '' : 'hidden'} ${on ? 'live' : ''}`}>
          {/* The video always stays in the DOM so tracking keeps running when the preview is hidden. */}
          <video ref={p.videoRef} className={mirror ? 'mirror' : ''} muted playsInline aria-label="Webcam preview" />
          <canvas ref={overlay} className="preview-overlay" />
          {!on && (
            <div className="preview-empty">
              {p.status.camera === 'error' ? <CameraOff size={22} /> : <Camera size={22} />}
              <span>{busy ? 'Starting camera…' : p.status.tracker === 'error' ? 'Hand tracking unavailable' : p.status.camera === 'error' ? 'Camera unavailable' : 'Camera is off'}</span>
            </div>
          )}
          {calib && (
            <div className="calib-banner">
              <Crosshair size={14} /> Step {calib.step} of 2: pinch at the <b>{calib.corner === 'top-left' ? 'top-left' : 'bottom-right'}</b> corner of your writing area
            </div>
          )}
        </div>
        {!showPreview && on && <p className="muted small">Preview hidden · tracking is still running.</p>}
        {on && quality === 'poor' && (
          <p className="muted small" role="status">
            Your fingers point almost straight at the camera, so the gap between them is hard to see. Pen-down and pen-up are less reliable — tilt your hand a little.
          </p>
        )}

        {p.status.camera === 'error' && p.status.error && (
          <div className="alert" role="alert">
            <p>{p.status.error}</p>
            <div className="row">
              <button className="btn ghost sm" onClick={p.onStart}>Try again</button>
              <button className="btn ghost sm" onClick={p.onUseMouse}>
                <MousePointer2 size={14} /> Use mouse
              </button>
            </div>
          </div>
        )}

        <dl className="chips">
          <div>
            <dt>Camera</dt>
            <dd className={on ? 'good' : cameraError ? 'bad' : ''}>{cameraText}</dd>
          </div>
          <div>
            <dt>Tracking</dt>
            <dd className={p.status.tracker === 'ready' ? 'good' : p.status.tracker === 'error' ? 'bad' : ''}>{trackerText}</dd>
          </div>
          <div>
            <dt>Hand</dt>
            <dd className={handText === 'Detected' ? 'good' : ''}>{handText}</dd>
          </div>
        </dl>

        {on && (
          <div className="calib-row">
            {calib ? (
              <button className="btn ghost sm" onClick={() => p.ctl.webcamInput?.cancelCalibration()}>Cancel</button>
            ) : (
              <button className="btn ghost sm" onClick={() => void p.ctl.webcamInput?.calibrate()} title="Pinch at two corners to choose where you write">
                <Crosshair size={14} /> Set writing area
              </button>
            )}
            {p.settings.region && !calib && (
              <button className="btn link sm" onClick={() => p.onSettings({ region: null })}>Reset to automatic</button>
            )}
          </div>
        )}
      </section>

      <section className="card tips">
        <h2>How to write</h2>
        <ol>
          <li>Keep your hand inside the dashed area.</li>
          <li>The pen is the point between your thumb and index fingertips.</li>
          <li>Pinch thumb + index to put the pen down.</li>
          <li>Open your fingers slightly to lift the pen.</li>
        </ol>
      </section>

      {showDiagnostics && (
        <section className="card diag">
          <h2>
            <Activity size={14} /> Diagnostics
          </h2>
          <dl>
            <dt>Tracking FPS</dt>
            <dd>{on && diag ? diag.fps : '—'}</dd>
            <dt>Inference</dt>
            <dd>{on && diag && diag.frames ? `${diag.inferenceMs.toFixed(1)} ms` : '—'}</dd>
            <dt>Hand</dt>
            <dd>{on && diag ? (diag.handDetected ? 'yes' : 'no') : '—'}</dd>
            <dt>Gesture</dt>
            <dd>{on && diag ? diag.gesture : '—'}</dd>
            <dt>Pinch ratio</dt>
            <dd>{on && diag?.pinchRatio != null ? diag.pinchRatio.toFixed(2) : '—'}</dd>
            <dt>Pinch baseline</dt>
            <dd>{on && diag?.pinchBaseline != null ? diag.pinchBaseline.toFixed(2) : '—'}</dd>
            <dt>Pinch noise</dt>
            <dd>{on && diag && diag.frames ? diag.pinchNoise.toFixed(3) : '—'}</dd>
            <dt>Frame interval</dt>
            <dd>{on && diag && diag.frameIntervalMs ? `${diag.frameIntervalMs.toFixed(1)} ms` : '—'}</dd>
            <dt>Capture → pen update</dt>
            <dd>{on && diag?.frameAgeMs != null ? `${diag.frameAgeMs.toFixed(1)} ms` : '—'}</dd>
            <dt>Skipped camera frames</dt>
            <dd>{on && diag ? diag.droppedFrames : '—'}</dd>
            <dt>Hand orientation</dt>
            <dd>{on && diag?.quality ? diag.quality : '—'}</dd>
            <dt>3D share of pinch</dt>
            <dd>{on && diag?.weight3D != null ? `${Math.round(diag.weight3D * 100)} %` : '—'}</dd>
            <dt>Delegate</dt>
            <dd>{p.status.delegate ?? '—'}</dd>
            <dt>Strokes / points</dt>
            <dd>
              {p.strokeCount} / {p.pointCount}
            </dd>
            <dt>Rejected spikes</dt>
            <dd>{p.ctl.engine.stats.rejected}</dd>
            <dt>Release-trimmed points</dt>
            <dd>{p.ctl.engine.stats.trimmed}</dd>
          </dl>
          <TraceButton ctl={p.ctl} on={on} settings={p.settings} />
        </section>
      )}
    </aside>
  )
}
