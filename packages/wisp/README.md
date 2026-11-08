# WISP — Writing Interface via Spatial Perception

WISP lets you write in the air with your finger, using an ordinary laptop webcam. Pinch your thumb and index finger together to put the pen down, move, and open your fingers to lift it. Strokes are captured as structured vector data, ready to become an input mode inside Inkling Notebook.

This is **v0.1**: a standalone, independently runnable prototype that lives inside the Inkling repository but has no dependency on Inkling's app code, and Inkling has none on it.

## Goals

- Give students without a touchscreen or stylus a natural way to handwrite notes, maths and sketches.
- Reliable stroke capture first: smooth, low-latency ink with clean stroke boundaries. Handwriting recognition comes later.
- Everything runs locally in the browser. No backend, account, paid API or cloud inference. Camera frames are never recorded, stored or uploaded.

## What works in v0.1

| Area | Implemented |
|---|---|
| Tracking | Webcam permission and preview, MediaPipe Tasks Vision Hand Landmarker (21 landmarks, one hand), GPU delegate with CPU fallback, one inference per new video frame, mirroring, landmark overlay, tracker status (loading / ready / unavailable) |
| Gestures | Scale-invariant pinch detection with hysteresis, debounced pinch/release, no writing when a hand enters already pinched, minimum hand-stable frames, short-dropout tolerance, stroke ended on tracking loss |
| Ink | One Euro smoothing (adjustable), single-frame spike rejection, stroke splitting on confirmed jumps (no connecting lines), distance-based resampling, raw positions kept beside smoothed ones, Catmull-Rom + perfect-freehand rendering (same ink library as Inkling) |
| Mapping | Page-normalized coordinates, automatic writing region that keeps circles round, writing sensitivity, optional two-pinch calibration, letterboxed page that keeps geometry on resize |
| Editing | Pen colour and thickness, undo/redo, clear (undoable), JSON export/import with validation, PNG export |
| Mouse mode | Mouse drives the same engine as the webcam (left button = pinch) for development and testing without a camera |
| UI | Toolbar, camera panel with status, settings, onboarding, status pill, optional developer diagnostics (tracking FPS, inference time, gesture state, pinch ratio, points) |
| Integration surface | Typed `onStrokeStart / onStrokeUpdate / onStrokeEnd / onTrackingLost / onGestureChange / onCursor`, each returning an unsubscribe function; a pure WISP → Inkling `createStroke` adapter sketch (not wired in) |

## Setup

Requirements: Node.js 22.13+ (same as Inkling) and a Chromium-based browser, Firefox or Safari.

```bash
cd packages/wisp
npm install
npm run fetch-model   # optional, recommended: downloads the hand model (~7.8 MB) once for offline use
npm run dev           # http://localhost:5191
```

WISP has its own `package.json` and lockfile, like `beta-server/`. Installing it does not touch Inkling's dependencies, and Inkling's `npm install`, typecheck, tests, build and installers do not include it.

The MediaPipe WASM runtime is copied from `node_modules` into `public/mediapipe/` automatically before `dev` and `build`. The model is read from `public/models/hand_landmarker.task` if you ran `fetch-model`. Otherwise WISP downloads it from Google's model storage the first time you turn the camera on and keeps it in the browser's Cache Storage, so later sessions work offline.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | Strict TypeScript, no emit |
| `npm run fetch-model` | Download the Hand Landmarker model into `public/models/` |

Camera access requires a secure origin; `localhost` counts, so `dev` and `preview` both work.

## Using WISP

**Webcam mode.** Click *Turn on* in the camera panel (or *Turn on camera* in the welcome dialog) and allow camera access.

1. Sit about an arm's length away and raise one hand inside the dashed rectangle in the preview.
2. Your index fingertip moves the hollow blue cursor.
3. Pinch thumb and index finger together: the cursor fills in and the pen draws.
4. Open your fingers to lift the pen.

Tips: good front lighting helps more than anything else. Keep your palm roughly facing the camera. If you have to stretch to reach the page edges, raise *Writing sensitivity*; if the pen goes down too easily or not easily enough, adjust *Pinch sensitivity*. *Set writing area* lets you pinch at two corners to choose where in the camera view you write.

**Mouse mode.** Switch to *Mouse* in the toolbar. Hold the left button to draw. Everything else (smoothing, undo, export) behaves exactly as with the webcam.

**Shortcuts.** `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` or `Ctrl/⌘+Y` redo, `Esc` closes settings or cancels calibration.

## Architecture

