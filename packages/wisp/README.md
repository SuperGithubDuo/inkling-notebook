# WISP — Writing Interface via Spatial Perception

WISP lets you write in the air with your finger, using an ordinary laptop webcam. Pinch your thumb and index finger together to put the pen down, move, and open your fingers to lift it. Strokes are captured as structured vector data, ready to become an input mode inside Inkling Notebook.

This is **v0.1.5**: a standalone, independently runnable prototype that lives inside the Inkling repository but has no dependency on Inkling's app code, and Inkling has none on it.

## Goals

- Give students without a touchscreen or stylus a natural way to handwrite notes, maths and sketches.
- Reliable stroke capture first: smooth, low-latency ink with clean stroke boundaries. Handwriting recognition comes later.
- Everything runs locally in the browser. No backend, account, paid API or cloud inference. Camera frames are never recorded, stored or uploaded.

## What works (v0.1.5)

| Area | Implemented |
|---|---|
| Tracking | Webcam permission and preview, MediaPipe Tasks Vision Hand Landmarker (21 landmarks, one hand), GPU delegate with CPU fallback, one inference per new video frame, mirroring, landmark overlay, tracker status (loading / ready / unavailable) |
| Pen point | Virtual pen between the thumb and index fingertips (default), or the index fingertip |
| Gestures | Orientation-aware pinch measurement (2D image ratio blended with a 3D ratio from MediaPipe world landmarks as the hand turns), tracking-quality indicator, early pen-up feedback (live ink pauses at the first sign of opening), glitch-resistant release; asymmetric pinch detection: deliberate pen-down (a real closing motion that has settled), fast pen-up (relative to your own pinch, velocity-aware, noise-adaptive), release-onset trimming by a hinge fit, re-arm protection against flicker, no writing when a hand enters already pinched or fingers merely drift close, tolerance of one-frame tracking gaps |
| Stroke protection (v0.1.5) | Continuity guard between gestures and ink: never connects ink across tracking glitches, misplaced fingertips, re-detections, hand swaps or tracking gaps; time-aware, palm-width-scaled tests (kinematics, pen-relative-to-palm shape, palm size, orientation, handedness); suspicious frames are held one frame, then dropped, released as legitimate fast movement, or the stroke is split / ink suspended. Zero added latency on ordinary frames |
| Ink | One continuous noise-gated One Euro filter for cursor and live ink, noise-scaled stabilizer, noise-matched zero-lag refinement of each finished stroke (glitch removal + Whittaker smoother), pen-down seeding, spike rejection and stroke splitting on confirmed jumps, distance-based resampling, raw positions kept beside smoothed ones, perfect-freehand rendering (same ink library as Inkling) |
| Mapping | Page-normalized coordinates; automatic writing region fitted to your hand so every page edge and corner is reachable with your palm in view (locked for the session); mapping frozen from pinch start to pen-up, setting changes applied at the next pen-up (v0.1.5); writing size Small / Medium / Large / Custom; optional two-pinch calibration that keeps the page's aspect ratio (equal x and y gain, v0.1.5); letterboxed page that keeps geometry on resize |
| Writing Assist (optional) | Steady writing size when you lean in or back (distance-compensated writing plane from MediaPipe's 3D landmarks); toggleable baseline, x-height, uppercase and line-spacing guides with adjustable line spacing (v0.1.5); *Tidy lines* straightens slightly tilted lines as rigid wholes and is fully reversible (*Restore original*, undo) |
| Editing | Pen colour and thickness, undo/redo, clear (undoable), JSON export/import with validation, PNG export |
| Mouse mode | Mouse drives the same engine as the webcam (left button = pinch) for development and testing without a camera |
| UI | Toolbar, camera panel with status, settings, onboarding, status pill, optional developer diagnostics (tracking FPS, inference time, frame interval, capture→pen-update latency, skipped frames, hand orientation quality, 3D share of the pinch, gesture state, pinch ratio/baseline/noise, trimmed points) Smart Ink counters (glitch frames dropped, fast frames released, gaps bridged, strokes split, ink suspended, tracking residual), a v0.1.4-pipeline switch for live A/B testing, and a trace recorder (landmarks + handedness + per-frame measurements and guard verdicts + pen events + *Mark glitch* labels + strokes, never video) |
| Evaluation | A/B harness (`npm run ab`, v0.1.5): v0.1.4 vs v0.1.5 on identical traces — 12 required scenarios, a calibration case and 6 adversarial traces, or your recorded traces; wisp-motion research tooling (`npm run motion`). Replay harness (`npm run replay`): 32 synthetic scenarios from a projected 3D hand model (writing, speed, gestures, gentle lifts, 9 hand orientations and distances) with ground truth under two noise profiles, pen-down/pen-up delay, live tail and live jitter metrics, recorded traces from your own webcam, side-by-side setting comparisons, and an HTML page that draws the strokes |
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
| `npm run ab` | A/B (v0.1.5): v0.1.4 vs v0.1.5 Smart Ink on identical synthetic traces (`--seeds 6`, `--json`, `--html ab.html`), or on recorded traces (`npm run ab -- trace.json --html ab.html`) |
| `npm run motion` | wisp-motion research CLI: `validate`, `manifest`, `split`, `features`, `baseline`, `synth` (see `src/wisp-motion/README.md`) |
| `npm run layout` | Layout harness (v0.1.4): letter-size consistency, baseline, tilt, notation geometry and edge reach for each mapping on physical-writing scenes (`--seeds 6`, `--profile model`, `--json`) |
| `npm run replay` | Replay harness: 13 synthetic scenarios (`--profile webcam|model`, `--noise 1.5`, `--fps 20`, `--compare smoothing=0.3,0.5,0.8`, `--html out.html` to draw the strokes, `--json`), or a recorded trace (`npm run replay -- trace.json --compare releaseSensitivity=0.8,1,1.2 --html out.html`) |

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
  strokes/      types.ts (data model) · coordinates.ts · writingPlane.ts (hand-fitted region, steady scale) · continuity.ts (v0.1.5 stroke protection) · layout.ts (guides, Tidy lines) · smoothing.ts · strokeEngine.ts · documentStore.ts (undo/redo) · serialization.ts
  input/        handFrameProcessor.ts (landmarks → engine, pure) · webcamInput.ts (camera + tracker + loop) · mouseInput.ts
  canvas/       renderer.ts (Canvas 2D, two layers)
  core/         wispController.ts (wiring) · settings.ts · emitter.ts
  integration/  types.ts (public events) · inklingAdapter.ts (sketch, not wired)
  replay/       trace.ts (landmark traces, recorder) · hand3d.ts (3D hand + camera) · synth.ts (synthetic hands + noise model) · scenarios.ts · replay.ts (pipeline replay + metrics) · font.ts · layout.ts · layoutScenes.ts · boundary.ts (v0.1.4 layout harness) · ab.ts (v0.1.5 A/B scenarios + metrics)
  wisp-motion/  research only, not used by the app: labels · features · dataset (validation, manifests, group splits) · baselines · synthetic faults · README (protocol + model proposal)
  components/   React UI
scripts/        replay.ts (npm run replay) · layout.ts (npm run layout) · ab.ts (npm run ab) · motion.ts (npm run motion) · fetch-model.mjs · copy-wasm.mjs
tests/          Vitest suites for all pure logic, including replay-harness regressions
```

Data flow:

```
            ┌──────────── WebcamInput ─────────────┐
 camera ──► │ HandTracker ─► HandFrameProcessor ──┐│
            └─────────────────────────────────────┼┘
 mouse ───► MouseInput ───────────────────────────┤
                                    ContinuityGuard (webcam ink only, v0.1.5)
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

## v0.1.5: Smart Ink — stroke integrity and steady mapping

**Every measurement in this section comes from synthetic traces** (modelled hand, modelled MediaPipe noise, deliberately corrupted landmarks). None is a real-webcam measurement; no webcam traces reached this session. `npm run ab -- your-trace.json --html ab.html` compares both pipelines on your recordings.

Pen-down and pen-up behaviour is unchanged: `tests/gestureGolden.test.ts` still requires v0.1.2's exact decisions on 72 traces, and with Smart Ink on, the ink start and end times on those traces are identical too. `smartInk: false` (or *Developer diagnostics → v0.1.4 pipeline (A/B)*) replays **bit-identically** to the v0.1.4 commit: 444 replays compared point by point and cursor sample by cursor sample, and 64 of them are pinned in `tests/fixtures/pipeline-v014.json`.

### 1. Where the long accidental lines came from (reproduced, not assumed)

| Cause | Reproduction (v0.1.4) | Status |
|---|---|---|
| **Re-detection inside the 160 ms "lost" grace.** The gesture keeps a stroke alive while the hand is missing for up to 160 ms; when the hand reappears somewhere else, the engine connected the two positions. | Hand gone 133 ms, back 0.06–0.12 frame widths away: 89–166 px of connector ink | Fixed: gaps are bridged only when short and small or on the extrapolated path; otherwise the stroke is split |
| **Outlier gate blind to gaps.** Its speed test divided by the time since the last *accepted* sample, so after a gap it became *more* permissive. At 30 fps only single-frame jumps above ~0.17 page widths (~260 px) were ever suspicious. | — | Superseded by time-aware tests in palm widths |
| **Multi-frame fingertip misplacement** (occlusion). Each step stayed under the gate. | 3–6 frames, 0.1 frame widths: 144–307 px out-and-back excursions | Fixed: pen-relative-to-palm test; ink suspended until the pen trajectory is found again |
| **Re-detection arriving in two sub-threshold steps.** | 0.2 frame widths over 2 frames: 257 px | Fixed: no step faster than the fastest plausible writing (≈1.2 m/s) is ever connected |
| **Mapping change during the first stroke.** v0.1.4 locked the measured hand extent at the first writing frame, *after* that frame had been mapped with the prior extent: the region's height changed 0.690 → 0.599 mid-stroke. | First stroke within ~0.6 s of the hand appearing: 228 px jump | Fixed: the mapping is frozen from pinch start, and the extent estimate converges during hover so the lock changes nothing |
| **Hand swap** (tracker latches onto the other hand). v0.1.4's gate split the stroke and then inked the other hand. | 0.35 frame widths for 8 frames: a 29 px mark at the other hand | Fixed: physically impossible displacements and handedness / palm-size changes suspend ink until the pen is found again |
| Frame stalls (250 ms without frames) | No stray ink on a straight line (a straight bridge was a fair guess) | Now split unless the gap is short or on-path: no invented positions |
| Orientation changes, Writing Assist scale changes mid-stroke, pending-frame buffer | Not a source of jumps in replay: the scale was already frozen while writing; buffered frames used one mapping except in the first-stroke case above | Scale and mapping now frozen from pinch start (pinch-pending frames included) |

### 2. How stroke protection works (`strokes/continuity.ts`)

Each inked frame is compared with the last accepted one in view space, **measured in palm widths** (so thresholds mean the same at 30 or 70 cm and at any writing size) with **time-aware** tolerances:
- *kinematic*: residual from constant-velocity prediction ≤ noise floor + 0.6 × speed × dt + acceleration term (linear beyond one frame). The noise floor adapts to the measured residual (3.5 × its mean), so noisy cameras and hard orientations don't trigger it.
- *shape*: the pen's position relative to the palm may change ≤ 0.3 palm widths per frame + 1.5 per second (a misplaced fingertip moves the pen, not the palm).
- *identity*: palm size (≤ 0.2 log per frame), palm orientation (≤ 30° per frame), handedness.
- *speed*: nothing faster than 14 palm widths/s (≈1.2 m/s) is ever connected.

Outcomes: **normal** → inked immediately (no latency). **Suspicious** → held (ink pauses one frame); the next frame decides: back on the trajectory → the held frame was a glitch and is dropped; continuing smoothly → it was a legitimate fast move or sharp reversal and is released; settled at a new place → **confirmed jump**: the stroke ends where it was (nothing connects across) and ink resumes at the new place after 2 consistent frames if the hand could physically have got there, otherwise ink is **suspended** until the tracker is clearly back on the pen's path, or tracking has been steady for 6 frames with the same hand (palm size, handedness), or the pen lifts. **Gaps** are bridged only if ≤ 200 ms and either small (≤ 0.2 palm widths) or on the extrapolated path; otherwise split. At pen-up, ordinary held frames near the stroke end are kept, so quick strokes don't lose their last frame. Mouse input never goes through the guard.

### 3. Coordinate discontinuities

The page mapping (region, mirroring, pen point, Writing Assist gain) is captured when a pinch begins and used for every point of that stroke, including the frames buffered while the pinch settled; points are mapped when applied, not when observed. Changing calibration, writing size, mirroring, pen point or mode during a stroke takes effect at the next pen-up. A two-corner calibration is reduced to the largest page-shaped rectangle inside it: in v0.1.4 a comfortable, wide calibration stretched the page over a 3.6 : 1 area, so x and y had different gains — **a circle came out 2.26× taller than wide (now 1.01)**. This is a likely cause of "unusually tall letters" for anyone who calibrated.

### 4. Handwriting size: what was found, kept and rejected

- Natural Writing: size follows distance (22 % size spread across 37–56 cm, unchanged; physics). Writing Assist compensates (5 %).
- **Rejected after measurement — word-level gain hold.** Holding the Writing Assist gain until a pause and applying distance changes "between words" made size *less* consistent (size spread 4.7 → 10.1 %, baseline steps 4.9 → 16.6 px) because the distance estimate converges over ~0.5–1 s and got applied mid-word; deadband variants were no better even with 3× world-landmark noise. v0.1.4's smoothed, rate-limited following stays; the change kept is freezing it from pinch start.
- **Pipeline-induced variation (measured, not changed):** the drawn height of the same letter varies 82–107 % with speed and noise, mostly because short strokes lose their ends to the pen-down settle and pen-up trim (the "fast short strokes lose a third" concern). That timing is the gesture behaviour you asked to keep; fixing it needs your real traces.
- Air writing has no physical feedback, so natural size variation remains; the guides (now with adjustable line spacing) are the tool for that.

### 5. Alignment

Guides: baseline, x-height, uppercase height, line-spacing bands, now with a *Line spacing* slider (0.6–2×; letter guides keep following the writing size). Tidy lines (rigid, reversible line straightening) unchanged; it leaves the maths line untouched. **Rejected after measurement — per-word baseline evening:** moving whole words onto the line's baseline made a bobbing-arm scene worse (baseline spread 6.5 → 10.9–13.8 px): drift within words tilts them, and two noisy estimates don't beat leaving words as written.

### 6. A/B results (`npm run ab -- --seeds 6`, synthetic, mean per run, v0.1.4 → v0.1.5)

| | v0.1.4 | v0.1.5 |
|---|---|---|
| 12 required scenarios + calibration: stray ink (> 20 px from the intended path) | 99 px | 56 px |
| …stray lines ≥ 40 px | 0.83 | 0.33 |
| …legitimate ink missing | 2 968 px | 2 964 px |
| …strokes lost / short strokes lost | 0.67 / 6.0 | 0.67 / 6.0 |
| …letter size spread (words, lines, distances) | 6.1 / 5.9 / 5.1 % | 6.0 / 5.9 / 5.1 % |
| …baseline spread / line tilt | 2.1 px / 0.52° | 2.1 px / 0.52° |
| Circle in a wide calibrated area (height ÷ width) | 2.26 | 1.01 |
| Hand re-detected 0.05 frame widths away (S06): stray ink / end error | 81 px / 172 px | 38 px / 89 px |
| **6 adversarial traces: stray ink** | **2 285 px** | **510 px** (−78 %) |
| …stray lines ≥ 40 px | 14.2 | 3.3 (−76 %) |
| …injected faults that left a stray line | 12.2 of 28 | 3.3 of 28 |
| …legitimate ink missing | 3 390 px | 3 552 px (+5 %) |
| …strokes lost | 1.8 | 2.0 |
| Added delay before live ink | — | 0 ms in 11 of 12 normal scenarios (S06 +0.2 ms); +0–2.2 ms mean on adversarial traces |
| Pipeline time per frame (excl. hand tracking) | 0.005 ms | 0.007 ms |

All 12 required scenarios are identical between the pipelines except S06, the one designed to trigger a connector. Remaining v0.1.5 failures by fault type (≥ 40 px stray, 6 seeds): drop-out then re-detection at a wrong but reachable place 10/38 (v0.1.4 20/38) — indistinguishable from the hand really moving, so the stroke is split but the wrong place is inked; fingertip glitches 5/64 (18/64); whole-hand jumps 4/23 (12/23); palm-scale jumps 1/22 (16/22); hand swaps 0/21 (4/21). The cost: strokes are split at faults (more pieces), ~5 % more missing ink on corrupted traces, and one extra lost dash per ~4 adversarial dash runs.

### 7. WISP-Motion research foundation

`src/wisp-motion/` (not imported by the app): trace v4 recording (handedness, guard verdicts, *Mark glitch* labels, pseudonymous metadata, never video), validation, versioned manifests, participant-grouped splits with a leakage check, 25 per-frame features from tracker output only, Task A baselines, synthetic fault injection, and a TCN proposal with the data, labels and evaluation bar required before any model may touch the live pipeline. **No model was trained**: there is no real data or labels yet. See `src/wisp-motion/README.md`.

## v0.1.4: canvas edges, steady writing size, alignment

**All measurements below are from synthetic traces (a modelled hand, modelled noise, a modelled camera). None is a real-webcam measurement.** Your new traces did not reach this session; replay them with `npm run replay -- trace.json` when available.

Pen-down / pen-up behaviour is **exactly v0.1.2's** (the version you tested). v0.1.3's gesture experiments are kept but off by default, and `tests/gestureGolden.test.ts` checks that the defaults make the same pen-down and pen-up decisions, to 0.1 ms, as v0.1.2's code on 72 traces.

### 1. The canvas boundary bug

**Cause (main).** The pen is the thumb–index midpoint, but MediaPipe tracks the hand by its **palm**, and the wrist sits about a quarter of the frame height *below* the pen (hand at 45 cm). v0.1–v0.1.3 put the writing region in the middle of the camera view, covering 70 % of its height. To reach the bottom page edge, the pen had to go 85 % of the way down the frame, which pushed the wrist out of the picture, so tracking failed before the ink got there. The same happens near the side the palm extends to, and when the hand is close to the camera.

**Fix.** WISP now measures where your palm is relative to the pen during the first second of hovering (or at the first pen-down), then fits the writing region inside the area where the pen can go while the palm stays in view (3 % margin), with the page's aspect ratio. The region is then **locked** for the session, so the mapping never shifts while you write; *Fit to my hand* (camera panel) measures again. A two-corner calibration still overrides it.

**Smaller causes found and fixed:**
- Finished ink was clipped to the page's *rounded* corners (10 px radius), so ink in the corners disappeared. Ink is now clipped to the exact rectangle (corner radius 2 px), and the live stroke uses the same clip, so live and final ink look the same at the edges.
- The pen-up smoother could push a stroke drawn along an edge slightly off the page (e.g. y = 1.0007). An exported file then **failed to re-import** ("must be between 0 and 1"). Refined points are now kept on the page.

**Checked and found correct:** canvas backing-store size and device-pixel-ratio scaling, pointer → page transform (the margin around the page clamps to the edge), coordinate clamping (exact 0 and 1 are reachable), resizing (page aspect kept, round-trip exact). Mouse mode could already reach every edge.

| Edge reach (gap in page px; webcam noise, 6 runs) | top | bottom | left | right | corners | frames without tracking |
|---|---|---|---|---|---|---|
| v0.1.3 (centred region) | 0 | **108** | 0 | 0 | 2 / 4 | 207 |
| v0.1.4 | 0 | **0** | 0 | 0 | **4 / 4** | 5 |

In the browser (mouse, 1× and 2× pixel ratio, after resizing): strokes reach x and y = 0 and 1 exactly, ink is visible in all four corners and along all four edges.

### 2. Was an ML model needed? No.

| Approach | Verdict |
|---|---|
| A. MediaPipe image + 3D world landmarks | **Used.** World landmarks give the hand's shape and orientation (not its position). Comparing image palm size with world palm size gives a distance measurement that does not change when the hand turns (±2 % in the model; up to ~10 % with fingers pointing at the camera). |
| B. Learned landmarks → stable pen position | Not built. It would need recordings with ground-truth pen positions, which don't exist. An untrained model cannot be claimed to help. |
| C. Adaptive filtering / motion prediction | Already in place (One Euro + refinement). Prediction would cut lag but overshoots at corners; not needed for size or alignment. |
| D. Learned trajectory normalization | Not built: needs labelled handwriting. The deterministic plane (below) fixes the main cause of size changes (perspective) exactly. |
| E. Recognition-based normalization | Not built. It would reshape letters by guessing what they are, wrongly for maths, and needs a large model. Kept for the later recognition work. |

The two real causes of inconsistent size and alignment are geometric: perspective (closer hand = bigger letters) and a fixed mapping in the image. Both have exact, deterministic solutions.

### 3. Steady writing size (Writing Assist): the virtual writing plane

- Each frame (pen up only), WISP estimates the hand's image scale: the image spread of the palm divided by its 3D world spread, corrected from palm to pen depth. Seeing the hand from an angle shrinks both by the same factor, so the ratio depends only on distance.
- The scale is smoothed (0.5 s), rate-limited (≤ 60 %/s) and **frozen while the pen is down**, so a stroke is always drawn at one scale. It is held while the hand is turned more than 20° away from how it was held at the start: the measurement has a small orientation bias, and that bias would otherwise move the writing.
- The writing region is zoomed about the camera's optical centre by (current scale ÷ scale when the region was fitted). For a writing surface facing the camera this is the exact perspective correction. The same hand movement then gives the same page movement at any distance, and positions stay put, not only sizes.
- Needs world landmarks (MediaPipe provides them). Natural Writing doesn't use this.

**Writing size** (Settings → Writing): Small 0.8×, Medium 1×, Large 1.25×, or Custom 0.5–2×. This sets the gain between hand movement and page movement; finished strokes are never resized. Below Medium the page is bigger than the area your hand can reach in the camera, so its outer edges can't be reached (the settings say so).

### 4. Alignment: guides and Tidy lines

- **Guides** (toggleable): baselines, a dashed lowercase x-height line, an uppercase-height line, and line-spacing bands. Their spacing follows the writing size. They are an on-screen aid only: not exported, never move ink.
- **Tidy lines** (Writing Assist toolbar, manual):
  - Finds each line of writing. A new line starts with a carriage return or a stroke clear of the line's vertical band, so fractions, roots, integrals, superscripts and subscripts stay on their line.
  - Estimates the line's baseline robustly from stroke bottoms, dropping descenders, subscripts, superscripts and fraction parts.
  - Rotates the **whole line rigidly** about its start, and optionally moves it onto the nearest guide.
  - It acts only when the tilt is clearly measured (> 2 jackknife standard errors), between 1.5° and 10°, and at least half the line's strokes agree on the baseline. Otherwise the line is left exactly as written; maths-dense lines usually are.
  - It never snaps points to a line, never resizes, and never pushes ink off the page.
- **Reversible:** every moved stroke stores the transform (`assist`). *Restore original* inverts it exactly, and undo works too.
- **Letter size is not normalized after writing.** Without recognising which strokes are letters, superscripts or fraction parts, a size estimate would shrink maths and enlarge short words. Size consistency comes from the steady writing plane instead.

### 5. Measurements (layout harness, `npm run layout -- --seeds 6`)

The writer writes letters of a fixed physical size (1.4 cm x-height) on a surface in front of the camera. Every mapping gets the same writing and the same noise, placed on the page that mapping shows. Webcam-like noise:

| Scene | Metric | v0.1.3 | Natural v0.1.4 | Writing Assist | + Tidy lines |
|---|---|---|---|---|---|
| "hello" ×2 on 3 lines at 45 / 37 / 56 cm | letter-size spread (CV) | 22.2 % | 22.2 % | **5.1 %** | 5.1 % |
| | largest ÷ smallest word | 1.72 | 1.70 | **1.14** | 1.14 |
| Leaning in 42 → 52 cm across one line | size spread | 13.0 % | 12.7 % | **5.6 %** | 5.5 % |
| | line tilt | 4.0° | 8.5° | **0.35°** | 0.5° |
| Turning the hand (facing / 40° / tilted up) | size spread · baseline steps | 3.9 % · 1.7 px | 4.9 % · 2.2 px | 4.9 % · 2.1 px | same |
| Arm sinking 1.2 mm/s, two lines | line tilt | 4.8° | 4.8° | 4.8° | **0.42°** |
| Maths: x², fraction, √x, ∫x₁, Σₙ | notation size / position error* | 0.21 / 0.26 | 0.20 / 0.22 | 0.20 / 0.22 | **unchanged** |
| All | live cursor vs final ink | 14 px | 17 px | 17 px | — |
| All | pipeline time per frame | 0.013 ms | 0.010 ms | 0.011 ms | — |

\* How far each superscript, subscript, denominator or root sign is from where the main text predicts, relative to its size / in main-letter heights. Tidy lines changes it by < 0.01 (rigid motion). The remaining error comes from tracking noise and smoothing on small strokes, and is the same in every version. On the gentle noise model it is 0.07 / 0.10.

**Costs, stated plainly:**
- The fitted region is ~25 % smaller in the camera image than the old centred one, so at Medium the same hand movement makes writing **~1.33× larger** on the page than v0.1.3 (x-height 60 → 80 px in these scenes). Choose *Small* for the old size, at the cost of the page edges.
- Natural Writing tilts more when you lean while writing (8.5° vs 4°), because the region now sits higher in the image, away from the optical centre where perspective shifts are smallest. Writing Assist removes it (0.35°).
- Tidy lines can add up to ~0.5° to a line that was already level (estimation noise on short lines).
- In Writing Assist, a hand turned more than 20° from its starting orientation keeps the last scale, so leaning in *while* the hand is turned is not compensated.

## v0.1.3: hand orientation, pen-up feedback, fast writing (gesture parts now opt-in)

**Everything below is measured on synthetic traces from a modelled hand and modelled noise. None of it is a real-webcam measurement.** The screenshot and traces mentioned in the v0.1.3 brief were not received; real traces are the next step.

### What the investigation found

- **MediaPipe world landmarks** (`worldLandmarks`) are metres in a frame centred on the hand, with camera-aligned axes ("smaller z = closer to the camera"). They give the hand's *shape and orientation*, not its position, so the pen position must still come from the image landmarks. They are a network estimate of 3D shape, not a measurement.
- **Orientation breaks the 2D pinch ratio.** With a projected 3D hand (`src/replay/hand3d.ts`), the same closed/open pinch reads 0.17 / 0.83 with the palm facing the camera but 0.12 / 0.51 with the fingers pointing at it: the opening looks ~40 % smaller, so pen-up needs a much bigger real opening. The 3D ratio (tip distance ÷ 3D palm size) is 0.16 / 0.75 in every orientation.
- **The v0.1.2 synthetic lifts were unrealistically sharp** (fully open in 3 frames, which any threshold catches at once). New *gentle lift* scenarios open only to 0.42 palm widths, slowly at first. On these v0.1.2 decides pen-up ~120–130 ms after the fingers start to open and draws live ink the whole time — consistent with the "pen-up not sensitive enough" report.
- **Lowering the pen-up thresholds broke strokes.** Every reduction tried (rise 0.05–0.065, speed 1.2–1.5/s, noise cap 2.0–2.2, time-confirmed partial openings) added 1–9 broken strokes per run across the scenarios because noise and grip wobble look exactly like small openings. Tightening pen-down to 0.24–0.26 lost whole strokes (1.8 → 3.5–4.5 per run). Those values were not adopted.
- **Fast writing was being flattened** by the pen-up refinement: the noise estimate averaged second differences, and the turns of fast letters leaked in, so it climbed to 4–5× the real noise and a 7-sample "e" was smoothed into a blob.

### What changed

| Area | v0.1.2 | v0.1.3 |
|---|---|---|
| Pinch measurement | 2D image ratio | **`auto`**: 2D while the fingers lie across the image; blends to the 3D world-landmark ratio as they tip toward the camera (along 0.4→0.8) or the palm turns edge-on (0.6→0.95). Setting *Pinch measurement*: automatic / always 3D / camera image only. Frames without world landmarks use 2D. |
| Tracking quality | — | `good` / `reduced` / `poor` from the hand-local frame (wrist, index, middle, pinky MCP); a hint appears when the fingers point at the camera |
| Live ink at pen-up | drawn until the pen-up decision | **paused at half of any release threshold**; drawn later if the fingers settle back, dropped if the pen lifts. Decisions are identical (tested). |
| One-frame glitch | the unsmoothed check could end a stroke on one frame | a moderate unsmoothed jump must be confirmed by the next frame (a jump over 2× still lifts at once) |
| Release onset trim | linear hinge | linear **or quadratic** hinge (slow-starting openings) |
| Opening speed / backstop | 1.7 /s, 0.42 | **1.4 /s, 0.38** |
| Pen-down threshold, other release thresholds, noise cap | 0.27 · 0.07 · 0.05 · 2.5× | unchanged (see above) |
| Refinement noise level | mean of second differences | **median** (robust to fast-letter accelerations), ×1.5 for correlated noise; a stroke's own estimate only from 8+ samples and ≤ 3× the session level. The live filter keeps the v0.1.2 estimate. |
| Timestamps | `performance.now()` when processing | camera **capture time** from `requestVideoFrameCallback` when the browser reports it |
| Diagnostics | FPS, inference | + frame interval, capture → pen-update latency, skipped camera frames, orientation quality, 3D share |
| Trace format | v2 | **v3**: world landmarks (`w`) and per-frame 2D/3D ratio, palm normal, quality, frame interval, inference time, latency (v1/v2 traces still replay, with the 2D ratio) |

Not changed, with reasons: the pen point stays the thumb–index midpoint (in the model it is the contact point in every orientation). Hand-local or "virtual plane" writing coordinates were not adopted: world landmarks carry no position, so a hand-local frame cannot place the pen on the page, and the existing two-pinch calibration already defines the writing plane in the image. A Web Worker was not added: the pipeline after inference takes ~0.01–0.03 ms per frame; whether inference itself blocks the main thread on your laptop is now visible in the diagnostics (inference ms, capture → pen-update, skipped frames) and should decide it.

### v0.1.2 vs v0.1.3 on identical synthetic traces

`npm run replay -- --json`, 5 seeds per scenario, webcam-like noise, totals per run (px on the 1600-px page; * = mean per scenario). v0.1.2's code was run on the same new traces.

| Metric | Writing (10) | Speed (3) | Gestures (5) | Gentle lifts (4) | Orientations (10) |
|---|---|---|---|---|---|
| Broken strokes | 2.2 → 2.0 | 0 → 0 | 0.8 → 0.8 | 2.0 → **1.2** | 5.8 → **4.0** |
| Accidental strokes | 0 → 0 | 0 → 0 | 0 → 0 | 5.8 → **1.4** | 6.2 → **0.4** |
| Lost strokes | 0.2 → 0.2 | 0.6 → 0.6 | 0.6 → 0.6 | 2.8 → **0.8** | 1.4 → **0.4** |
| Live tail (ink seen after the fingers open) | 242 → **1** | 11 → **0** | 49 → **19** | 2796 → **1296** | 900 → **127** |
| Final tails | 676 → 665 | 389 → 358 | 263 → 242 | 817 → *956* | 2063 → *2415* |
| Start hooks | 493 → *507* | 415 → *510* | 124 → 121 | 511 → *580* | 941 → *1049* |
| Missed ink | 4775 → 4871 | 2949 → 2857 | 706 → 717 | 3337 → 3198 | 9799 → 9055 |
| Pen-down delay (ms)* | 12 → 12 | 24 → 24 | 7 → 6 | 0 → −10 | 31 → **13** |
| Pen-up decision delay (ms)* | 6 → *14* | 0 → *4* | 22 → *27* | 73 → *133* | 14 → *20* |
| Live lag / jitter* | 20 / 0.3 → same | 30 / 0.5 → same | | | |

On the gentle noise model, fast "Hello" (3×) misses 86 → 31 px of ink per stroke; small loops and the equation are unchanged.

**Costs, stated plainly:**
- The *decision* to lift is not faster; it is 1 frame later on facing hands (glitch confirmation) and later on the orientation/gentle-lift sets where the 3D ratio (assumed noisier) is used. What is faster is the *visible* stop: live ink pauses at half the threshold.
- Final tails and start hooks are larger with the fingers toward the camera (3D measurement), in exchange for far fewer broken, accidental and lost strokes.
- The 3D benefit depends on how noisy real world landmarks are, which only real traces can tell. With world-landmark noise assumed **2×** the model's (`--world-noise 2`), "fingers toward the camera" loses 3.2 strokes per run (v0.1.2's 2D: 1.0); at **0.5×** it loses 0.4. If real traces show this, set *Pinch measurement* to *Camera image only*.

