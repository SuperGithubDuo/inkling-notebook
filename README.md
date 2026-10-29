# Inkling

An AI-native handwriting notebook for the desktop, built with Electron, React and TypeScript. Think GoodNotes-style ink, plus notebook organisation, plus an AI tutor that reads your handwriting and writes corrections directly on your pages. For the beta, the tutor runs free in the cloud on Inkling's own small server ([`beta-server/`](beta-server/README.md), Cloudflare Workers AI with the Qwen 3.8 vision model): nothing to download, a personal access code, and a limited number of answers per day. It can also run free and privately on your own computer with [Ollama](https://ollama.com) and a Qwen3-VL vision model, and Google Gemini is an optional alternative for adults.

| Phase | Scope | Status |
|---|---|---|
| 1 | Library, pages, pen/highlighter/eraser, text, undo/redo, local auto-save | ✅ done |
| 2 | Lasso selection, shapes, images, zoom/pan, precise eraser, page sizes, typed command layer | ✅ done |
| 3 | Rich-text notes, search, links/backlinks, knowledge graph, PDF import/annotation/export | ✅ done |
| 4 | AI Tutor on Google Gemini (free tier): streaming chat about handwriting, practice mode, previewed corrections on the page | ✅ done |
| 4.6 | Local AI tutor on Ollama (default; Qwen3-VL), Gemini optional and 18+ only, narrow-window layout | ✅ done (live-model results: see *Local model results*) |
| 4.7 | Free cloud beta: Inkling beta server on Cloudflare Workers AI (Qwen 3.8 27B), per-tester daily allowances inside the free tier, Ollama and Gemini kept | ✅ built and tested against a fake model; live-model run pending (see *Cloud beta*) |
| 5 | Advanced AI editing on the canvas, more providers (OpenRouter, Anthropic Claude), handwriting search | planned |
| 4.8 | Beta release: installers (Windows NSIS, macOS DMG), updates, release workflow, data-safety fixes, daily backups/restore, welcome, About, feedback, privacy | ✅ built; installers and Windows/macOS runs pending the first workflow run (see [`docs/ROADMAP.md`](docs/ROADMAP.md)) |
| 6 | Signing and notarization, accessibility audit, website | planned |

## Download and install (users)

Testers install Inkling from the release page; no Node.js, npm or terminal needed. See [`docs/INSTALL.md`](docs/INSTALL.md). Release notes: [`RELEASE_NOTES.md`](RELEASE_NOTES.md). How installers are built, signed and published: [`docs/RELEASING.md`](docs/RELEASING.md).

## Requirements (development)

