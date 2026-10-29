# Inkling

An AI-native handwriting notebook for the desktop, built with Electron, React and TypeScript. Think GoodNotes-style ink, plus notebook organisation, plus an AI tutor, running on Google Gemini's free tier, that reads your handwriting and writes corrections directly on your pages.

| Phase | Scope | Status |
|---|---|---|
| 1 | Library, pages, pen/highlighter/eraser, text, undo/redo, local auto-save | ✅ done |
| 2 | Lasso selection, shapes, images, zoom/pan, precise eraser, page sizes, typed command layer | ✅ done |
| 3 | Rich-text notes, search, links/backlinks, knowledge graph, PDF import/annotation/export | ✅ done |
| 4 | AI Tutor on Google Gemini (free tier): streaming chat about handwriting, practice mode, previewed corrections on the page | ✅ done |
| 5 | More providers (local Ollama vision models, OpenRouter, Anthropic Claude), handwriting search | planned |
| 6 | Packaging, installers, theming, accessibility pass | planned |

## Requirements

- Node.js **22.13 or later in the 22.x line, 24.x, or 26+** (Node 22 LTS or 24 LTS recommended), with the npm that ships with it. This is the strictest range among the toolchain: Electron 45 and `@electron/get` need ≥ 22.12, pdf.js needs ≥ 22.13, and Vitest 5 doesn't support the odd-numbered 23.x/25.x lines. `package.json` declares it under `engines`. Node 20 is not supported.
- Windows 10/11, macOS or Linux, with internet access during install (the Electron runtime is about 100 MB).

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

Notes are saved to the OS app-data folder (`%APPDATA%\Inkling\Library` on Windows, `~/Library/Application Support/Inkling/Library` on macOS). Set `INKLING_DATA_DIR` to use another folder. Settings → Storage shows the path.

