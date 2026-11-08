# WISP — Writing Interface via Spatial Perception

WISP lets you write in the air with your finger, using an ordinary laptop webcam. Pinch your thumb and index finger together to put the pen down, move, and open your fingers to lift it. Strokes are captured as structured vector data, ready to become an input mode inside Inkling Notebook.

This is **v0.1.1**: a standalone, independently runnable prototype that lives inside the Inkling repository but has no dependency on Inkling's app code, and Inkling has none on it.

## Goals

- Give students without a touchscreen or stylus a natural way to handwrite notes, maths and sketches.
- Reliable stroke capture first: smooth, low-latency ink with clean stroke boundaries. Handwriting recognition comes later.
- Everything runs locally in the browser. No backend, account, paid API or cloud inference. Camera frames are never recorded, stored or uploaded.

## What works (v0.1.1)

| Area | Implemented |
|---|---|
| Tracking | Webcam permission and preview, MediaPipe Tasks Vision Hand Landmarker (21 landmarks, one hand), GPU delegate with CPU fallback, one inference per new video frame, mirroring, landmark overlay, tracker status (loading / ready / unavailable) |
| Pen point | Virtual pen between the thumb and index fingertips (default), or the index fingertip |
| Gestures | Asymmetric pinch detection: careful pen-down (waits for the closing fingers to settle), fast pen-up (relative to your own pinch, velocity-aware, noise-adaptive), release-tail trimming, re-arm protection against flicker, no writing when a hand enters already pinched, short-dropout tolerance |
| Ink | One continuous One Euro filter for cursor and ink, jitter stabilizer, zero-lag refinement of each finished stroke, pen-down seeding (no start hooks), spike rejection and stroke splitting on confirmed jumps, distance-based resampling, raw positions kept beside smoothed ones, perfect-freehand rendering (same ink library as Inkling) |
| Mapping | Page-normalized coordinates, automatic writing region that keeps circles round, writing sensitivity, optional two-pinch calibration, letterboxed page that keeps geometry on resize |
| Editing | Pen colour and thickness, undo/redo, clear (undoable), JSON export/import with validation, PNG export |
| Mouse mode | Mouse drives the same engine as the webcam (left button = pinch) for development and testing without a camera |
| UI | Toolbar, camera panel with status, settings, onboarding, status pill, optional developer diagnostics (tracking FPS, inference time, gesture state, pinch ratio/baseline/noise, trimmed points) and a landmark-trace recorder |
| Evaluation | Landmark replay harness (`npm run replay`): synthetic acceptance scenarios with ground truth, and recorded traces from your own webcam |
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
| `npm run replay` | Replay harness: synthetic scenarios A–F (`--noise 2.5` for a noisier camera, `--compare smoothing=0.3,0.5,0.8`), or a recorded trace (`npm run replay -- trace.json`) |

Camera access requires a secure origin; `localhost` counts, so `dev` and `preview` both work.

## Using WISP

**Webcam mode.** Click *Turn on* in the camera panel (or *Turn on camera* in the welcome dialog) and allow camera access.

1. Sit about an arm's length away and raise one hand inside the dashed rectangle in the preview.
2. The hollow blue cursor sits between your thumb and index fingertips, where you'd hold a pen (the blue dot in the camera preview).
3. Pinch thumb and index finger together: the cursor fills in and the pen draws.
4. Open your fingers slightly to lift the pen. A small opening is enough.

Tips: good front lighting helps more than anything else. Keep your palm roughly facing the camera. If you have to stretch to reach the page edges, raise *Writing sensitivity*. If the pen goes down too easily or not easily enough, adjust *Pen-down sensitivity*; if strokes break while you write, lower *Pen-up sensitivity*, and if the pen is slow to lift, raise it. *Set writing area* lets you pinch at two corners to choose where in the camera view you write.

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
  replay/       trace.ts (landmark traces, recorder) · synth.ts (synthetic hands + noise model) · scenarios.ts (tests A–F) · replay.ts (pipeline replay + metrics)
  components/   React UI
scripts/        replay.ts (npm run replay) · fetch-model.mjs · copy-wasm.mjs
tests/          Vitest suites for all pure logic, including replay-harness regressions
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

1. **Pinch ratio.** Thumb-tip to index-tip distance divided by palm size (mean side of the wrist / index-MCP / pinky-MCP triangle), in frame-width units so x and y count equally on 16:9 video. The ratio is the same near or far from the camera.
2. **Signal.** The ratio is lightly smoothed (EMA, α = 0.6) and its two-frame opening velocity is tracked. The unsmoothed ratio is also kept, for the decisions that must not wait.
3. **State machine** (`gestures/gestureState.ts`): `no-hand → hover → pinch-pending → writing → hover`, plus `lost`. It is designed around the whole cycle, and it is asymmetric: careful when putting the pen down, fast when lifting it.