## How gesture detection works

1. **Pinch ratio.** Thumb-tip to index-tip distance divided by palm size (mean side of the wrist / index-MCP / pinky-MCP triangle), in frame-width units so x and y count equally on 16:9 video. Depth (z) counts at weight **0.25** (v0.1–0.1.1: 0.5), because MediaPipe's depth is its least reliable coordinate, especially for a fingertip the thumb is covering.
2. **Signal.** The ratio is lightly smoothed (EMA, α = 0.6) and its two-frame opening velocity is tracked. The unsmoothed ratio is also kept, for the decisions that must not wait.
3. **State machine** (`gestures/gestureState.ts`): `no-hand → hover → pinch-pending → writing → hover`, plus `lost`. It is designed around the whole cycle, and it is asymmetric: deliberate when putting the pen down, fast when lifting it.

**Pen down (deliberate).**
- The smoothed ratio must be below **0.27** (v0.1.1: 0.30) for **2 frames**.
- It must have *closed* by at least **0.12** from an open position seen in the last second (v0.1.1: 0.10). Fingers that merely drift close together while you reposition don't count.
- Ink starts once the closing has settled. The unsmoothed closing speed must be under 2.0 ratio/s, or the pen goes down anyway after 5 frames. Earlier pinched frames already at the settled level are included, so the start of the stroke isn't lost.