```
src/
  tracking/     camera.ts (getUserMedia + errors) · handTracker.ts (MediaPipe wrapper) · landmarks.ts (pure geometry)
  gestures/     pinchDetector.ts (hysteresis) · gestureState.ts (state machine)
  strokes/      types.ts (data model) · coordinates.ts · smoothing.ts · strokeEngine.ts · documentStore.ts (undo/redo) · serialization.ts
  input/        handFrameProcessor.ts (landmarks → engine, pure) · webcamInput.ts (camera + tracker + loop) · mouseInput.ts
  canvas/       renderer.ts (Canvas 2D, two layers)
  core/         wispController.ts (wiring) · settings.ts · emitter.ts
  integration/  types.ts (public events) · inklingAdapter.ts (sketch, not wired)
  components/   React UI
tests/          Vitest suites for all pure logic
```

Data flow:

```
            ┌──────────── WebcamInput ─────────────┐
 camera ──► │ HandTracker ─► HandFrameProcessor ──┐│
            └─────────────────────────────────────┼┘
 mouse ───► MouseInput ───────────────────────────┤
                                                  ▼
                                StrokeEngine (filter, gate, resample, events)
                                     │                         │
                         strokeStart/Update/End          cursor events
                                     ▼                         ▼
                      DocumentStore (undo/redo)  ──►  CanvasRenderer ◄── React UI (settings, status)
```

Key boundaries:

