# wisp-motion — research area for a learned air-writing motion model

Status (WISP v0.1.5): **infrastructure only. No model has been trained, and none is used by the live app.** Nothing in this folder is imported by `src/App.tsx`, the processor or the engine; the live pipeline's protection against tracking errors is the rule-based continuity guard (`src/strokes/continuity.ts`).

Why not train now: there is no real recorded data yet (every number in WISP so far comes from a modelled hand and modelled noise), no labels, and therefore no way to show that a model beats the rule-based baseline on writers it has never seen. Training on noisy landmarks alone would mostly teach a model to reproduce MediaPipe's own errors.

## Two different problems

| | Task A — tracking-error detection | Task B — trajectory reconstruction |
|---|---|---|
| Question | Is the tracked pen position at this frame wrong (glitch, misplaced fingertip, wrong hand, re-detection)? | Where did the writer actually intend the pen to be? |
| Output | p(glitch), p(intentional movement), reliability of the pen position, per frame | A corrected pen path |
| Labels | Per-frame error spans (manual annotation; "Mark glitch" presses as weak labels) | **Reference pen paths from an independent sensor.** Landmarks are not ground truth. |
| Can it start with WISP alone? | Yes, once real traces are recorded and annotated | No — needs extra hardware (below) |
| Risk if done badly | False alarms pause ink; misses draw stray lines (the guard still protects) | Plausible-looking but invented strokes — worse than noise |

## What is here