**Pen up (fast, no debounce).** The pen lifts on the **first** frame that meets any of these:
- The smoothed ratio rises **0.07** (v0.1.1: 0.08) above your own pinched baseline.
- The unsmoothed ratio rises **0.105** above it (1.5 × that 0.07).
- The ratio opens faster than **1.7 ratio/s** (v0.1.1: 2.0) after rising at least **0.05** (v0.1.1: 0.06).
- The ratio crosses the 0.42 backstop.

**Noise adaptation.**
- WISP measures your pinch ratio's noise while you write, and how uncertain the baseline still is early in a stroke.
- The three relative thresholds above rise to stay 4σ above that noise, but by no more than **2.5×**. A cap of 1.75× was tried and measured: it doubled broken strokes on noisy input.

**Release-onset trimming (hinge fit).** When the pen lifts, WISP fits the unsmoothed ratio over the last 250 ms with a "hinge": flat at your baseline, then a straight rise into the release. Ink after the hinge point is removed.
- A quick release trims nothing.
- A slow release trims the frames where your fingers were already opening.
- Isolated noisy frames don't form a ramp, so they are kept.

v0.1.1 instead trimmed every frame above a noise level, which also cut real ink off short strokes.

**Anti-flicker.** After a release, a new pinch must close by 0.12 from the peak since the release.