**Pen down (careful).**
- The smoothed ratio must be below **0.30** for **2 frames**.
- Ink starts only once the fingers have stopped closing. The unsmoothed closing speed must be under **2.0 ratio/s**, or the pen goes down anyway after **5 frames**. Any frame already at the settled pinch level also counts.
- While the fingers close, the pen point moves with them. Drawing during that motion is what makes a start hook.

**Pen up (fast, no debounce).** The pen lifts on the **first** frame that meets any of these:
- The smoothed ratio rises **0.08** above your own pinched **baseline** (the running mean of your ratio while writing). v0.1 waited for an absolute 0.45. If your fingers rest at 0.15 when pinched, that meant opening 0.30 palm-widths before the pen lifted.
- The unsmoothed ratio rises **0.12** above the baseline: a big, fast opening, caught without waiting for smoothing.
- The ratio opens faster than **2.0 ratio/s** after rising at least **0.06**.
- The ratio crosses **0.42**: an absolute backstop.

**Tail trimming.** When the pen lifts, the ink drawn while the fingers were already opening is removed. That is the final run of frames whose ratio was both rising and above the baseline, up to **200 ms** back. The fingers' own movement during release never becomes a tail.

**Noise adaptation.**
- WISP measures how noisy your pinch ratio is while you write, from frame-to-frame differences, and keeps that measurement across strokes.
- It also tracks how uncertain the baseline still is, early in a stroke.
- The release thresholds rise only as far as needed to stay **4σ** above that noise. A clean camera keeps the fast, small-opening release; a noisy one doesn't break strokes.

**Anti-flicker.** After a release, the pen can only go down again once the ratio has fallen **0.10** below its peak since the release. Noise around the release point can't toggle the pen.

**Accidents.**
- A hand that enters the frame already pinched never writes until it has been seen open.
- A hand must be visible for 3 frames before a pinch counts.
- If the hand disappears mid-stroke, the stroke survives a 160 ms dropout; after that it ends.


## Smoothing and accuracy

The virtual pen point is the **midpoint of the thumb and index fingertips** (`input/handFrameProcessor.ts`).
- **While pinched, it is the contact point.** The tips touch, so their midpoint is where the fingers meet, like holding a pen.
- **It is steadier than either tip alone.** The two tips' independent jitter partly cancels out.
- **It barely moves while the pinch closes.** When both fingers close toward each other, the midpoint stays put; the index tip alone would travel the whole gap.
- **One filter on the midpoint, not two on the tips.** Filtering each tip and then averaging would be nearly the same for a fixed filter. But One Euro adapts to speed: while the fingers close, each tip moves fast and its filter would loosen exactly when it should stay tight.

Pipeline per sample (`strokes/strokeEngine.ts`):

```
raw pen point ─► outlier gate ─► One Euro filter ─► stabilizer ─► cursor
                                                              └─► live ink (pen down) ─► distance resampling
pen-up:  raw samples of the stroke ─► trim release tail ─► zero-phase refinement ─► resampling ─► final stroke
```

- **One continuous filter for cursor and ink.** Pen-down and pen-up don't reset it. It restarts only when tracking is lost or a jump is confirmed.
- **Pen-down seeding.** The stroke starts where the pen really is: the average raw position of the last 110 ms if you were holding still, otherwise the latest raw position. It does not start where the filter still lags behind the movement that brought you there, so there is no start hook and no jump.
- **One Euro filter.** Its smoothing loosens with speed: strong when you write slowly (where shake shows), light when you move fast (where lag shows). *Stroke smoothing* maps to its parameters (see the table below).
- **Stabilizer** ("lazy pen", webcam only). The ink only moves when the filtered point is more than a small radius away (default 1.6 px on the page), so leftover micro-tremor never reaches the ink. Any larger movement does, so small details survive.
- **Zero-phase refinement at pen-up.** A real-time filter must lag, which cuts tight curves (loops, superscripts) and ends strokes short. Once a stroke is finished, WISP re-smooths it forward and then backward in time, so the two lags cancel. Both ends are reflection-padded so endpoints stay put. The live stroke may shift by a few pixels at pen-up as it settles into the refined shape.
- **Outlier gate** (webcam only). A single-frame tracking spike is dropped. If two samples agree on a far-away position, the stroke is split instead of drawing a connecting line.
- **Resampling** stores a point only when it is at least 0.15% of the page width (2.4 px) from the last one.
- **Raw positions** are kept on every point (`raw`), so filtering can be evaluated offline.