- Node.js **22.13 or later in the 22.x line, 24.x, or 26+** (Node 22 LTS or 24 LTS recommended), with the npm that ships with it. This is the strictest range among the toolchain: Electron 45 and `@electron/get` need ≥ 22.12, pdf.js needs ≥ 22.13, and Vitest 5 doesn't support the odd-numbered 23.x/25.x lines. `package.json` declares it under `engines`. Node 20 is not supported.
- Windows 10/11, macOS or Linux, with internet access during install (the Electron runtime is about 100 MB).
- For the AI Tutor, one of: a **beta access code** (cloud beta; nothing to install), or [Ollama](https://ollama.com/download) 0.12.7 or later and a vision model, e.g. `ollama pull qwen3-vl:4b-instruct` (3.3 GB download, ~5.5 GB of memory while answering). Inkling never installs or downloads these itself. A Gemini API key is the optional alternative (adults only).

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

Installers: `npm run dist:win` / `dist:mac` / `dist:linux` on that system (see [`docs/RELEASING.md`](docs/RELEASING.md)).

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

Set `INKLING_LIVE_MODEL=qwen3-vl:2b-instruct` (or any installed vision model) to test another model. Both skip when Ollama or the model isn't there. The fixture images are drawn with the test suite's pen-stroke font, so they are clean; real student handwriting should also be tried by hand (see `docs/windows-validation.md`). ### Real Gemini smoke test (optional)

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

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck, unit tests and production build on every push to `main` and on pull requests. The Electron acceptance tests need a display and are run locally.

On a headless Linux machine run the e2e suite under a virtual display: `xvfb-run -a npm run test:e2e`. Each run uses a fresh temporary data folder and writes screenshots to `test-results/` (override with `SHOTS=…`).

## Using the canvas

| Action | How |
|---|---|
| Pen / highlighter / eraser / text / lasso / shapes | Toolbar or bottom dock · keys `P` `H` `E` `T` `L` `S` |
| Pen thickness, highlighter size, eraser mode (whole stroke / precise) | The wave icon opens the contextual size popover |
| Shapes | Click the shape button again for line, arrow, rectangle, ellipse, circle, triangle and fill. Hold `Shift` for squares, circles and 45° lines |
| Straight pen line | Hold `Shift` while drawing |
| Select | Lasso around ink, or tap an object with the lasso. `Shift` adds to the selection. `Ctrl+A` selects all |
| Edit selection | Drag to move; corner handles resize; single images and shapes also get side handles and a rotation handle. The floating pill copies, cuts, duplicates and deletes. Picking a colour or thickness while a selection exists restyles it. Arrow keys nudge |
| Images | Image button, drag a file onto the page, or paste from the clipboard |
| Zoom | `Ctrl`+wheel or trackpad pinch (zooms at the pointer), two-finger pinch on touch screens, `Ctrl` `+`/`−`, `Ctrl+0` fit width, `Ctrl+9` whole page, or the zoom pill |
| Pan | Wheel or trackpad scroll, hand tool, hold `Space`, middle mouse button, two fingers on touch screens. With a stylus in use, one finger pans (palm rejection) |
| Stylus eraser | The pen's eraser end or eraser button erases whatever tool is active |
| Paper and page size | The "Grid" pill above the thumbnails: grid, lined, dotted, blank; A4 portrait/landscape, Letter, square, 16:9 |
| Undo / redo / save | `Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y`, `Ctrl+S` (auto-save runs anyway) |

## Rich-text notes

A notebook can mix handwritten pages and rich-text notes. Add a note with **Note** under the page thumbnails (or ⋯ → Add note). While a note is open, the top toolbar switches to formatting:

- Headings, bold, italic, underline, strikethrough and inline code. Markdown shortcuts work while typing (`# `, `- `, `1. `, `[ ] `, `**bold**`, `` `code` ``).
- Bulleted, numbered and check lists; quotes; code blocks; tables (row and column commands in the table menu).
- Formulas: `$x^2$` typed inline, or the Σ menu. Click a formula to edit its LaTeX with a live KaTeX preview.
- Links: select text and press `Ctrl+K`; `Ctrl`+click opens a link in the browser. Only `https`/`mailto` links are allowed.
- Images: insert button, paste or drop. They are stored in the notebook like canvas images.
- Title and `#tags` above the text.
- **Markdown**: ⋯ → *Import Markdown as note…* copies local images the file references into the notebook. The share button (or ⋯ → *Export note as Markdown…*) writes a `.md` file and puts its images in a `<name>_assets/` folder next to it.

## Search, links and backlinks

- **Search** (`Ctrl+F`, or *Search* at the top of the sidebar) runs as you type and covers:
  - note text, including formulas' LaTeX
  - page and note titles, `#tags` and notebook names
  - text boxes on handwritten pages
  - the titles of pages a note links to

  Matches are highlighted in titles and excerpts, `↑`/`↓`/`Enter` open a result, and a menu limits search to one notebook. Search ignores case and accents. **Handwritten ink is not searchable**: there is no handwriting recognition yet.
- **Links**: in a note, type `[[` (or use the *Link to a page* button) to pick any page or note. Links store the target's permanent id and always show its current title, so renaming notes or notebooks never breaks them. In Markdown they export as portable `[Title](inkling://page/<id>)` links and import back as live links.
- **Backlinks**: every note ends with *Links to*, *Linked from* and *Related* (shared tags, or pages two links away). A handwritten page that is linked from somewhere shows a backlinks pill in its top-left corner.

## Knowledge graph

**Graph** in the sidebar shows every page and note as a node, with internal links as arrows. Circles are notes, squares are handwritten pages, and colour is the notebook. Groups of linked pages are shaded as clusters, and unlinked pages sit on an outer ring (they can be hidden).

- Hover or click a node to highlight it, its links and its connected pages; the side card lists them.
- Double-click a node, press `Enter`, or use **Open** to open the page.
- Drag or scroll to pan; `Ctrl`+scroll or the zoom pill zooms; the notebook menu filters the graph.

The data comes from the link index (`graph()`), and the layout is a d3-force simulation run to rest up front, so the same data always draws the same way.

## PDFs

- **Import**: *Import* under the page thumbnails (or ⋯ → *Import PDF…*) adds one page per PDF page after the current page.
  - The PDF file is stored unchanged in the notebook folder.
  - Each page keeps the PDF's exact size, and its embedded text is extracted for search.
- **Read and annotate**: PDF pages work like any handwritten page: pen, highlighter, eraser, lasso, shapes, text, images, zoom and pan.
  - pdf.js draws the PDF underneath at the current zoom, so text stays sharp. On very large zooms only the visible part is rendered.
  - Annotations are ordinary editable objects stored in the page's JSON, separate from the PDF. They stay aligned at every zoom because both use page coordinates.
- **Export**: ⋯ → *Export notebook as PDF…* writes the notebook's handwritten and PDF pages to one PDF.
  - PDF pages are copied from the original file unchanged; nothing is rasterised.
  - Annotations are drawn on top as vectors and real text. Highlighter uses a multiply blend, and images are embedded.
  - Handwritten pages get their paper as fine lines.
  - Rich-text notes are not included (export them as Markdown).

## AI Tutor

The tutor answers through one of three providers, chosen in Settings → AI Tutor. All use the same instructions, structured-output schemas, validation and canvas commands; only the transport differs (`src/main/ai/cloud.ts`, `src/main/ai/ollama.ts`, `src/main/ai/gemini.ts`).

### Cloud beta (default in beta builds)

For beta testers: free, nothing to download, no account. Answers come from **Qwen 3.8 27B** (`@cf/qwen/qwen3.8-27b`, Apache-2.0, with vision) on Cloudflare Workers AI, through Inkling's own small server (a Cloudflare Worker in [`beta-server/`](beta-server/README.md)).

**Set up (testers).** The Inkling team sends you an access code (`ink_…`). Open Settings → AI Tutor → **Inkling beta**, paste it and press Save. Inkling checks it with the server before saving, and shows your name and today's allowance. A beta build has the server address built in; otherwise you also paste the address you were given. The first time you ask, Inkling asks permission to send notebook content to the beta server.

**It's free, and limited.** Cloudflare gives each account 10,000 *Neurons* a day of Workers AI, reset at midnight UTC. On its Workers Free plan, usage beyond that is refused, never billed. The beta server divides that allowance:
- Each tester has a daily allowance, 900 Neurons by default, about 6 typical answers. The panel shows roughly how many answers are left.
- The whole beta stops at 9,000 Neurons a day, before Cloudflare's own limit.
- When either runs out, the tutor says so plainly and offers a one-click switch to the local Ollama tutor. Inkling never switches by itself and never moves to paid usage.

See *Cloud beta results* for what a typical interaction costs.

**What is sent and kept.** The same as for any provider: your question, and an image of your selection or the page's typed/PDF text plus an image of its handwriting. The app sends only the task and the conversation; the server adds Inkling's instructions and limits, so an access code can't be used for anything but the tutor. Cloudflare says it [does not use Workers AI content to train models and does not keep it after answering](https://developers.cloudflare.com/workers-ai/platform/privacy/). The beta server keeps only usage counts per access code, never content. The access code is stored encrypted with the OS keychain (`beta-access.bin`), like a Gemini key. There is no Cloudflare API token in the app or the server: the server reaches Workers AI through its built-in binding.

Running the server (deploying, adding testers, limits) is described in [`beta-server/README.md`](beta-server/README.md).

### Local: Ollama (default in regular builds)

A vision model runs on your own computer through [Ollama](https://ollama.com). It's free, needs no account or key, has no usage limits, and nothing leaves the computer: Inkling only talks to Ollama on `127.0.0.1:11434` and refuses any other address.

**Set up.**
1. Install Ollama from [ollama.com/download](https://ollama.com/download) and open it.
2. Install a vision model in a terminal (a one-time download):

   | Model | Command | Download | Use |
   |---|---|---|---|
   | Qwen3-VL 4B (recommended) | `ollama pull qwen3-vl:4b-instruct` | 3.3 GB | needs ~5.5 GB free memory: 16 GB computers, or 8 GB with little else open |
   | Qwen3-VL 2B | `ollama pull qwen3-vl:2b-instruct` | 1.9 GB | 8 GB computers; faster, less reliable markups |
   | Qwen3-VL 8B | `ollama pull qwen3-vl:8b-instruct` | 6.2 GB | most capable; ~16 GB RAM or a GPU with 8 GB |

   Use the `-instruct` builds. The plain tags (`qwen3-vl:4b`, `:2b`, `:8b`) are Qwen3-VL's *thinking* builds: they write a long chain of reasoning before every answer, and Ollama (0.40) doesn't let Inkling switch that off. On a 2-core CPU test machine, with the same image and question, the 2B thinking build took 338 s to reach a correct answer (about 900 reasoning tokens first); the 2B instruct build gave a correct answer in 104 s. They still work if installed (listed as "thinking", with extra token budget for the reasoning), just slowly.

3. Settings → AI Tutor shows whether Ollama is running, which models are installed (other installed vision models are listed too; text-only models are not), the command for a model you picked but haven't installed, and a connection test that loads the model. Inkling never downloads models or installs software itself.

Answers take longer than with a cloud model, especially the first one while the model loads into memory, and depend on your hardware. Inkling asks thinking builds not to reason at length (and leaves them room when they do), shows how long an answer has been running, gives a model up to 4 minutes to load and start answering, and suggests the 2B model if a larger one runs out of memory or is too slow. Qwen3-VL marks up work with boxes in its own format (`[x1, y1, x2, y2]` on 0–1000), which Inkling converts before validating.

### Optional: Google Gemini (18+ only)

Google's Gemini API terms require users to be 18 or older and don't allow it in apps likely to be used by under-18s, so Inkling, a student notebook, does not rely on it: it is off unless chosen, marked 18+, and its consent asks you to confirm your age. It runs through the official Gen AI SDK (`@google/genai`) and is designed to cost nothing within Gemini's free tier.

**Set up.**
1. Create a free API key in [Google AI Studio](https://aistudio.google.com/apikey). No billing is needed. To be sure you stay free, use a key from a Google Cloud project **without billing enabled**: Inkling can't see your project's billing, and Google charges for any project that has it.
2. Open Settings → AI Tutor, choose **Google Gemini**, paste the key and press Save. Inkling runs a connection test: it lists the models your key can use and sends one tiny request. No notebook content is sent.
3. Choose a model: **Gemini 3.8 Flash** (default, best quality) or **Gemini 3.5 Flash-Lite** (lighter, more generous free limits). Models your key can't use are flagged.
4. The first time you ask something, Inkling asks you to confirm you are 18 or older and agree to send notebook content to Google.

### Using the tutor

| What | How |
|---|---|
| Ask about your handwriting | Lasso-select your work → ✨ on the selection toolbar (or Ask AI), then type a question. Answers stream in, with formulas typeset. Follow-up questions keep the conversation. |
| Quick actions | Give me a hint · Explain the concept · Check my work · Try a similar problem |
| Context | The composer shows what is included: your selection, or this page. Remove it to ask a general question. |
| Practice | Practice tab → difficulty, number of problems, optional topic. Reveal hints one at a time, check a typed answer or a handwritten one (select it), show the worked solution, or copy a problem onto the page. |
| Corrections on the page | On Page tab → *Mark up my selection*, or **Show this on my page** under a chat answer. The tutor proposes ✓/✗ marks, circles, underlines, corrections and notes. They are previewed on the page, you can untick any of them, and *Add to my page* inserts them as one undoable step. They are ordinary objects in a handwriting font (Caveat): move, edit or delete them like anything else. |

### Privacy, Gemini limits and keys

**Privacy.** With Ollama, nothing leaves your computer. On Gemini's free tier, Google may use what you send, and its answers, to improve its products, and human reviewers may read them ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). Don't send sensitive, confidential or personal information. Google requires API users to be 18 or older. Inkling sends only what you ask about: your question, and either a cropped image of the selected area or the current page's typed/PDF text plus an image of just its handwritten part. Nothing is sent before you agree and ask. You can withdraw permission in Settings.

**Free-tier protection (Gemini).**
- Only free-tier models are offered. Inkling never switches model or tier on its own. When a model's daily quota runs out, it says so (quotas reset at midnight Pacific) and offers a one-click switch to the other free model.
- One request at a time, at most 8 per minute, and an accidental repeat of the same request within 10 seconds is refused. After a rate-limit or quota error, Inkling waits locally instead of retrying against the API.
- Images are cropped to the relevant area and sent as JPEG, at most 1024 px on the long edge. Conversations keep only the last five exchanges, with earlier answers shortened and at most one earlier image.
- Clear messages for an invalid key, rate limits, exhausted daily quota, models without free quota, unavailable models, network problems and blocked answers.

**Key storage (Gemini).** The key lives only in the main process, encrypted with the operating system's keychain (Electron `safeStorage`) in the app's config folder (`gemini-key.bin`, next to `ai-settings.json`), never in your notebooks. The interface only ever sees its last four characters. On Linux without a keyring the key is saved with weak protection, and Settings says so. Where nothing can encrypt, it is kept in memory for the session only.

**Providers.** `src/main/ai/provider.ts` defines the small interface the tutor needs (`listModels`, `stream` with text and image parts and optional JSON-schema output). `src/main/ai/cloud.ts`, `src/main/ai/ollama.ts` and `src/main/ai/gemini.ts` implement it; `src/main/ai/service.ts` applies consent, pacing and validation per provider. OpenRouter or Anthropic Claude can be added the same way without changing the tutor or the UI.

### Local model results

<!-- local-model-results -->
Measured with real models in Ollama 0.40.13 on a slow machine (2 CPU cores, 8 GB RAM, no GPU); full answers, timings and screenshots in [`docs/live-results/`](docs/live-results/README.md).

- **Qwen3-VL 4B instruct** read every handwriting scenario correctly: it found the sign mistake in x² + 5x + 6 = 0 (roots −2, −3) and put a ✗ and the correction on the right line, recognised correct work, named all four forces in a free-body diagram, and answered from a note and a PDF. In the app, the whole workflow worked: streamed answer, previewed proposal, approval, editable AI objects, undo/redo.
- **Qwen3-VL 2B instruct** was right in every chat answer except missing the weight in the diagram, and completed the app workflow, but its own markups were less reliable: once it marked the wrong work as correct.
- All structured answers validated. On this machine the first words of an answer about an image took 75–145 s; text-only questions 3–7 s.
- **Memory:** 4B peaks at about 5.5 GB and was killed by the OS four times in testing (out of about 30 requests) when other programs, or the app itself, also needed memory; the app explained it and left the page unchanged. Use 2B on 8 GB computers.
<!-- /local-model-results -->

### Cloud beta results

<!-- cloud-beta-results -->
**Not yet measured against the real model.** The cloud-beta code is tested end to end against the real server code with a fake model (unit and Electron acceptance tests), but this development environment cannot reach Cloudflare. `npm run test:live:cloud` runs the same handwriting scenarios against the real model and writes a report with each answer's correctness, latency, tokens and Neurons. It can run against the deployed server, or run the server code locally against the Workers AI REST API.

Until then, the expected cost per interaction is estimated from Cloudflare's published rates for the model (40,909 Neurons per million input tokens and 290,909 per million output tokens) and the token counts measured for the same scenarios with Qwen3-VL 4B, which uses the same tokenizer family:

| Interaction | Tokens in / out | Neurons |
|---|---|---|
| Question about a handwriting selection | ~1,300 / ~250 | ~125 |
| Question about a note or PDF text | ~350 / ~200 | ~70 |
| On-page markup (with schema in the instructions) | ~1,700 / ~270 | ~150 |
| Answer check | ~500 / ~120 | ~55 |
| Practice set (3 problems) | ~600 / ~900 | ~285 |

A typical mix (60% questions, 25% markups, 10% checks, 5% practice sets) costs about **120 Neurons an interaction**. That makes about **75 interactions a day for the whole beta** under the 9,000 cap: for example 10 testers × 7, or 25 testers × 3. This assumes the model's hidden reasoning stays short with `reasoning_effort: low` and thinking off. If it doesn't, output tokens and costs rise, which is what the live run will show.
<!-- /cloud-beta-results -->

## Notebook context API

`renderer/src/services/notebookContext.ts` is how the tutor reads and writes the notebook. It keeps notebook access separate from any model or network code:

| Need | API |
|---|---|
| Read structured notes | `page(id)` → note JSON, plain text and Markdown (live link titles) |
| Read canvas pages | `page(id)` → typed objects, text boxes, PDF text |
| Search notebook text | `search(query, { notebookId })` |
| Linked notes | `connections(id)` → links, backlinks, related |
| Selected handwriting | `selection()` → the lasso-selected objects, their bounds, and a PNG of that region as displayed (ink over paper or PDF) with its exact page rectangle |
| Create or modify content | `applyCanvasCommands(pageId, commands)`: typed, validated, tagged as AI-authored, one undo step; user content is refused unless `allowEditUserContent` is set. `appendToNote(id, markdown)` (sanitised) |
| Outline | `outline()` → every live page and note |

The acceptance tests exercise this API in the real app (`INKLING_TEST_HOOKS=1` exposes it to the test runner only).

## Architecture

```
src/
  main/         Electron main process: window, validated IPC, storage, image asset protocol
    ai/         Provider interface, cloud beta, Ollama and Gemini providers, AI service (consent, limits, streaming), key storage, task prompts
  preload/      Narrow window.inkling bridge (contextIsolation + sandbox)
  shared/       Data schemas (zod), factories, migrations, IPC contract, AI request/result schemas
  renderer/src/
    canvas/     Konva page canvas, command layer, geometry, ink, shapes, viewport, thumbnails
    components/ Toolbar, sidebar, page navigator, AI Tutor panel, library views
    ai/         Tutor chat, practice, markup (annotation planning + preview), context building, Markdown/KaTeX rendering
    store/      Zustand store: library, pages, history, selection, tools
    services/   Debounced save queue
beta-server/    Cloudflare Worker for the free cloud beta: access codes, daily allowance ledger (Durable Object), Workers AI streaming
tests/
  unit/         vitest
  e2e/          Playwright-driven Electron acceptance tests
  smoke/        Optional real-Gemini smoke test
  live/         Optional real-model tests (Ollama, cloud beta), shared handwriting scenarios
  support/      Fake Gemini, Ollama and Workers AI servers, the beta server harness, test handwriting strokes
```

**Source of truth.** Each page is versioned JSON (`schemaVersion` 3): an ordered list of vector objects — strokes (every point, with real pressure only when a stylus supplied it), text boxes, shapes and images — in page coordinates. Nothing is flattened to a bitmap. Paper is a page setting, never baked into content. Older files are migrated in memory on load (`shared/migrate.ts`).

Notes are stored separately, in `notebooks/<id>/notes/<pageId>.json` (`schemaVersion` 1). The `doc` field holds the editor's ProseMirror JSON, which keeps tables, task state and formulas without loss. Markdown is an import/export format, not the storage format. In `library.json` (`schemaVersion` 2, upgraded automatically from v1), every page has a `kind` (`canvas` or `note`), a `title` and `tags`. Handwritten pages are never converted into notes.

The editor is TipTap 3 (ProseMirror, MIT) with KaTeX (MIT) for math and TipTap's Markdown extension (MIT). One extension list (`renderer/src/notes/extensions.ts`) serves both the live editor and the headless Markdown converter, so both always agree on the schema. Imported Markdown passes through `sanitizeNoteDoc`, which removes `javascript:`-style links and images.

**Storage.** `src/main/storage.ts` writes atomically (temp file → fsync → rename), keeps the previous version as `.bak` and falls back to it automatically, and refuses to overwrite a file another program changed: your version goes to a `.conflict-<time>.json` copy and the app tells you. Images are copied into `notebooks/<id>/assets/` under a random name after their format is checked from the file bytes, and pages reference them by that name. The renderer reads them through a read-only `inkling-asset://` scheme. Original file paths and temporary browser URLs are never stored.

**Search index.** `src/main/searchIndex.ts` keeps an in-memory index in the main process. At startup it reads every page and note once, then updates on every save, load and delete. Titles, tags and trash state come from the live library at query time, so renames, deletes and restores apply immediately. The same index answers `connections(pageId)` (links, backlinks, related) and `graph()` (nodes, edges, clusters). It is pure TypeScript with no Electron dependency, and unit-tested.

**PDF.** pdf.js (Apache-2.0) renders pages in a background worker. Its fonts, CMaps and decoders are served through the read-only `inkling-asset://pdfjs/` scheme, so the strict CSP stays in place (pdf.js 6 needs no `eval`). Export uses pdf-lib (MIT) with fontkit for text: original pages are copied with `copyPages`, and annotations are drawn into the page's displayed coordinate space, which honours `/Rotate` and the crop box. Page files are `schemaVersion` 3, adding an optional `background` (`{ type: 'pdf', asset, page, width, height, text }`). v1/v2 files migrate automatically.

**Command layer (ready for the AI Tutor).** All page edits go through typed, zod-validated commands in `renderer/src/canvas/commands.ts`:

`createStroke` · `createShape` · `createText` · `createImage` · `updateObject` · `deleteObjects` · `moveObjects` · `resizeObjects` · `transformObjects` · `duplicateObjects` · `selectObjects`

A batch is validated against the current page (ids must exist, results must pass the page schema) and becomes **one undoable transaction**. If any command is invalid, nothing changes. The pen, eraser, lasso, shape tool, menus and shortcuts all use this same path through `useStore.getState().run(commands, { label, context })`. AI-authored commands use `context: { author: 'ai' }`. They are tagged as AI content, must stay on the page, and cannot modify the user's own objects unless `allowEditUserContent` is granted. Example:

```ts
useStore.getState().run(
  [
    { type: 'createShape', shape: { kind: 'ellipse', x: 400, y: 300, width: 220, height: 70, color: '#e5484d', strokeWidth: 3 } },
    { type: 'createShape', shape: { kind: 'arrow', x: 700, y: 280, width: -70, height: 40, color: '#e5484d', strokeWidth: 3 } },
    { type: 'createText', text: { x: 720, y: 250, text: 'Check the signs!', color: '#e5484d', font: 'hand' } }
  ],
  { label: 'AI correction', context: { author: 'ai' } }
)
```

**Rendering.** Konva (MIT) draws the page under a camera (scale + offset). perfect-freehand (MIT) turns input points into ink outlines. In-progress strokes, lassos and shape drags are drawn imperatively on their own layer, so pointer moves never re-render React. Coalesced pointer events are used for accuracy, and predicted events shorten perceived latency (never saved). tldraw was considered but its SDK licence requires a paid key or watermark in production.

**AI requests.** The renderer builds a request (`task` + conversation turns with text and image parts). The main process validates it (sizes, image count, roles), picks the instructions and JSON schema for the task (`main/ai/prompts.ts`), applies consent, key, model and rate limits, and streams events back over IPC. Structured answers (practice sets, answer checks, page markup) are validated against zod schemas (`shared/tutor.ts`) in both processes. Notebook text sent to the model is wrapped in tags and the instructions tell the model to treat it as data. Markup proposals use Gemini's `box_2d` convention (0–1000 over the image), mapped back to page coordinates and turned into canvas commands by `renderer/src/ai/annotate.ts`. Each mark is validated by the command layer as AI content before it is previewed. Answers are rendered from Markdown tokens to React elements (no HTML from the model is injected) with KaTeX for maths.

**Security.** Context isolation, sandboxed renderer, strict CSP, navigation blocked, every IPC call checks the sender and validates arguments, ids are validated before any path is built, and no filesystem or shell access is exposed to the renderer.

## Known limitations

- The cloud beta's free allowance is small: about 75 typical interactions a day for all testers together (estimated; see *Cloud beta results*). It is shared through one Cloudflare account and resets at midnight UTC, which is the afternoon or evening in the Americas. The live-model run that measures real costs, quality and speed is still to be done.
- The cloud beta's model has no JSON mode on Workers AI, so practice sets, answer checks and markups rely on the instructions plus Inkling's validation: an answer in the wrong format is rejected with "Try again" and still costs allowance.
- The beta server can only declare, not verify, that its Cloudflare account is on the Workers Free plan (`ACCOUNT_PLAN`). On a Workers Paid account, usage beyond the free allowance would be billed, though the server's own cap still stops at 9,000 Neurons a day.
- The local tutor's quality and speed depend on the model and the computer. Small models (2B) misread handwriting more often; see *Local model results* for what has actually been measured.
- Gemini is for adults only (Google's terms). Inkling can't tell whether your Google Cloud project has billing enabled. Use a key from a project without billing to be sure of no charges.
- Tutor conversations last for the session only and are not saved with the notebook.
- The tutor reads handwriting from images, so its reading depends on legibility. "What the tutor read" in the On Page tab shows what it saw.
- Live tests against the real Gemini API are optional and need your own key. Free-tier limits are set by Google per project and may change.
- AI notes in the PDF export use Caveat when it has every character, and otherwise fall back to Inter. Some maths symbols (e.g. √) may then be missing in the PDF.
- Audio recording and sharing are not built and are labelled as such in the UI.
- Rotation is available for single images and shapes; strokes and text boxes move and scale but don't rotate.
- Canvas text boxes are plain text. Rich text and formulas live in notes.
- Note images are referenced by notebook. A note image pasted into another notebook still points at its original notebook (canvas paste copies the file).
- Remote (`https`) images in notes are blocked by the content security policy and appear broken; import local images instead.
- Image and PDF assets are never garbage-collected when the pages using them are deleted (safe, but uses disk space).
- Handwriting is not searchable or readable as text (no handwriting recognition yet). PDF pages without embedded text (scans) are not searchable either; there is no OCR.
- PDF links, form fields and text selection are not interactive inside Inkling.
- Highlights exported to PNG are blended normally, not multiplied, over PDF content (PDF export uses a true multiply blend).
- Very large PDFs import page by page with a progress notice; a 500-page PDF creates 500 page files.
- Installers are not yet code-signed: Windows and macOS show a security prompt on first open, and macOS can't install updates in-app (Inkling links to the release instead). See `docs/RELEASING.md`.
- The Windows and macOS installers and acceptance runs are set up in `.github/workflows/release.yml` but haven't run yet; everything else here was verified on Linux. Real pens, touch screens and display scaling have not been tested (`docs/DEVICE-TESTING.md`).
- Automated tests run on Linux in CI. Windows 11 was tested once by independent QA at Phase 4 (see the Phase 4.5 notes below); macOS has not been tested on real hardware, and stylus pressure, palm rejection and touch gestures have not been tested on physical pen or touch devices.
- In windows narrower than about 1180 px some toolbar buttons fold away (they all have shortcuts or Markdown input rules), and the AI Tutor button shows only its icon. The notebook title is shortened at the minimum width (960 px).
- The production build still warns about chunks over 500 kB: the main renderer chunk (1.7 MB minified: React, Konva, Tiptap, KaTeX) and the on-demand PDF export chunk. pdf.js and the export code load only when first used.

### Phase 4.5 notes (Windows stabilisation)

- **Clean install** — Electron 45 stopped downloading its binary on install; `postinstall` now does it (see *Install and run*).
- **PDF unit tests on Windows** — the tests passed pdf.js a backslash path for its fonts; they now use a forward-slash path with a trailing `/` (`tests/support/pdfjsData.mjs`). App code was not affected.
- **Intermittent resize failure** ("opposite corner fixed", seen once on Windows) — not reproduced: 25 normal and 10 CPU-starved runs on Linux, plus probes with 125–175 % display scaling, a window resize mid-drag and the pointer thrown past the opposite corner, all kept the corner within 0.003 page units (tolerance 1.5). The test now waits for the specific edit to reach disk and confirms the handle is under the pointer before dragging, and reports the full geometry and a screenshot if it fails again; it then passed 20 of 20 runs on Linux. Repeated runs on Windows (`npm run test:e2e:phase2`, ideally 20×) are still needed to close this out.
- **Narrow windows** — fixed in the local-AI milestone: less-needed controls fold away instead of overlapping; `tests/e2e/layout.e2e.mjs` checks seven window sizes from 960×600.
- **Real Gemini** — not yet run against Google's API in this milestone (no key was configured in the test environment). Run the smoke test above, then try the four flows in the app.