**Tracking gaps.**
- One- and two-frame gaps are tolerated in every state for 160 ms: a stroke continues, and a pinch that is closing is kept.
- v0.1.1 reset to "no hand" on the first missed frame before pen-down, which lost the whole stroke if the thumb hid the index tip for one frame.
- After 160 ms the stroke ends cleanly, and a hand that returns already pinched does not resume writing (no connecting line).

**Accidents.**
- A hand that enters the frame already pinched never writes until it has been seen open.
- A hand must be visible for 3 frames before a pinch counts.


## Smoothing and accuracy

The virtual pen point is the **midpoint of the thumb and index fingertips**: while pinched, the contact point (`input/handFrameProcessor.ts`). One filter runs on the midpoint, rather than one per tip.

Pipeline (`strokes/strokeEngine.ts`):

```
raw pen point ─► outlier gate ─► One Euro (noise-gated) ─► stabilizer (noise-scaled) ─► cursor + live ink
pen-up:  raw samples ─► trim release onset ─► remove glitches ─► noise-matched Whittaker smoother ─► final stroke
```

- **Measured tracking noise (new).** WISP estimates landmark noise continuously from second differences of the raw pen point while it moves slowly (`NoiseEstimator`). Everything below scales with it.
- **Noise-gated live filter (new).** One Euro loosens with speed, but only speed beyond what the measured noise produces now counts (gate 1×). Random landmark fluctuation no longer reads as "intentional fast movement" and passes straight through.
- **Stabilizer.** Its radius is now *jitter stabilizer* × 3σ of the measured noise, at most 6.4 px. The default is 0.25 (v0.1.1: 0.4 × a fixed 6.4 px). A clean camera gets a small radius (less rounding), a noisy one a larger one.
- **Pen-down seeding.** The stroke starts at the average position of the last 110 ms if the hand was still, otherwise at the latest position. A median-of-three start was tried in this release and rejected: its one-frame lag created start hooks.
- **Noise-matched refinement at pen-up (new).** This replaces v0.1.1's forward-backward One Euro, which barely acts on the 4–6 samples of a quick tick or dash.
  1. **Glitch removal.** A point that departs from the line through its neighbours by more than 4× the stroke's typical deviation (and at least 9.6 px) is a one-frame landmark glitch and is replaced.
  2. **Whittaker smoother** (penalised least squares, second differences, solved exactly in O(n)). Its strength λ is chosen so the movement it removes matches the measured noise: it removes what noise explains and keeps the rest.
  3. **Cap on λ.** λ is capped by the *Stroke smoothing* setting (scaled to the frame rate), so loops, superscripts and corners at handwriting speed are never flattened.

  It has zero lag, endpoints included.
