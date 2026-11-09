/** Ghost Whiteboard: webcam/board alignment, opacity and settings. */
import { describe, expect, it } from 'vitest'
import { GHOST_DEFAULT, boardOpacity, ghostVideoBox, viewToScreen } from '../src/canvas/ghost'
import { cameraToPage, fitPage, pageToScreen, type WritingRegion } from '../src/strokes/coordinates'
import { effectiveRegion } from '../src/input/handFrameProcessor'
import { REPLAY_PROCESSOR } from '../src/replay/replay'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings'

const regions: Array<[string, WritingRegion]> = [
  ['hand-fitted default', effectiveRegion({ ...REPLAY_PROCESSOR, regionFit: 'hand' }, 16 / 9, undefined, 1, true)],
  ['calibrated (aspect-true)', effectiveRegion({ ...REPLAY_PROCESSOR, region: { x0: 0.2, y0: 0.3, x1: 0.85, y1: 0.7 } }, 16 / 9, undefined, 1, true)],
  ['Large writing size', effectiveRegion({ ...REPLAY_PROCESSOR, regionFit: 'hand', writingSensitivity: 1.25 }, 16 / 9, undefined, 1, true)],
  ['Writing Assist zoomed in', effectiveRegion({ ...REPLAY_PROCESSOR, regionFit: 'hand', keepScale: true }, 16 / 9, undefined, 1.3, true)]
]
const screens: Array<[number, number]> = [
  [1280, 720],
  [1920, 1080],
  [900, 1200]
]

describe('the webcam behind the board lines up with cursor and ink', () => {
  for (const [name, region] of regions)
    for (const mirror of [true, false])
      for (const [w, h] of screens) {
        it(`${name}, mirror ${mirror}, ${w}×${h}: a hand anywhere on the board (edges and corners included) is drawn under its ink`, () => {
          const fit = fitPage(w, h, 1600, 1000, 28)
          const box = ghostVideoBox(fit, region, mirror)!
          for (const u of [0, 0.25, 0.5, 0.75, 1])
            for (const v of [0, 0.3, 1]) {
              // A point of the VIEW (what the user sees) inside the writing region…
              const view = { x: region.x0 + u * (region.x1 - region.x0), y: region.y0 + v * (region.y1 - region.y0) }
              // …is where the engine puts the ink (camera space is unmirrored)…
              const cam = { x: mirror ? 1 - view.x : view.x, y: view.y }
              const ink = pageToScreen(cameraToPage(cam, { mirror, region })!, fit)
              // …and where the ghost layer shows that part of the camera image.
              const shown = viewToScreen(box, view)
              expect(shown.x).toBeCloseTo(ink.x, 6)
              expect(shown.y).toBeCloseTo(ink.y, 6)
            }
          // The image is not stretched: the box keeps the video's aspect ratio.
          expect(box.width / box.height).toBeCloseTo(16 / 9, 4)
          expect(box.mirror).toBe(mirror)
        })
      }
  it('no region yet (tracking not started) or a degenerate one → no box (the layer falls back to covering the stage)', () => {
    const fit = fitPage(1000, 800, 1600, 1000)
    expect(ghostVideoBox(fit, null, true)).toBeNull()
    expect(ghostVideoBox(fit, { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.6 }, true)).toBeNull()
  })
})

describe('board opacity', () => {
  it('defaults: 12 % webcam → 88 % opaque board', () => {
    expect(GHOST_DEFAULT).toBe(0.12)
    expect(boardOpacity(0.12, true)).toBeCloseTo(0.88, 9)
  })
  it('the slider moves opacity both ways and is clamped to 3–50 % webcam', () => {
    expect(boardOpacity(0.3, true)).toBeCloseTo(0.7, 9)
    expect(boardOpacity(0, true)).toBeCloseTo(0.97, 9)
    expect(boardOpacity(5, true)).toBeCloseTo(0.5, 9)
    expect(boardOpacity(Number.NaN, true)).toBeCloseTo(0.88, 9)
  })
  it('no live camera (off, denied, stopped) → a normal opaque whiteboard', () => {
    expect(boardOpacity(0.4, false)).toBe(1)
  })
})

describe('Ghost Whiteboard settings', () => {
  it('default to the standard view, 12 % visibility; sanitized', () => {
    expect(DEFAULT_SETTINGS.viewMode).toBe('standard')
    expect(sanitizeSettings({ viewMode: 'ghost', ghostVisibility: 0.9 })).toMatchObject({ viewMode: 'ghost', ghostVisibility: 0.5 })
    expect(sanitizeSettings({ viewMode: 'glass' }).viewMode).toBe('standard')
    expect(sanitizeSettings({}).ghostVisibility).toBe(0.12)
  })
})
