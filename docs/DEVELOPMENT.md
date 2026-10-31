# Developing Inkling

This page is for people who build Inkling from source. **To use Inkling you don't need any of this:** download the installer from the [download page](https://supergithubduo.github.io/inkling-notebook/) instead.

- [Requirements](#requirements) · [Install and run](#install-and-run) · [Testing](#testing) · [Continuous integration](#continuous-integration)
- Related: [Architecture](ARCHITECTURE.md) · [AI providers](AI-PROVIDERS.md) · [Building and releasing](RELEASING.md) · [Known limitations](KNOWN-LIMITATIONS.md)

## Requirements

- Node.js **22.13 or later in the 22.x line, 24.x, or 26+** (Node 22 LTS or 24 LTS recommended), with the npm that ships with it. This is the strictest range among the toolchain: Electron 45 and `@electron/get` need ≥ 22.12, pdf.js needs ≥ 22.13, and Vitest 5 doesn't support the odd-numbered 23.x/25.x lines. `package.json` declares it under `engines`. Node 20 is not supported.
- Windows 10/11, macOS or Linux, with internet access during install (the Electron runtime is about 100 MB).
- For the AI Tutor, one of: nothing (a release build has Inkling's free cloud AI built in), or [Ollama](https://ollama.com/download) 0.12.7 or later and a vision model, e.g. `ollama pull qwen3-vl:4b-instruct` (3.3 GB download, ~5.5 GB of memory while answering). Inkling never installs or downloads these itself. A Gemini API key is the optional alternative (adults only).

## Install and run

```bash
npm ci             # or npm install; also downloads the Electron runtime (see below)
npm run dev        # development, with hot reload
npm run build      # production build into out/
npm start          # run the production build
```

**The Electron runtime.** Since Electron 45 the `electron` npm package no longer downloads its binary during install; it downloads it lazily, the first time something calls `require('electron')`. electron-vite (`npm run dev`, `npm start`) and the Playwright tests don't go through that path, so on a clean checkout they found no binary. Inkling's own `postinstall` step (`scripts/ensure-electron.mjs`) now runs Electron's installer, which verifies the download against Electron's checksums and does nothing when the right binary is already present. If the download fails (offline, a proxy), `npm ci` still succeeds with a warning; fix the network and run:

```bash
npm run electron:install   # downloads node_modules/electron/dist; fails loudly if it can't
```

Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to skip the download, as CI does, since typecheck, unit tests and the build never launch Electron. Electron's usual download settings (`ELECTRON_MIRROR`, `electron_config_cache`, proxy variables) still apply.

Notes are saved to the OS app-data folder (`%APPDATA%\Inkling\Library` on Windows, `~/Library/Application Support/Inkling/Library` on macOS, `~/.config/Inkling/Library` on Linux), the same folder for development and installed builds. Daily backups go to `Backups` next to it. Set `INKLING_DATA_DIR` to use another folder (its backups then go to `<folder>-backups`). Settings → Storage shows the path, the backups, *Back up now* and *Restore*.

Installers: `npm run dist:win` / `dist:mac` / `dist:linux` on that system (see [`docs/RELEASING.md`](RELEASING.md)).

## Testing

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # unit tests (vitest): storage, history, commands, geometry, eraser, viewport, migration, assets, notes/Markdown, search/links/graph, PDF export, assistant context
npm run build
npm run test:e2e    # drives the real Electron app with mouse input: Phase 1–4, regressions, local AI (Ollama), cloud beta, layout, release (first launch, crash, repair, backups, upgrade, single instance)
npm run test:perf   # a 330-page notebook with a 150,000-point page: start-up, stroke latency, frame time, saving, search
npm run dist:linux && npm run test:packaged   # the packaged app itself (on Windows/macOS: set INKLING_PACKAGED_APP)
npm run test:smoke:fake   # the real-Gemini smoke test, run against the local fake (no key needed)
npm run test:live         # optional: handwriting scenarios against a REAL local model in Ollama
npm run test:live:app     # optional: the full on-page correction workflow in the app with a REAL local model
npm run test:live:cloud   # optional: the handwriting scenarios against the REAL cloud model (spends free allowance)
```

Automated tests never call a model. The local-AI suite (`tests/e2e/ollama.e2e.mjs`) runs against a fake of the Ollama API (`tests/support/fakeOllama.mjs`: version, tags, show/capabilities, NDJSON chat streaming, its error bodies). The Gemini suites run the official `@google/genai` SDK against a local fake of the Gemini REST API (`tests/support/fakeGemini.mjs`), which speaks the same wire format (SSE streaming, `x-goog-api-key`, Google's error bodies). Both fakes record every request, including images and structured-output schemas. The cloud-beta suites (`tests/unit/beta.test.ts`, `tests/e2e/cloud.e2e.mjs`) run the real beta server code (`beta-server/src/`, bundled on the fly by `tests/support/fakeBeta.mjs`) on a local port in front of a fake Workers AI model that speaks its OpenAI-style streaming format and reports token usage.

### Live local-model tests (optional)

With Ollama running and a model installed (`ollama pull qwen3-vl:4b-instruct`):

- `npm run test:live` sends the handwriting scenarios through Inkling's own AI service with the exact images the app sends (`tests/fixtures/handwriting/`): **A** x² + 5x + 6 = 0 factorised correctly but solved as x = 2, 3 (should be −2, −3); **B** a correct linear equation; **C** a free-body diagram; **D** a question about a note; **E** a question about PDF text; and practice problems with answer checking. Each check (reading, correctness, streaming, schema validation) is recorded with its timing in `test-results/live-ollama-<model>.md`; a wrong answer is reported, not hidden.
- `npm run build && npm run test:live:app` does the whole on-page workflow in the app: write scenario A, ask, *Show this on my page*, preview, approve, undo, redo and edit, writing `test-results/live-app-<model>.md` and screenshots.

Set `INKLING_LIVE_MODEL=qwen3-vl:2b-instruct` (or any installed vision model) to test another model. Both skip when Ollama or the model isn't there. The fixture images are drawn with the test suite's pen-stroke font, so they are clean; real student handwriting should also be tried by hand (see [`windows-validation.md`](windows-validation.md)).

### Real Gemini smoke test (optional)

`tests/smoke/gemini.smoke.test.ts` checks a real key end to end through Inkling's own AI service: which of Inkling's models the key can use, a streamed chat answer and a follow-up that depends on it, cancelling an answer, a rejected key, reading and explaining the handwriting in `tests/fixtures/handwriting-linear.png` and turning Gemini's markup into valid canvas objects, and a practice set whose right and wrong answers Gemini checks. It sends about 11 small requests, paced to stay under the free tier's per-minute limits, so it takes a minute or two. It is skipped when no key is set.

Use a key from a Google Cloud project **without billing** (Google AI Studio creates one), so nothing can be charged. Don't paste the key into a command line that is saved to history:

```powershell
# Windows PowerShell
$env:GEMINI_API_KEY = Read-Host 'Gemini key'
npm run test:smoke
Remove-Item Env:GEMINI_API_KEY
```

```bash
# macOS / Linux
read -rs GEMINI_API_KEY && export GEMINI_API_KEY
npm run test:smoke
unset GEMINI_API_KEY
```

Set `GEMINI_MODEL=gemini-3.5-flash-lite` to test the lighter model. Both supported models are listed with a free tier on Google's pricing page, but what a given key can use is decided per project; the first test prints each model's availability for your key. In the app itself, the key goes in **Settings → AI Tutor**, where it is encrypted with the OS keychain; see *Real-Gemini checklist* below for the in-app flows to try.

### Real-Gemini checklist (in the app)

With a free-tier key saved in Settings → AI Tutor (the connection test should list your model as available):

1. **Chat** — ask "Solve 3x + 5 = 20" in the tutor; the answer should stream in with typeset maths. Ask "now double it" (expect 10). Ask something long and press Stop mid-answer. Then remove the key's last character in Settings and check you get the invalid-key message (restore it afterwards).
2. **Handwriting** — write `2x + 3 = 11`, `2x = 7`, `x = 3.5` on a page, lasso it, ✨ → *Check my work*. Note whether Gemini reads every line correctly and spots that 11 − 3 = 8.
3. **Practice** — Practice tab → easy, 2 problems, topic "linear equations". Reveal a hint, type a right answer and check it, then a wrong one.
4. **On-page corrections** — with the same selection, On Page tab → *Mark up my selection*. Check the preview sits on the right lines, untick one mark, *Add to my page*, then move one of the added marks, undo (Ctrl+Z) until they are gone and redo (Ctrl+Shift+Z).

Each step is one or two requests, well inside the free per-minute limits.

## Continuous integration

- **CI** (`.github/workflows/ci.yml`) runs the typecheck, unit tests, the production build and the AI server's typecheck and bundle on every push to `main` and on every pull request.
- **Release** (`.github/workflows/release.yml`) builds the Windows and macOS installers on real GitHub-hosted Windows and macOS machines and runs every acceptance suite there, plus a packaged-app smoke test and an install → update → uninstall → reinstall check. See [RELEASING.md](RELEASING.md).
- **Download site** (`.github/workflows/pages.yml`) rebuilds the download page from the newest approved release. See [maintainers/DOWNLOAD-SITE.md](maintainers/DOWNLOAD-SITE.md).

On a headless Linux machine run the e2e suite under a virtual display: `xvfb-run -a npm run test:e2e`. Each run uses a fresh temporary data folder and writes screenshots to `test-results/` (override with `SHOTS=…`).

