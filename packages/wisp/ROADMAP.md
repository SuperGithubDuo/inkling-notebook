# WISP roadmap

## v0.1: reliable stroke capture (this release)
Standalone prototype: webcam hand tracking, pinch-to-write, One Euro smoothing with outlier rejection, vector stroke model with JSON import/export, undo/redo, mouse simulation, unit tests.

## v0.2: measure and harden
- **Real-hardware evaluation.** Record anonymised landmark traces (landmarks only, never video, with consent) on 5–10 laptops and tune pinch thresholds, debounce and smoothing defaults from data. Use the `raw` vs smoothed points already stored to compute jitter and lag.
- **Tracking in a Web Worker** (MediaPipe supports workers via `ImageBitmap`/`OffscreenCanvas`) so slow inference never blocks the UI.
- **Replay harness.** Feed recorded landmark traces through `HandFrameProcessor` in tests to catch regressions in feel, not just logic.
- **Pinch-start compensation.** Correct the fingertip movement caused by the pinch itself (e.g. anchor to the position just before the pinch closed), and evaluate the thumb–index midpoint pen tip.
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
