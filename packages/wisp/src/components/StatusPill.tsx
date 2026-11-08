import type { GestureState } from '../gestures/gestureState'
import type { WebcamStatus } from '../input/webcamInput'

interface Props {
  mode: 'webcam' | 'mouse'
  status: WebcamStatus
  gesture: GestureState
  writing: boolean
}

/** One short line telling the user what WISP is doing right now. */
export function StatusPill({ mode, status, gesture, writing }: Props) {
  let tone: 'idle' | 'ready' | 'writing' | 'warn' = 'idle'
  let text: string

  if (mode === 'mouse') {
    tone = writing ? 'writing' : 'ready'
    text = writing ? 'Writing' : 'Mouse mode · hold the left button to draw'
  } else if (status.camera === 'error') {
    tone = 'warn'
    text = 'Camera unavailable · see the camera panel'
  } else if (status.camera === 'off') {
    text = 'Camera is off'
  } else if (status.camera === 'starting' || status.tracker === 'loading') {
    text = status.tracker === 'loading' ? 'Loading hand tracking…' : 'Starting camera…'
  } else {
    switch (gesture) {
      case 'no-hand':
        text = 'Show your hand to the camera'
        break
      case 'hover':
        tone = 'ready'
        text = 'Pinch thumb and index finger to write'
        break
      case 'pinch-pending':
        tone = 'ready'
        text = 'Pinch detected…'
        break
      case 'writing':
        tone = 'writing'
        text = 'Writing · release the pinch to lift the pen'
        break
      case 'lost':
        tone = 'warn'
        text = 'Hand lost · bring it back into view'
        break
    }
  }

  return (
    <div className={`status-pill ${tone}`} role="status" aria-live="polite">
      <span className="dot" />
      {text}
    </div>
  )
}
