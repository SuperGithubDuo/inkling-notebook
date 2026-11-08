import { Hand, MousePointer2, X } from 'lucide-react'

const KEY = 'wisp.onboarding.v1'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* ignore */
  }
}

/* Simple line illustrations, one per step. */
const art = {
  frame: (
    <svg viewBox="0 0 64 48" aria-hidden>
      <rect x="4" y="4" width="56" height="40" rx="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
      <path d="M28 40V22a3 3 0 0 1 6 0v8m0-4a3 3 0 0 1 6 0v6m0-3a3 3 0 0 1 5 1v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  point: (
    <svg viewBox="0 0 64 48" aria-hidden>
      <path d="M26 44V18a3 3 0 0 1 6 0v12m0-4a3 3 0 0 1 6 0v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="29" cy="9" r="5" fill="none" stroke="#2f6be4" strokeWidth="2" />
      <circle cx="29" cy="9" r="1.5" fill="#2f6be4" />
    </svg>
  ),
  pinch: (
    <svg viewBox="0 0 64 48" aria-hidden>
      <path d="M18 42c0-12 6-18 14-22m0 0c4-2 8-1 9 2M24 30c4-6 10-9 15-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="41" cy="21" r="3.5" fill="#2f6be4" />
      <path d="M46 14c4 1 8 6 12 2" fill="none" stroke="#2f6be4" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ),
  release: (
    <svg viewBox="0 0 64 48" aria-hidden>
      <path d="M18 42c0-12 6-18 14-24m-8 12c3-6 6-8 10-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M36 12l6-6M38 22l8-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="50" cy="10" r="4" fill="none" stroke="#2f6be4" strokeWidth="2" />
    </svg>
  )
}

const STEPS = [
  { art: art.frame, title: 'Show your hand', text: 'Sit about an arm’s length from the camera and hold one hand up inside the dashed area.' },
  { art: art.point, title: 'Your fingers are the pen', text: 'The cursor sits between your thumb and index fingertips, where you’d hold a pen.' },
  { art: art.pinch, title: 'Pinch to write', text: 'Touch thumb and index together and move: the pen draws.' },
  { art: art.release, title: 'Release to lift', text: 'Open your fingers a little to lift the pen between letters and words.' }
]

export function Onboarding(props: { onWebcam(): void; onMouse(): void; onClose(): void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="onb-title">
        <button className="icon close" onClick={props.onClose} aria-label="Close">
          <X size={16} />
        </button>
        <p className="eyebrow">Inkling lab</p>
        <h1 id="onb-title">Write in the air with WISP</h1>
        <p className="lead">WISP turns your laptop webcam into a pen. No stylus, no touchscreen: just your hand.</p>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <div className="step-art">{s.art}</div>
              <div>
                <h3>
                  <span className="step-n">{i + 1}</span>
                  {s.title}
                </h3>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="privacy">Video is processed locally in your browser. Nothing is recorded or uploaded.</p>
        <div className="row end">
          <button className="btn ghost" onClick={props.onMouse}>
            <MousePointer2 size={15} /> Try with the mouse
          </button>
          <button className="btn primary" onClick={props.onWebcam}>
            <Hand size={15} /> Turn on camera
          </button>
        </div>
      </div>
    </div>
  )
}
