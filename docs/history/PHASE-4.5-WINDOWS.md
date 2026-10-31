# Phase 4.5 notes (Windows stabilisation)

Kept for history. Written during the Phase 4.5 Windows stabilisation; current status is in [READINESS.md](../READINESS.md).

- **Clean install** — Electron 45 stopped downloading its binary on install; `postinstall` now does it (see *Install and run* in [DEVELOPMENT.md](../DEVELOPMENT.md#install-and-run)).
- **PDF unit tests on Windows** — the tests passed pdf.js a backslash path for its fonts; they now use a forward-slash path with a trailing `/` (`tests/support/pdfjsData.mjs`). App code was not affected.
- **Intermittent resize failure** ("opposite corner fixed", seen once on Windows) — not reproduced: 25 normal and 10 CPU-starved runs on Linux, plus probes with 125–175 % display scaling, a window resize mid-drag and the pointer thrown past the opposite corner, all kept the corner within 0.003 page units (tolerance 1.5). The test now waits for the specific edit to reach disk and confirms the handle is under the pointer before dragging, and reports the full geometry and a screenshot if it fails again; it then passed 20 of 20 runs on Linux. Repeated runs on Windows (`npm run test:e2e:phase2`, ideally 20×) are still needed to close this out.
- **Narrow windows** — fixed in the local-AI milestone: less-needed controls fold away instead of overlapping; `tests/e2e/layout.e2e.mjs` checks seven window sizes from 960×600.
- **Real Gemini** — not yet run against Google's API in this milestone (no key was configured in the test environment). Run the smoke test above, then try the four flows in the app.