Mouse input skips the gate, the stabilizer and the refinement (it has no tracking noise), but uses the same filter, seeding, strokes, undo and export.

### What caused the shakiness in v0.1

| Cause | Fix |
|---|---|
| The pen was the **index fingertip**, MediaPipe's noisiest point, and it travels the whole pinch gap while the fingers close or open | Midpoint of thumb and index tips |
| The filter's speed estimate (dCutoff 1 Hz) let **tracking noise register as speed**, which opened the filter and let the noise through | dCutoff 0.7 Hz |
| A **separate stroke filter was reset at every pen-down**, so every stroke started with unfiltered raw points, and the first point jumped away from the smoothed cursor | One continuous filter, plus pen-down seeding |
| **No stage for sub-pixel tremor** that survives the filter | Stabilizer |
| A low speed coefficient (beta 0.012) left fast small details in the filter's attenuation band; turning smoothing up only shrank loops and superscripts | beta 0.04, plus zero-phase refinement |

Rendering wasn't a cause: perfect-freehand draws the points it is given. Coordinate mapping scales jitter (a smaller writing area means more page movement per pixel of camera noise) but doesn't create it.

### Parameter reference (v0.1.1)

| Parameter | Setting / location | v0.1 | v0.1.1 | Why |
|---|---|---|---|---|
| Pen point | *Pen tip* | index tip | thumb–index midpoint | Contact point; steadier; no closing hook |
| One Euro minCutoff at 50% | *Stroke smoothing* | 1.6 Hz | 1.1 Hz (3 Hz → 0.4 Hz over the slider) | Steadier slow writing |
| One Euro beta at 50% | *Stroke smoothing* | 0.012 | 0.04 (0.06 → 0.02) | Fast small details stay sharp; largest single gain in the sweep |
| One Euro dCutoff | `smoothing.ts` | 1 Hz | 0.7 Hz | Noise isn't mistaken for speed |
| Stabilizer radius | *Jitter stabilizer* 40% | — | 1.6 px (max 6.4 px) | Removes residual tremor |
| Refinement | *Refine each stroke…* | — | on | Recovers curves and ends without live lag |
| Min point spacing | `strokeEngine.ts` | 1.9 px | 2.4 px | Fewer redundant points |
| Pen-down threshold | *Pen-down sensitivity* | 0.30, 2 frames | 0.30, 2 frames + settled | No start hooks |
| Pen-up | *Pen-up sensitivity* | absolute 0.45, 2-frame debounce | +0.08 relative, raw +0.12, velocity 2.0/s after +0.06, backstop 0.42; first frame | Lifts at the start of opening |
| Release tail | `gestureState.ts` | frames after the threshold dropped | rising frames trimmed back to onset (≤ 200 ms) | No tails |
| Noise margin | `gestureState.ts` | — | 4σ of measured ratio noise | Fast on clean cameras, robust on noisy ones |
| Re-arm | `gestureState.ts` | hysteresis 0.30/0.45 | must fall 0.10 below the post-release peak | No flicker |

Settings saved by v0.1 are migrated once: display options and the calibrated area are kept, and tuning values reset to the new defaults (they were tuned against the old behaviour).

### How the defaults were chosen

`npm run replay` runs synthetic landmark traces through the real pipeline. Each trace has a known intended stroke, and the scenarios mirror the acceptance tests:
- A: a slow line
- B: "Hello"
- C: x² + 3x − 5 = 0
- D: rapid and slow release
- F: repeated strokes

The noise is a **model** (white plus slowly correlated jitter on the fingertips and the whole hand, at roughly webcam magnitudes), not a measurement. The defaults came from sweeping parameters on that model at 1× and 2.5× noise.

v0.1 vs v0.1.1 on identical inputs, 1× modelled noise, mean of 5 seeds, px on the 1600-px page:

| Scenario | Shape error | Release tail | Stray ink | Missing ink | Strokes |
|---|---|---|---|---|---|
| A slow line | 7.0 → 5.4 | 33 → 2 | 190 → 85 | 142 → 81 | 1/1 → 1/1 |
| B "Hello" | 7.1 → 4.3 | 115 → 3 | 304 → 109 | 194 → 95 | 7/7 → 7/7 |
| C maths | 9.0 → 5.5 | 306 → 11 | 406 → 174 | 260 → 229 | 14/14 → 14/14 |
| D slow release | 20.9 → 4.2 | 69 → 3 | 81 → 6 | 18 → 3 | 1/1 → 1/1 |
| F repeated strokes | 5.2 → 4.3 | 0 → 22 | 167 → 66 | 187 → 83 | 6/6 → 6/6 |