- **Outlier gate, resampling and raw positions** work as before.

**Live vs final.** Finished strokes are re-smoothed, so the live view and the final ink can differ by a few pixels at pen-up; the live view is tuned for low lag and low shake. Mouse input skips the gate, the stabilizer and the refinement, and uses the same filter, strokes, undo and export.

### What caused the distorted handwriting (v0.1.2 diagnosis)

No screenshot or real traces reached this session, so the diagnosis comes from your description plus a harsher replay model. That model adds known MediaPipe behaviour the first one left out:
- noisier fingertips while pinched (occlusion)
- one-frame glitches
- apparent pinch-distance drift from hand rotation
- depth noise
- uneven frame timing and missed frames

Under it, v0.1.1 reproduced every symptom you described. Causes, in order of impact:

| Symptom | Cause | Fix |
|---|---|---|
| Strokes lost entirely, broken strokes | A one-frame tracking gap while the pinch closed reset the gesture; depth noise made the pinch ratio noisy | Gap tolerance before pen-down; depth weight 0.25; noise cap 2.5× |
| Irregular, kinked short strokes and loops | Fingertip noise is largest exactly while pinched; a 4–6-sample stroke gives a recursive filter nothing to work with; glitches passed through | Noise-matched Whittaker refinement; glitch removal; noise-gated live filter |
| Short strokes losing their end | Release trim removed ordinary noisy frames before the release | Hinge-fit onset |
| Short strokes losing their start | Strict settle rule plus one-frame gaps | Pinched-level inclusion; gap tolerance |
| Tails / overshoots | Release detected a frame late; trim missed noisy slow openings | More sensitive pen-up; hinge-fit onset |
| Stray marks while repositioning | Fingers drifting close together could start a stroke | Deliberate-close requirement; pen-down threshold 0.27 |