| File | Purpose |
|---|---|
| `labels.ts` | Annotation sidecar format (`wisp.motion.annotations` v1), "Mark glitch" → weak spans, per-frame label vectors. Labels never modify traces (trace hashes stay stable). |
| `features.ts` | 25 per-frame features from tracker output only (never from WISP's own decisions): pen kinematics in palm widths, pen-relative-to-palm, palm size change, palm velocity, 2D/3D pinch, palm normal and its change, handedness flips, gaps. CSV export. |
| `dataset.ts` | Trace validation (no image/video fields, monotonic time, landmark ranges, metadata, consent), versioned manifest (dataset id = sha256 of every file's hash), **group** splits by participant or session with a leakage check. |
| `baselines.ts` | Task A detectors that any model must beat: v0.1.4 OutlierGate, v0.1.5 ContinuityGuard, a naïve speed threshold. Frame precision/recall/F1, event recall, false alarms per minute. |
| `synthetic.ts` | Synthetic labelled traces (modelled writing + injected faults with exact frame labels). For testing the tooling only. |
| `../../scripts/motion.ts` | CLI: `validate`, `manifest`, `split`, `features`, `baseline`, `synth` (`npm run motion -- …`). |

Recording side (in the app, v0.1.5): *Developer diagnostics → Record landmark trace* now writes trace **v4**: landmarks + world landmarks + **handedness** per frame, WISP's per-frame decisions including the **continuity-guard verdict**, pen events, guard **splits**, optional metadata (`participant`, `session`, `task`, `device`, `consent`), and **Mark glitch** presses. Never video.

## Synthetic sanity check (not evidence about webcams)

`npm run motion -- baseline --synthetic` — 84 synthetic traces, 6 simulated writers, 328 injected faults (fingertip glitches, transient hand jumps, hand swaps, scale jumps, drop-out + relocation):

| detector | precision | recall | F1 | event recall | false alarms / min |
|---|---|---|---|---|---|
| v0.1.4 OutlierGate | 0.52 | 0.27 | 0.35 | 72 % | 0.00 |
| v0.1.5 ContinuityGuard | 0.67 | 0.73 | 0.70 | 88 % | 0.26 |
| speed threshold | 0.48 | 0.17 | 0.25 | 92 % | 0.00 |

Per held-out simulated writer (`--per-participant`), the guard's F1 ranges 0.66–0.77.

These show the tooling works and give a floor; the fault model is ours, so they say nothing about how often or how MediaPipe really fails.

## Data collection protocol (what has to exist before any training)

**Participants.** At least **12** (for leave-one-participant-out evaluation with a usable spread), varied hand size, both handedness, skin tones and ages; ≥ 2 sessions each on different days. Pseudonymous codes only (`P01`…), consent recorded in the trace (`meta.consent`).

**Conditions.** At least 3 cameras (built-in laptop 720p, external 1080p, a low-light case), 2 lighting setups, distances 35–65 cm, the 12 writing tasks from the WISP A/B suite (slow/fast lines, circle, dashes, hand leaving and re-entering, rotation while writing, different distances, "Hello World", x² + 3x − 5 = 0, several words, several lines), plus free writing. Target ≈ **20 min of writing per participant per session** → ≈ 8 h total, ≈ 850 k frames at 30 fps.

**Task A labels.**
1. During recording: the writer presses *Mark glitch* after every stray mark (weak, cheap).
2. Afterwards: an annotator replays each trace (`npm run replay -- trace.json --html`) and marks exact error spans in a sidecar (`*.annotations.json`), using `unsure` where it can't be decided. Two annotators on ≥ 10 % of traces to measure agreement (Cohen's κ; aim ≥ 0.7).
3. Expected prevalence is low (perhaps 0.5–2 % of frames), so ≥ **500 annotated error events** across ≥ 12 participants are needed before a detector's recall can be estimated to ±5 %.

**Task B references** (only if Task B is pursued). The pen tip must be measured independently of the camera, for example:
- writing on a **graphics tablet or iPad + stylus** placed in the camera's view, timestamps synchronised (record a sync tap at start and end), tablet coordinates mapped to WISP's page by a calibrated homography — gives the true contact path;
- or a **motion-capture** marker on a ring at the fingertips;
- tracing displayed templates is NOT a reference (it measures intent, not where the hand went).
Without one of these, Task B must not be attempted.

## Evaluation rules

- Split by **participant** (`npm run motion -- split manifest.json --by participant`); never by frame or window. Windows for temporal models are cut after splitting, inside one recording. `checkLeakage` must report nothing.
- Report on held-out participants: frame F1, event recall, false alarms per minute **of normal writing**, and the end-to-end A/B metrics (`npm run ab`) with the model gating the guard.
- Pre-register the bar: e.g. **event recall ≥ guard + 10 points at ≤ the guard's false-alarm rate**, on every held-out participant, before the model can ship behind a flag.
- Always cite the dataset id from the manifest.

## Architecture proposal: WISP-Motion (Task A first)

A small **causal temporal convolutional network** (TCN), chosen because it is fast, has a fixed receptive field, and can't look ahead (live use).

- **Input:** the 25 features of `features.ts` over a causal window of 32 frames (≈ 1 s at 30 fps), per-feature normalisation fitted on the training split only. Optionally the 21 × 3 palm-relative landmarks (+63) if ablations show they help.
- **Body:** 4 residual blocks, kernel 3, dilations 1, 2, 4, 8 (receptive field 31 frames), 32 channels, weight-normalised causal convolutions, dropout 0.1. ≈ 15–20 k parameters.
- **Heads (per frame):** `p_glitch` (Task A), `p_intentional` (pen-down movement vs. tracking artefact), `reliability` (expected pen-position error, regression on Task B data when it exists).
- **Training:** class-weighted focal loss for `p_glitch`; early stopping on validation participants; temperature scaling for calibration (report ECE).
- **Cost:** ≈ 0.1 M multiply-adds per frame → well under 0.5 ms in plain TypeScript or ONNX Runtime Web (WASM); no GPU and no network needed.
- **Integration (only after it passes the bar):** the model never moves or invents pen positions. It only feeds the continuity guard: a high `p_glitch` holds a frame the rules would have accepted; a low one lets the rules release a held frame sooner. The rule-based guard remains the safety net, and `npm run ab` must show no loss of legitimate ink.
- **Task B** (later, with tablet references): the same TCN with a 2-D offset head predicting the correction from the tracked pen point to the reference, trained only on frames the reference covers, evaluated as endpoint and shape error on held-out participants — and only shipped if it beats the One Euro + refinement pipeline there.
