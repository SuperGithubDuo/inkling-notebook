import { Camera, CameraOff, Rows3 } from 'lucide-react'
import type { WebcamStatus } from '../input/webcamInput'
import { GHOST_MAX, GHOST_MIN } from '../canvas/ghost'

interface Props {
  status: WebcamStatus
  visibility: number
  guides: boolean
  onVisibility(v: number): void
  onGuides(v: boolean): void
  onCamera(on: boolean): void
}

/** Floating controls for Ghost Whiteboard: camera, webcam visibility, guides. */
export function GhostControls(p: Props) {
  const on = p.status.camera === 'on'
  const busy = p.status.camera === 'starting'
  const failed = p.status.camera === 'error'
  return (
    <div className="ghost-controls" role="toolbar" aria-label="Ghost Whiteboard">
      <button className={`btn sm ${on ? 'ghost' : 'primary'}`} disabled={busy} onClick={() => p.onCamera(!on)} title={on ? 'Turn the camera off (the whiteboard keeps working)' : 'Turn the camera on'}>
        {on ? <CameraOff size={14} /> : <Camera size={14} />} {busy ? 'Starting…' : on ? 'Camera off' : 'Camera on'}
      </button>
      <label className={`ghost-slider ${on ? '' : 'disabled'}`} title="How much of the webcam shows through the whiteboard">
        <span>Webcam</span>
        <input type="range" min={GHOST_MIN} max={GHOST_MAX} step={0.01} value={p.visibility} disabled={!on} onChange={(e) => p.onVisibility(Number(e.target.value))} aria-label="Webcam visibility" />
        <span className="value">{Math.round(p.visibility * 100)}%</span>
      </label>
      <button className={`btn sm ${p.guides ? 'on' : 'ghost'}`} onClick={() => p.onGuides(!p.guides)} aria-pressed={p.guides} title="Writing guides">
        <Rows3 size={14} /> Guides
      </button>
      {failed && <span className="ghost-note">Camera unavailable — the whiteboard still works with the mouse.</span>}
    </div>
  )
}