Stroke coordinates, mirroring and rendering were checked and are not causes. Cursor and live ink share one filtered point, and the renderer draws exactly the stored points.

Also tried and rejected (measured worse):
- **"Hand-shape" fusion of fingertips with knuckle landmarks.** Fingertips move relative to the knuckles as the pinch closes, so start hooks tripled.
- **Down-weighting stroke-end samples.** Mixed results.
- **A median-of-three start point.** Caused hooks.
- **A noise cap of 1.75×.** Doubled broken strokes.

### Parameter reference (v0.1.2)

| Parameter | Setting / location | v0.1.1 | v0.1.2 |
|---|---|---|---|
| Pen-down threshold | *Pen-down sensitivity* 1.0× | 0.30 | **0.27** (needs a ~10% tighter pinch) |
| Deliberate close | `pinchDetector.ts` | 0.10 below the last open peak | **0.12** below an open peak within 1 s |
| Pen-up relative rise | *Pen-up sensitivity* 1.0× | 0.08 | **0.07** |
| Pen-up raw rise | (1.5 × the above) | 0.12 | **0.105** |
| Pen-up opening speed | | 2.0/s after +0.06 | **1.7/s after +0.05** |
| Noise cap on pen-up thresholds | `gestureState.ts` | none | **2.5×** |
| Release trim | `gestureState.ts` | frames above a noise level, ≤ 200 ms | **hinge fit**, ≤ 250 ms |
| Tracking gap before pen-down | `gestureState.ts` | reset on the first missed frame | **160 ms grace** |
| Pinch depth weight | `landmarks.ts` | 0.5 | **0.25** |
| Live filter noise gate | `strokeEngine.ts` | none | **1× noise speed** |
| Stabilizer | *Jitter stabilizer* | 0.4 × 6.4 px | **0.25 × 3σ** (≤ 6.4 px) |
| Pen-up refinement | *Refine…* | forward-backward One Euro | **glitch removal + noise-matched Whittaker**; λ cap 2→60 over *Stroke smoothing* (0.5 → ≈11 at 30 fps) |
| Pen point, One Euro base parameters, resampling | | unchanged | unchanged |