At 2.5× noise the gains are smaller:
- Stray ink and tails are still lower.
- Missing ink is similar to v0.1.
- A stroke occasionally splits in two (on average 1.2 strokes for the slow line), where v0.1 instead drew long tails.

At 4× noise, strokes break more often. If that happens with your camera, lower *Pen-up sensitivity*. None of this proves real-webcam quality; recorded traces from your own camera are the real test (see Testing).


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

- **Events** (`integration/types.ts`): `onStrokeStart`, `onStrokeUpdate` (with just the newly added points, for incremental drawing), `onStrokeEnd`, `onTrackingLost`, `onGestureChange`, `onCursor`, each returning an unsubscribe function. `StrokeEngine` implements this interface. The stroke in `onStrokeEnd` is **final and authoritative**: it may differ from the points streamed through `onStrokeUpdate`, because the release tail is trimmed and the stroke is refined at pen-up. A host should draw the live points provisionally and replace them with the final stroke.
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

`npm test` runs 128 unit tests. They cover:
- **Gestures:** pinch thresholds and asymmetry; pen-down settling (no start hooks); pen-up cases (rapid release, slow release, small openings, fast openings, noisy measurements that must not lift the pen, re-pinch after release); tail trimming; lost tracking.
- **Ink:** the midpoint pen point and mirroring; the continuous filter and pen-down seeding; the stabilizer; zero-phase refinement; smoothing, outlier rejection and coordinates.
- **Editing and data:** undo/redo; serialization round-trips and invalid input; the stroke-format compatibility check; settings migration; the Inkling adapter.
- **Replay-harness regressions:** acceptance scenarios A–F must keep exact stroke counts, small tails, sub-pixel wobble on a slow line, and legible small symbols.

These tests show the logic is correct on modelled input. They say nothing about real-world accuracy, latency or comfort.

**Recording your own traces.**
1. Turn on *Developer diagnostics* and click *Record landmark trace* in the camera panel.
2. Write, then click *Stop & save trace*. This saves a JSON file of hand-landmark positions only, never video.
3. Replay it under different settings: `npm run replay -- wisp-trace-….json --compare releaseSensitivity=0.7,1,1.4` (also `smoothing`, `stabilizer`, `pinchSensitivity`, `penPoint`). Every run sees the identical hand motion.

**Needs manual testing with a real webcam and hand:**
- Pen-up and pen-down feel across hand sizes, distances and lighting, and whether 0.08 is a comfortable release opening
- Shake and lag while writing letters, digits and maths
- The settle-at-pen-up shift from refinement: is it pleasant or distracting?
- Accidental strokes while repositioning the hand
- Tracking loss at frame edges and with partially hidden fingers
- Frame rate and inference time on typical student laptops
- Firefox and Safari


## Known limitations

- **Defaults are tuned on modelled noise.** Real MediaPipe noise (especially depth noise in the pinch ratio) may differ. Recorded traces from real cameras should drive the next round of tuning.
- **The finished stroke settles slightly at pen-up.** Refinement moves the live stroke into its refined shape, usually by a few pixels near the end. It can be turned off in Settings.
- **Very noisy tracking can still split a stroke.** Under very poor tracking (modelled at 2.5–4× noise), a long stroke can occasionally break. Lower *Pen-up sensitivity* if this happens.
- **Pen-up confirmation takes a frame or two.** A small opening held still is confirmed after 1–3 frames, because the smoothed ratio must catch up. The ink is trimmed back to the onset, so it doesn't leave a tail, but the pen lifts visibly a moment later.
- **Starts can lose a frame of ink.** If you start moving at the very instant your fingers touch, the first frame of the stroke can be lost.
- **Inference runs on the main thread.** On slow machines each frame can block the UI noticeably (in a headless VM with software WebGL, inference took hundreds of milliseconds per frame). Moving tracking into a Web Worker is planned.
- One hand only; strokes have uniform width (no pressure).
- Point timestamps use the recording session's `performance.now()` clock, so they are relative within a file, not absolute times.
- The calibrated writing area is stored in view space; changing *Mirror camera* afterwards mirrors the area.
- No eraser tool yet (undo and clear only).
- Settings are stored in `localStorage` (settings only, never camera data).


## Planned improvements

See [ROADMAP.md](./ROADMAP.md).
