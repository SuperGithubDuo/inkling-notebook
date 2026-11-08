/**
 * MediaPipe Tasks Vision Hand Landmarker wrapper (@mediapipe/tasks-vision,
 * the maintained API; not the legacy @mediapipe/hands solution).
 *
 * - The library is loaded with a dynamic import, so mouse mode never pays for it.
 * - WASM is served from this app (copied by scripts/copy-wasm.mjs).
 * - The model is read from ./models/hand_landmarker.task when present
 *   (scripts/fetch-model.mjs), otherwise downloaded once from Google's model
 *   storage and kept in the browser's Cache Storage for offline use.
 * - GPU delegate first, CPU fallback.
 *
 * Nothing here touches React, the canvas or the stroke engine.
 */
import type { HandLandmarker } from '@mediapipe/tasks-vision'
import type { Landmark } from './landmarks'

export const REMOTE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

export type TrackerErrorCode = 'wasm' | 'model' | 'init'

export class TrackerError extends Error {
  constructor(
    readonly code: TrackerErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface HandResult {
  /** 21 landmarks in camera space, or null when no hand was found. */
  landmarks: Landmark[] | null
  /** Handedness score of the detected hand, 0–1. */
  confidence: number
  handedness: string | null
  inferenceMs: number
}

export interface TrackerOptions {
  wasmBase: string
  localModelUrl: string
  remoteModelUrl: string
  preferGpu: boolean
}

export function defaultTrackerOptions(): TrackerOptions {
  return {
    wasmBase: new URL('./mediapipe/wasm', document.baseURI).href,
    localModelUrl: new URL('./models/hand_landmarker.task', document.baseURI).href,
    remoteModelUrl: REMOTE_MODEL_URL,
    preferGpu: true
  }
}

const CACHE_NAME = 'wisp-models-v1'

/** A real .task file is a several-MB zip; reject HTML fallbacks and truncated files. */
function looksLikeModel(res: Response, bytes: ArrayBuffer): boolean {
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('text/html')) return false
  if (bytes.byteLength < 1_000_000) return false
  // .task files are zip archives; the local-file signature "PK\x03\x04" sits near the start
  // (the official model has two padding bytes before it).
  const head = new Uint8Array(bytes, 0, Math.min(64, bytes.byteLength))
  for (let i = 0; i + 3 < head.length; i++) {
    if (head[i] === 0x50 && head[i + 1] === 0x4b && head[i + 2] === 0x03 && head[i + 3] === 0x04) return true
  }
  return false
}

async function loadModel(opts: TrackerOptions): Promise<{ bytes: Uint8Array; from: 'local' | 'cache' | 'remote' }> {
  try {
    const res = await fetch(opts.localModelUrl, { cache: 'no-cache' })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      if (looksLikeModel(res, buf)) return { bytes: new Uint8Array(buf), from: 'local' }
    }
  } catch {
    /* fall through */
  }
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME).catch(() => null) : null
  const cached = await cache?.match(opts.remoteModelUrl)
  if (cached) {
    const buf = await cached.arrayBuffer()
    if (looksLikeModel(cached, buf)) return { bytes: new Uint8Array(buf), from: 'cache' }
  }
  let res: Response
  try {
    res = await fetch(opts.remoteModelUrl)
  } catch {
    throw new TrackerError(
      'model',
      'Could not download the hand-tracking model. Check your internet connection once, or run `npm run fetch-model` in packages/wisp to install it locally.'
    )
  }
  if (!res.ok) throw new TrackerError('model', `The hand-tracking model download failed (HTTP ${res.status}).`)
  const buf = await res.arrayBuffer()
  if (!looksLikeModel(res, buf)) throw new TrackerError('model', 'The downloaded hand-tracking model is not valid.')
  await cache?.put(opts.remoteModelUrl, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {})
  return { bytes: new Uint8Array(buf), from: 'remote' }
}

export class HandTracker {
  private closed = false
  private lastTs = 0

  private constructor(
    private readonly landmarker: HandLandmarker,
    readonly delegate: 'GPU' | 'CPU',
    readonly modelSource: 'local' | 'cache' | 'remote'
  ) {}

  static async create(options: Partial<TrackerOptions> = {}): Promise<HandTracker> {
    const opts = { ...defaultTrackerOptions(), ...options }
    let vision: typeof import('@mediapipe/tasks-vision')
    let fileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>>
    try {
      vision = await import('@mediapipe/tasks-vision')
      fileset = await vision.FilesetResolver.forVisionTasks(opts.wasmBase)
    } catch (err) {
      console.error('[wisp] MediaPipe runtime failed to load', err)
      throw new TrackerError('wasm', 'The hand-tracking runtime could not be loaded. Run `npm install` in packages/wisp and restart the dev server.')
    }
    const model = await loadModel(opts)

    const make = (delegate: 'GPU' | 'CPU'): Promise<HandLandmarker> =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model.bytes, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      })

    if (opts.preferGpu) {
      try {
        return new HandTracker(await make('GPU'), 'GPU', model.from)
      } catch (err) {
        console.warn('[wisp] GPU delegate unavailable, using CPU', err)
      }
    }
    try {
      return new HandTracker(await make('CPU'), 'CPU', model.from)
    } catch (err) {
      console.error('[wisp] Hand Landmarker init failed', err)
      throw new TrackerError('init', 'Hand tracking could not start on this device.')
    }
  }

  /** Runs inference on the current video frame. Timestamps must increase. */
  detect(video: HTMLVideoElement, tMs: number): HandResult {
    if (this.closed) return { landmarks: null, confidence: 0, handedness: null, inferenceMs: 0 }
    const ts = Math.max(tMs, this.lastTs + 0.001)
    this.lastTs = ts
    const t0 = performance.now()
    const res = this.landmarker.detectForVideo(video, ts)
    const inferenceMs = performance.now() - t0
    const lm = res.landmarks[0]
    if (!lm || lm.length < 21) return { landmarks: null, confidence: 0, handedness: null, inferenceMs }
    const cat = res.handedness?.[0]?.[0]
    return {
      landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
      confidence: cat?.score ?? 1,
      handedness: cat?.categoryName ?? null,
      inferenceMs
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.landmarker.close()
    } catch {
      /* already released */
    }
  }
}