Settings sliders keep their meaning (1.0× = the defaults above). If you changed sliders while testing v0.1.1, press **Reset writing defaults** in Settings before testing v0.1.2.

### Before/after on identical inputs

`npm run replay -- --json` runs v0.1, v0.1.1 and v0.1.2 on the same 13 scenarios: slow horizontal and vertical lines, a circle, small loops, "Hello", the equation, three kinds of repeated short strokes, rapid and slow pinch/release, repositioning, and tracking loss. Each runs 6 times with different noise.

Totals over the 13 scenarios (mean per run), px on the 1600-px page. Values marked * are averages per scenario. **Synthetic, modelled noise; not a real-webcam measurement.**

| Webcam-like noise (×1) | v0.1 | v0.1.1 | v0.1.2 |
|---|---|---|---|
| Unintended strokes | 1.17 | 0.00 | 0.17 |
| Broken intentional strokes | 0.00 | 0.83 | **0.17** |
| Strokes lost entirely | 1.17 | 1.00 | **0.17** |
| Unwanted tails | 1131 | 610 | **413** |
| Start hooks | 1099 | 435 | **400** |
| Missed ink | 3998 | 3339 | **3116** |
| Stray ink | 6036 | 3223 | **2657** |
| End displacement* | 31.4 | 20.6 | 21.1 |
| Jitter of finished strokes* | 0.8 | 0.4 | **0.1** |
| Live lag* | 16.9 | 13.2 | 16.0 |
| Largest point gap* | 48.1 | 34.8 | **21.8** |
| Processing per frame* | 0.01 ms | 0.02 ms | 0.02 ms |

Repeated short strokes, v0.1 / v0.1.1 / v0.1.2 (webcam ×1):

| Scenario | Tails | Missed ink | Hooks |
|---|---|---|---|
| Spaced strokes | 58 / 80 / **45** | 485 / 475 / **431** | 151 / 61 / **46** |
| Fast tight ticks | 91 / 122 / **74** | 343 / 377 / **291** | 102 / 74 / **36** |
| Dashes | 149 / 75 / **61** | 175 / 157 / 186 | 196 / 81 / **68** |

Dashes miss slightly more ink because the more deliberate pen-down occasionally skips a loose pinch.

**Costs, stated plainly:**
- Live lag is about 3 px higher than v0.1.1, in exchange for 40% less live shake.
- At 1.5× noise, repeated-stroke tails are worse than v0.1.1 (152 vs 111 px).
- On the gentle model, tails (54 → 69 px) and hooks (45 → 63 px) are slightly worse, totalled over all 13 scenarios.


## Coordinates

| Space | Definition |
|---|---|
| Camera | MediaPipe normalized image coordinates, [0,1], origin top-left, as the camera sees it |
| View | Camera space after optional mirroring (x → 1 − x); writing regions are defined here |
| **Page** | **[0,1]² over the page, origin top-left, y down. The only space strokes are stored in.** |
| Screen | CSS pixels; the page is letterboxed into the canvas |

The page has a fixed logical size (default 1600 × 1000). Pen width is stored in logical page pixels. The default writing region (v0.1.4) has the page's aspect ratio *in camera pixels*, so a circle drawn in the air stays a circle. It is fitted inside the area where the pen can go with your palm still in the camera frame, measured from your hand and then locked (see v0.1.4 above). v0.1–v0.1.3 centred it at 70 % of the view. In Writing Assist it is also zoomed about the camera's optical centre as you lean in or back.

## Stroke data format

Still `wisp.strokes` version 1; files from every earlier version import as before. v0.1.4 adds one **optional** stroke field, `assist: { a, b, tx, ty }`: the rigid transform (page px) *Tidy lines* applied, so the original can be restored. Strokes that were never tidied serialize exactly as before; older WISP versions ignore the field and show the tidied ink. Page coordinates are unchanged too: world landmarks are used only to measure the pinch and the hand's orientation, never for the pen position.

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

