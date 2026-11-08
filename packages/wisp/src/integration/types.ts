/**
 * Public integration surface of WISP. A host app (later: Inkling's notebook
 * canvas) depends only on these types, never on WISP's internals, and WISP
 * never depends on the host's state.
 *
 * All positions are page-normalized: x, y ∈ [0, 1], origin top-left, y down,
 * relative to the page the host gives WISP (see strokes/types.ts). The host
 * maps them to its own coordinates (e.g. × page width/height).
 */
import type { GestureState } from '../gestures/gestureState'
import type { InputSource, NormPoint, Stroke, StrokePoint } from '../strokes/types'

export interface StrokeStartEvent {
  stroke: Readonly<Stroke>
}

export interface StrokeUpdateEvent {
  stroke: Readonly<Stroke>
  /** Points appended since the previous update (for incremental drawing). */
  added: readonly StrokePoint[]
}

export interface StrokeEndEvent {
  stroke: Readonly<Stroke>
  reason: 'released' | 'lost' | 'discontinuity' | 'source-changed' | 'stopped'
}

export interface CursorEvent extends NormPoint {
  t: number
  /** True while the pen is down. */
  down: boolean
  source: InputSource
}

export interface TrackingLostEvent {
  t: number
  /** True when an active stroke was ended because of it. */
  endedStroke: boolean
}

export interface GestureChangeEvent {
  from: GestureState
  to: GestureState
  t: number
}

export interface WispEventMap {
  strokeStart: StrokeStartEvent
  strokeUpdate: StrokeUpdateEvent
  strokeEnd: StrokeEndEvent
  cursor: CursorEvent
  cursorHidden: { t: number }
  trackingLost: TrackingLostEvent
  gestureChange: GestureChangeEvent
}

/** What a host subscribes to. Every `on*` returns an unsubscribe function. */
export interface WispInputEvents {
  onStrokeStart(fn: (e: StrokeStartEvent) => void): () => void
  onStrokeUpdate(fn: (e: StrokeUpdateEvent) => void): () => void
  onStrokeEnd(fn: (e: StrokeEndEvent) => void): () => void
  onTrackingLost(fn: (e: TrackingLostEvent) => void): () => void
  onGestureChange(fn: (e: GestureChangeEvent) => void): () => void
  onCursor(fn: (e: CursorEvent) => void): () => void
}

export type { GestureState, InputSource, NormPoint, Stroke, StrokePoint }
