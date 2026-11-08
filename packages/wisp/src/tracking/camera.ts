/**
 * Webcam access. Frames stay in the browser: the stream is attached to a
 * <video> element for local processing only, never recorded or uploaded.
 */

export type CameraErrorCode =
  | 'unsupported'
  | 'insecure'
  | 'permission-denied'
  | 'not-found'
  | 'in-use'
  | 'overconstrained'
  | 'disconnected'
  | 'aborted'
  | 'unknown'

export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message = describeCameraError(code)
  ) {
    super(message)
  }
}

export function describeCameraError(code: CameraErrorCode): string {
  switch (code) {
    case 'unsupported':
      return 'This browser cannot access a camera. Try a recent Chrome, Edge, Firefox or Safari, or use mouse mode.'
    case 'insecure':
      return 'Camera access needs a secure page (https or localhost). Open WISP through `npm run dev` or `npm run preview`.'
    case 'permission-denied':
      return 'Camera permission was denied. Allow camera access for this page in your browser’s site settings, then try again. Mouse mode works without a camera.'
    case 'not-found':
      return 'No webcam was found. Connect a camera and try again, or use mouse mode.'
    case 'in-use':
      return 'The webcam is busy or could not start. Close other apps that use the camera (video calls, Photo Booth, OBS) and try again.'
    case 'overconstrained':
      return 'The webcam does not support the requested video settings.'
    case 'disconnected':
      return 'The webcam was disconnected. Reconnect it and turn the camera on again.'
    case 'aborted':
      return 'Camera start was cancelled.'
    default:
      return 'The webcam could not be started.'
  }
}

export function cameraErrorFrom(err: unknown): CameraError {
  if (err instanceof CameraError) return err
  const name = (err as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('permission-denied')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('not-found')
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError('in-use')
    case 'OverconstrainedError':
      return new CameraError('overconstrained')
    case 'AbortError':
      return new CameraError('aborted')
    default:
      return new CameraError('unknown')
  }
}

export interface CameraHandle {
  readonly stream: MediaStream
  readonly width: number
  readonly height: number
  readonly aspect: number
  /** Fires once if the camera stops on its own (unplugged, revoked). */
  onEnded(fn: () => void): void
  stop(): void
}

export async function openCamera(video: HTMLVideoElement, signal?: AbortSignal): Promise<CameraHandle> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) throw new CameraError('insecure')
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported')

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        // Hand landmarking downsamples internally; 960×540 is plenty and keeps CPU low.
        width: { ideal: 960 },
        height: { ideal: 540 },
        frameRate: { ideal: 30, max: 60 }
      }
    })
  } catch (err) {
    // Some cameras reject the ideal constraints; retry with defaults.
    if ((err as { name?: string })?.name === 'OverconstrainedError') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      } catch (err2) {
        throw cameraErrorFrom(err2)
      }
    } else {
      throw cameraErrorFrom(err)
    }
  }

  const stopTracks = (): void => stream.getTracks().forEach((t) => t.stop())
  if (signal?.aborted) {
    stopTracks()
    throw new CameraError('aborted')
  }

  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  try {
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) return resolve()
      const ok = (): void => {
        cleanup()
        resolve()
      }
      const bad = (): void => {
        cleanup()
        reject(new CameraError('in-use'))
      }
      const cleanup = (): void => {
        video.removeEventListener('loadedmetadata', ok)
        video.removeEventListener('error', bad)
      }
      video.addEventListener('loadedmetadata', ok)
      video.addEventListener('error', bad)
    })
    await video.play()
  } catch (err) {
    stopTracks()
    video.srcObject = null
    throw cameraErrorFrom(err)
  }
  if (signal?.aborted) {
    stopTracks()
    video.srcObject = null
    throw new CameraError('aborted')
  }

  const width = video.videoWidth || 640
  const height = video.videoHeight || 480
  const endedFns: Array<() => void> = []
  let stopped = false
  const track = stream.getVideoTracks()[0]
  const onTrackEnded = (): void => {
    if (stopped) return
    endedFns.forEach((fn) => fn())
  }
  track?.addEventListener('ended', onTrackEnded)

  return {
    stream,
    width,
    height,
    aspect: width / height,
    onEnded: (fn) => endedFns.push(fn),
    stop: () => {
      if (stopped) return
      stopped = true
      track?.removeEventListener('ended', onTrackEnded)
      stopTracks()
      video.pause()
      video.srcObject = null
    }
  }
}
