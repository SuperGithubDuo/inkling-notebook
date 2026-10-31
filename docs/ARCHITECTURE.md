# Inkling architecture

How Inkling is put together, for contributors. See also [Developing Inkling](DEVELOPMENT.md) and [AI providers](AI-PROVIDERS.md).

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
beta-server/    Cloudflare Worker for the free cloud AI: anonymous daily allowance ledger (Durable Object), Workers AI streaming
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
