# WISP roadmap

## v0.1: reliable stroke capture
Standalone prototype: webcam hand tracking, pinch-to-write, One Euro smoothing with outlier rejection, vector stroke model with JSON import/export, undo/redo, mouse simulation, unit tests.

## v0.1.3: hand orientation and pen-up feedback (this release)
Orientation-aware pinch (2D blended with a 3D world-landmark ratio as the hand turns), tracking-quality indicator, live ink that pauses at the first sign of opening, glitch-confirmed release, quadratic release-onset fit, robust refinement noise level for fast writing, capture-time timestamps, latency diagnostics, trace v3 with world landmarks, projected 3D hand model with 32 replay scenarios. Modelled only; awaiting real-webcam traces across orientations.

## v0.1.2: handwriting quality and gesture calibration
Noise-aware pipeline: measured tracking noise gates the live filter and sizes the stabilizer; finished strokes get glitch removal plus a noise-matched Whittaker smoother; hinge-fit release trimming; deliberate pen-down (0.27, deliberate close); slightly more sensitive pen-up with a 2.5× noise cap; tracking-gap tolerance before pen-down; pinch depth weight 0.25. Harsher MediaPipe-like replay profile, 13 scenarios, full metric set, HTML stroke drawings, trace v2 with per-frame diagnostics. Tuned on modelled noise; awaiting real-webcam traces.

## v0.1.1: handwriting quality
Pen point moved to the thumb–index midpoint; asymmetric, noise-adaptive pinch release with tail trimming; continuous One Euro filter retuned (beta 0.04, dCutoff 0.7 Hz) with pen-down seeding, a jitter stabilizer and zero-lag refinement at pen-up; landmark replay harness and trace recorder. Tuned on modelled noise; awaiting real-webcam testing.

## v0.2: measure and harden
- **Real-hardware evaluation.** Record anonymised landmark traces (landmarks only, never video, with consent) on 5–10 laptops and tune pinch thresholds, debounce and smoothing defaults from data. Use the `raw` vs smoothed points already stored to compute jitter and lag.
- **Tracking in a Web Worker** (MediaPipe supports workers via `ImageBitmap`/`OffscreenCanvas`) if the v0.1.3 latency diagnostics show inference costing frames on real laptops.
- **Tune 3D vs 2D pinch** on real traces from every orientation (world-landmark noise is currently assumed).
- **Real traces in the regression suite.** The replay harness exists (v0.1.1); add a small library of recorded traces from real webcams to the tests and retune defaults on them.
- **Browser coverage**: Firefox and Safari passes, a CPU-only performance profile.
- Gesture-based erasing (e.g. an open palm sweep) if testing shows it's reliable enough.

## v0.3: Inkling integration
- Make `packages/wisp` consumable by Inkling's renderer (workspace or path alias), keeping WISP free of Inkling imports.
- *WISP Mode* toggle on a notebook page: writes through Inkling's command layer (`createStroke`), so undo, auto-save and the AI Tutor work unchanged.
- Electron camera permission handler limited to the app's origin, with clear consent UI.
- Map the writing region to the visible part of the page and follow Inkling's zoom and pan.

## Later
- Handwriting recognition on WISP strokes (online recognition can use stroke order and timing, which images lose).
- Mathematical expression recognition for the AI Tutor.
- Adaptive smoothing that learns from each user's movement.
- Personalised gesture settings and a short guided calibration.
- Improved spatial calibration (depth-aware, handles leaning back and forth).
- Integration with Inkling's AI Tutor (e.g. "check what I just wrote in the air").