- **MediaPipe is isolated** in `tracking/handTracker.ts` and loaded with a dynamic import, so mouse mode never downloads it (it's a separate ~150 kB chunk plus WASM).
- **Gesture logic and smoothing are pure TypeScript**: no DOM, no MediaPipe. They're driven by synthetic landmarks in tests.
- **One engine for every input.** Webcam and mouse both call `StrokeEngine.input(sample, down)`. There is no second drawing path.
- **Inference is separate from rendering and React.** The tracking loop runs on `requestVideoFrameCallback` (one inference per new camera frame; `requestAnimationFrame` + `currentTime` check as fallback). Strokes reach the canvas through engine events; the canvas redraws on the next animation frame only when something changed. React only hears low-frequency events (gesture state, stroke start/end) and polls diagnostics 4×/s.
- **Editing is separate from rendering.** `DocumentStore` holds the document and an operation history; the renderer just draws whatever document it's given.

## How gesture detection works

1. **Pinch ratio.** Thumb-tip to index-tip distance divided by palm size (mean side of the wrist / index-MCP / pinky-MCP triangle). Distances are measured in frame-width units so x and y count equally on 16:9 video. The ratio is the same near or far from the camera, and palm landmarks barely move when fingers bend.
2. **Hysteresis.** Pinched below 0.30, released above 0.45 (both scaled by *Pinch sensitivity*). Noise between the two thresholds can't toggle the pen.
3. **State machine** (`gestures/gestureState.ts`): `no-hand → hover → pinch-pending → writing → release-pending → hover`, plus `lost`.
   - A pinch must hold for 2 frames to start writing; frames seen while pending are buffered and then drawn, so the stroke still starts at the first pinched frame (no lost ink).
   - A release must hold for 2 frames; the frames where the fingers were already separating are dropped, which removes the small "hook" at stroke ends.
   - A pinch only counts after the hand has been visible for 3 frames *and* has been seen open. A hand that enters the frame already pinched (e.g. repositioning) never draws.
   - If the hand disappears while writing, the stroke survives a 160 ms dropout; after that it ends. Low-confidence detections count as missing.

## Smoothing and accuracy

Pipeline per sample: **outlier gate → One Euro filter → distance resampler**.

- **One Euro filter** (Casiez et al. 2012) is a low-pass filter whose cutoff rises with speed: strong smoothing when you write slowly (where jitter shows) and little smoothing on fast strokes (where lag shows). An exponential moving average has a fixed cutoff, so it's either jittery or laggy; a Kalman filter needs a motion model and per-camera tuning. *Stroke smoothing* maps 0–1 to a minimum cutoff from 6 Hz down to 0.45 Hz (0 turns filtering off).
- **Outlier gate.** A jump faster than 5 page-widths/s (or larger than 18% of the page in one step) is held back. If the next sample is back near the stroke, the spike is dropped. If two consecutive samples agree on the new place, it's a real relocation: the stroke is split instead of drawing a long connecting line.
- **Resampling** stores a point only when it is ≥ 0.12% of the page width from the last one (the final point is always kept).
- **Interpolation** (Catmull-Rom) happens only at render time, so stored points remain a faithful record.
- Every stored point keeps `raw` (the unsmoothed mapped position) next to the smoothed `x, y`, so filtering can be evaluated and tuned offline.

## Coordinates

| Space | Definition |
|---|---|
| Camera | MediaPipe normalized image coordinates, [0,1], origin top-left, as the camera sees it |
| View | Camera space after optional mirroring (x → 1 − x); writing regions are defined here |
| **Page** | **[0,1]² over the page, origin top-left, y down. The only space strokes are stored in.** |
| Screen | CSS pixels; the page is letterboxed into the canvas |

The page has a fixed logical size (default 1600 × 1000). Pen width is stored in logical page pixels. The default writing region is centred in the camera view, covers 70% of it in its limiting dimension and has the page's aspect ratio *in camera pixels*, so a circle drawn in the air stays a circle on the page.

## Stroke data format

```jsonc
{
  "format": "wisp.strokes",
  "version": 1,
  "id": "doc_…",
  "createdAt": 1762560000000,       // epoch ms
  "updatedAt": 1762560123000,
  "canvas": { "width": 1600, "height": 1000, "background": "#ffffff" },
  "strokes": [
    {
      "id": "stroke_…",
      "color": "#1f2430",
      "width": 4,                    // logical page px
      "source": "webcam",            // webcam | mouse | import
      "startedAt": 18234.5,          // performance.now() ms of the recording session
      "endedAt": 19011.2,
      "points": [
        { "x": 0.412, "y": 0.288, "t": 18234.5, "confidence": 0.97, "raw": { "x": 0.4131, "y": 0.2874 } }
      ]
    }
  ]
}
```

Import validates every field and never throws: an invalid file shows a readable message (for example "strokes[3].points[0].x must be between 0 and 1"), and the current page is untouched. Import is undoable.

## Future Inkling integration

The plan is an optional **WISP Mode** on a notebook page: the user turns on the camera and writes, and WISP's strokes become ordinary Inkling ink.

What already exists for that:

- **Events** (`integration/types.ts`): `onStrokeStart`, `onStrokeUpdate` (with just the newly added points, for incremental drawing), `onStrokeEnd`, `onTrackingLost`, `onGestureChange`, `onCursor`, each returning an unsubscribe function. `StrokeEngine` implements this interface.
- **Coordinates**: everything is page-normalized, so the host decides where the WISP page lands on its own page.
- **Adapter sketch** (`integration/inklingAdapter.ts`): converts a completed WISP stroke into the shape of Inkling's `createStroke` command (points `[x, y]` in page coordinates, `tool: 'pen'`, `hasPressure: false`, width scaled). It mirrors Inkling's types locally so WISP imports nothing from Inkling.

How it would connect without rewriting the notebook:

1. Inkling's renderer would depend on `packages/wisp` (a workspace dependency or a path alias), importing only `StrokeEngine`, `WebcamInput` and the integration types.
2. A small `WispMode` component on the page canvas would create the engine and webcam input, and map normalized points to the visible page rectangle (Inkling's viewport/camera transform).
3. While writing, `onStrokeUpdate` would draw onto Inkling's existing in-progress layer, the same imperative layer the pen tool uses, so React doesn't re-render.
4. On `onStrokeEnd`, the adapter's command would go through `useStore.getState().run([cmd], { label: 'WISP stroke' })`. That gives validation, undo/redo, auto-save and AI-Tutor visibility for free, exactly like a pen stroke.
5. Camera permission in Electron would need a `setPermissionRequestHandler` that allows `media` for the app's own origin only. That's a main-process change and needs review on its own.

Nothing in Inkling has been changed for this yet.

## Testing

`npm test` runs 84 unit tests covering pinch thresholds and hysteresis, gesture state transitions, lost tracking, stroke creation and completion, smoothing, coordinate mapping, outlier rejection, undo/redo, serialization round-trips, invalid input, settings sanitising, the Inkling adapter, and the webcam path end to end with synthetic landmarks (no camera).

These tests show the logic is correct. They say nothing about real-world accuracy, latency or comfort.

**Needs manual testing with a real webcam and hand:**

- Pinch thresholds and debounce timings across hand sizes, skin tones, distances and lighting
- Smoothing defaults: readability of letters, digits and maths symbols vs perceived lag
- Accidental-stroke suppression while repositioning the hand
- Tracking loss at frame edges and with partially hidden fingers
- Calibration usability
- Frame rate and inference time on typical student laptops (integrated GPUs, CPU fallback)
- Behaviour on Firefox and Safari (`requestVideoFrameCallback` fallback, WebGL delegate)
- Camera unplugged while running

## Known limitations

- Inference runs on the main thread. On slow machines each frame can block the UI noticeably (in a headless VM with software WebGL, inference took hundreds of milliseconds per frame). Moving tracking into a Web Worker is planned for v0.2.
- One hand only; left- and right-handed use is not distinguished.
- No pressure or speed-based line width; strokes have uniform width.
- The pinch closure itself moves the index fingertip slightly, which can still leave a small mark at stroke starts. The experimental *Between thumb and index* pen tip reduces this; it needs real-world evaluation.
- Point timestamps use the recording session's `performance.now()` clock, so they are relative within a file, not absolute times.
- The calibrated writing region is stored in view space; changing *Mirror camera* afterwards mirrors the region.
- No eraser tool yet (undo and clear only).
- Settings are stored in `localStorage` (settings only, never camera data).

## Planned improvements

See [ROADMAP.md](./ROADMAP.md).