## Testing

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # unit tests (vitest): storage, history, commands, geometry, eraser, viewport, migration, assets, notes/Markdown, search/links/graph, PDF export, assistant context
npm run build
npm run test:e2e    # drives the real Electron app with mouse input (Phase 1–4 and regression suites)
GEMINI_API_KEY=… npm run test:smoke   # optional: 4 small requests to the real Gemini API
```

Automated tests never call Google. They run the official `@google/genai` SDK against a local fake of the Gemini REST API (`tests/support/fakeGemini.mjs`), which speaks the same wire format (SSE streaming, `x-goog-api-key`, Google's error bodies) and records every request, including images and structured-output schemas. The optional smoke test (`tests/smoke/`) checks a real key end to end: connection test, a streamed answer, a markup of a handwriting image (`tests/fixtures/handwriting-linear.png`) turned into valid canvas commands, and a practice set. Set `GEMINI_MODEL=gemini-3.5-flash-lite` to try the lighter model. It is skipped when no key is set.

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

## AI Tutor (Google Gemini)

The tutor runs on Google's Gemini API through the official Gen AI SDK (`@google/genai`). It is designed to cost nothing within Gemini's free tier.

**Set up.**
1. Create a free API key in [Google AI Studio](https://aistudio.google.com/apikey). No billing is needed. To be sure you stay free, use a key from a Google Cloud project **without billing enabled**: Inkling can't see your project's billing, and Google charges for any project that has it.
2. Open Settings → AI Tutor, paste the key and press Save. Inkling runs a connection test: it lists the models your key can use and sends one tiny request. No notebook content is sent.
3. Choose a model: **Gemini 3.8 Flash** (default, best quality) or **Gemini 3.5 Flash-Lite** (lighter, more generous free limits). Models your key can't use are flagged.
4. The first time you ask something, Inkling asks permission to send notebook content to Google.

**Using it.**
| What | How |
|---|---|
| Ask about your handwriting | Lasso-select your work → ✨ on the selection toolbar (or Ask AI), then type a question. Answers stream in, with formulas typeset. Follow-up questions keep the conversation. |
| Quick actions | Give me a hint · Explain the concept · Check my work · Try a similar problem |
| Context | The composer shows what is included: your selection, or this page. Remove it to ask a general question. |
| Practice | Practice tab → difficulty, number of problems, optional topic. Reveal hints one at a time, check a typed answer or a handwritten one (select it), show the worked solution, or copy a problem onto the page. |
| Corrections on the page | On Page tab → *Mark up my selection*, or **Show this on my page** under a chat answer. Gemini proposes ✓/✗ marks, circles, underlines, corrections and notes. They are previewed on the page, you can untick any of them, and *Add to my page* inserts them as one undoable step. They are ordinary objects in a handwriting font (Caveat): move, edit or delete them like anything else. |

**Privacy.** On Gemini's free tier, Google may use what you send, and its answers, to improve its products, and human reviewers may read them ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). Don't send sensitive, confidential or personal information. Google requires API users to be 18 or older. Inkling sends only what you ask about: your question, and either a cropped image of the selected area or the current page's typed/PDF text plus an image of just its handwritten part. Nothing is sent before you agree and ask. You can withdraw permission in Settings.

**Free-tier protection.**
- Only free-tier models are offered. Inkling never switches model or tier on its own. When a model's daily quota runs out, it says so (quotas reset at midnight Pacific) and offers a one-click switch to the other free model.
- One request at a time, at most 8 per minute, and an accidental repeat of the same request within 10 seconds is refused. After a rate-limit or quota error, Inkling waits locally instead of retrying against the API.
- Images are cropped to the relevant area and sent as JPEG, at most 1024 px on the long edge. Conversations keep only the last five exchanges, with earlier answers shortened and at most one earlier image.
- Clear messages for an invalid key, rate limits, exhausted daily quota, models without free quota, unavailable models, network problems and blocked answers.

**Key storage.** The key lives only in the main process, encrypted with the operating system's keychain (Electron `safeStorage`) in the app's config folder (`gemini-key.bin`, next to `ai-settings.json`), never in your notebooks. The interface only ever sees its last four characters. On Linux without a keyring the key is saved with weak protection, and Settings says so. Where nothing can encrypt, it is kept in memory for the session only.

**Providers.** `src/main/ai/provider.ts` defines the small interface the tutor needs (`listModels`, `stream` with text and image parts and optional JSON-schema output). `src/main/ai/gemini.ts` implements it for Gemini. A local Ollama vision model (e.g. Qwen3-VL), OpenRouter or Anthropic Claude can be added as further implementations without changing the tutor or the UI.

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
    ai/         Provider interface, Gemini provider, AI service (consent, limits, streaming), key storage, task prompts
  preload/      Narrow window.inkling bridge (contextIsolation + sandbox)
  shared/       Data schemas (zod), factories, migrations, IPC contract, AI request/result schemas
  renderer/src/
    canvas/     Konva page canvas, command layer, geometry, ink, shapes, viewport, thumbnails
    components/ Toolbar, sidebar, page navigator, AI Tutor panel, library views
    ai/         Tutor chat, practice, markup (annotation planning + preview), context building, Markdown/KaTeX rendering
    store/      Zustand store: library, pages, history, selection, tools
    services/   Debounced save queue
tests/
  unit/         vitest
  e2e/          Playwright-driven Electron acceptance tests
  smoke/        Optional real-Gemini smoke test
  support/      Fake Gemini API server, test handwriting strokes
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

- Gemini is the only AI provider so far. Inkling can't tell whether your Google Cloud project has billing enabled. Use a key from a project without billing to be sure of no charges.
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
- No installer yet; `npm run build` produces the app for `npm start`. Packaging (electron-builder) is planned for Phase 6.
- Automated tests run on Linux. Windows and macOS have not been tested on real hardware yet, and stylus pressure, palm rejection and touch gestures have not been tested on physical pen or touch devices.