`npm test` runs 390 unit tests (v0.1.5 adds 99: the continuity guard — ordinary, fast, reversing, glitching, relocating, swapping, gapping and suspended-then-steady motion, distance independence; mapping frozen for a stroke and setting changes deferred; aspect-true calibration; A/B guarantees on normal and adversarial traces; 64 bit-exact v0.1.4 replays; trace v4; recording → replay fidelity through the real webcam loop; switching pipelines mid-stroke; guides and settings; wisp-motion validation, manifests, splits, leakage, features, labels and baselines. v0.1.4 added 72 gesture-golden cases and 22 boundary/plane/layout tests; earlier: 197 (v0.1.3 adds 21: 3D ratio invariance and fallbacks, orientation quality and blending, live-ink pause and identical decisions, glitch confirmation, quadratic onset, robust noise level, fast-loop refinement, orientation scenarios, trace v3, settings)). They cover:
- **Gestures:** pinch thresholds and asymmetry; deliberate pen-down (drifting fingers don't start ink); pen-up cases (rapid, slow, small and fast openings, noisy measurements, re-pinch); hinge-fit trimming (quick release trims nothing, slow release trims the ramp); tracking gaps before and during writing.
- **Smoothing:** the Whittaker solver against a dense reference; glitch removal; noise estimation; noise-matched refinement (straightens noisy ticks without shortening them, keeps loops round); the noise-gated filter.
- **Ink and data:** the midpoint and mirroring; the continuous filter and seeding; pinch depth weight; trace v2 recording and parsing; serialization round-trips and invalid input; settings migration; undo/redo; the Inkling adapter.
- **Replay-harness regressions** on both noise profiles: exact stroke counts on the gentle model; stroke counts within one, no accidental strokes while repositioning, and no connecting lines after tracking loss on webcam noise; per-stroke tail and missed-ink bounds for short strokes.

These tests show the logic is correct on modelled input. They say nothing about real-world accuracy, latency or comfort.

**Recording your own traces (the real test).**
1. Turn on *Developer diagnostics* and click *Record landmark trace*.
2. Write one test, then click *Stop & save trace*.

The file contains:
- the hand landmarks, including the raw thumb and index tips
- per frame: the raw and filtered pen point, unsmoothed and smoothed pinch ratio, baseline, opening velocity, gesture state and pen state
- pen-down and pen-up events, and the finished strokes (raw and processed)
- your settings

Never video. Since v0.1.5 a replay uses the settings saved in the trace (mirroring, writing area, size, Writing Assist, smoothing) and the live pipeline processes exactly the precision a trace stores, so replaying a trace reproduces the strokes you saw, point for point. Compare both pipelines on it with `npm run ab -- wisp-trace-….json --html ab.html`. Replay it with: `npm run replay -- wisp-trace-….json --compare releaseSensitivity=0.8,1,1.2 --html compare.html`. Every run sees exactly the same hand motion, and the HTML page draws the strokes for each setting side by side. Any setting can be compared, including `depthWeight` and `noiseGate`.

**Needs testing with a real webcam and hand (v0.1.5):** see "Real-webcam test plan (v0.1.5)" below.

**Needs testing with a real webcam and hand (v0.1.3):**
- Every orientation in the brief (palm facing, 45°, fingers toward the camera, sideways, tilted up/down, near/far): record one trace each, then `npm run replay -- trace.json --compare pinchMetric=2d,auto,3d --html compare.html`
- How noisy MediaPipe's world landmarks really are (the 3D-vs-2D trade-off depends on it)
- Whether live ink pausing at the first opening feels like an immediate pen-up
- Capture → pen-update latency and skipped frames on your laptop (decides whether a Web Worker is worth it)

**Still open from v0.1.2:**
- Whether pen-down at 0.27 feels deliberate without missing strokes, and whether pen-up lifts early enough without breaking strokes mid-letter
- Short strokes, superscripts and loops in "Hello World" and x² + 3x − 5 = 0
- The small settle at pen-up when the refinement replaces the live stroke
- Live lag vs live shake
- Whether depth weight 0.25 suits real MediaPipe depth noise (compare 0.5 on your traces)
- Frame rate and inference time on your laptop


## Real-webcam test plan (v0.1.5)

Turn on *Developer diagnostics*. For each test: *Record landmark trace*, write, press *Mark glitch* right after any stray line, *Stop & save trace*. Then `npm run ab -- trace.json --html ab.html` and open the page: every piece of ink that v0.1.5 removed should be a stray line, never your writing.

1. **Stray lines (main fix).** Write "Hello World" three times at normal speed while (a) briefly covering the index fingertip with the thumb, (b) moving your other hand into view and out again, (c) dipping your writing hand out of the frame bottom for a moment mid-word. Expect: no line across the page; the diagnostics show *Strokes split* / *Ink suspended* counts.
2. **Nothing legitimate lost.** Fast short dashes (– – – –), a fast zig-zag (W W W), "x² + 3x − 5 = 0", a dotted "i". Compare with *v0.1.4 pipeline (A/B)* on the same writing. Expect: the same strokes; *Glitch frames dropped* stays near 0 when tracking is clean.
3. **First stroke after raising the hand.** Raise your hand and start writing within half a second, ten times. Expect: no jump in the first stroke.
4. **Calibration shape.** *Set writing area* with a wide, comfortable rectangle, then draw circles and "o o o". Expect: round circles (v0.1.4 drew them tall).
5. **Distances.** Writing Assist on: one line at your normal distance, lean in ~10 cm for the next, back ~10 cm for the third. Natural off vs on.
6. **Rotation while writing.** Write "hello" while slowly turning the palm sideways (~40°).
7. **Multiple lines with guides.** Guides on, try *Line spacing* 1.0 and 1.4; write three lines; then *Tidy lines* and *Restore original*.
8. **Latency.** Diagnostics: *Capture → pen update* with Smart Ink on and on the v0.1.4 pipeline (should match within noise); does live ink ever feel like it hesitates?

Send the traces (landmarks only) and a screenshot; they decide the next tuning, including the short-fast-stroke fix.

## Known limitations

- **Defaults are tuned on modelled noise.** Two models agree on the direction of every change, but real traces are needed to confirm the values.
- **Slow drift can still bend very short strokes.** Fingertip landmark drift over a few frames is in the same frequency band as writing. No filter can separate it from intentional motion, so very short strokes can still lean or bow a little.
- **Loose pinches.** The more deliberate pen-down can skip a pinch that reads loose (e.g. with the hand turned). Pinch slightly tighter, or raise *Pen-down sensitivity*.
- **Conservative first second.** In the first second of writing, before your pinch noise is measured, pen-up needs a slightly larger opening.
- **Noisy tracking.** Under very noisy tracking, a long stroke can occasionally split in two; lower *Pen-up sensitivity* if this happens.
- **Live vs final ink.** The live stroke and the final stroke can differ by a few pixels at pen-up.
- **Main-thread tracking.** Inference runs on the main thread; the diagnostics now show whether that costs frames.
- **3D pinch is modelled, not verified.** World-landmark noise in the replay model is an assumption (`--world-noise`).
- **Pen-up decision.** Lifting a little (fingers just separating) still takes ~4 frames to decide on a facing hand; live ink stops sooner, but the decision does not.
- **Edge reach depends on your camera.** The fitted region assumes MediaPipe loses the hand when the palm leaves the frame; if your camera tracks partly-visible hands, *Set writing area* can make it larger.
- **Writing size** is about 1.33× larger at Medium than in v0.1.3 (smaller fitted region); use Small for the old size. A calibrated area that isn't page-shaped now maps the page to the largest page-shaped rectangle inside it (equal gains), so its usable area can be a little smaller than the rectangle pinched.
- **Steady size needs a consistent hand pose**; turning the hand > 20° holds the last scale.
- **Very short fast dashes** lose about a third of their length (≈ one frame of motion at each end). Measured in v0.1.5: the drawn height of the same letter varies 82–107 % with speed and noise for this reason. It lives in the pen-down/pen-up timing, which is kept exactly as v0.1.2; the fix needs real traces.
- **Stroke protection is tuned on modelled faults.** Its thresholds (palm widths, per second) are physically motivated, but how often and how MediaPipe really fails is unknown until real traces exist.
- **Re-detection at a wrong but reachable place** (tracking drops out and returns a few cm off) can't be told from the hand really moving there: v0.1.5 no longer connects it, but inks the new place (10 of 38 such modelled faults left ≥ 40 px of stray ink).
- **Splits instead of lines.** A confirmed jump ends the stroke; the result is two strokes where one was meant (more pieces on corrupted traces) and occasionally a lost dash.
- **Held frames.** A suspicious frame pauses live ink for one frame (~33 ms) before it is drawn or dropped.
- One hand only; uniform stroke width; timestamps are relative within a file; the calibrated area is stored in view space; no eraser yet.


## Planned improvements

See [ROADMAP.md](./ROADMAP.md).
