# Inkling

An AI-native handwriting notebook for the desktop, built with Electron, React and TypeScript. Think GoodNotes-style ink, plus notebook organisation, plus (soon) an AI tutor that writes directly on your pages.

| Phase | Scope | Status |
|---|---|---|
| 1 | Library, pages, pen/highlighter/eraser, text, undo/redo, local auto-save | ✅ done |
| 2 | Lasso selection, shapes, images, zoom/pan, precise eraser, page sizes, typed command layer | ✅ done |
| 3 | Rich-text notes, search, links/backlinks, knowledge graph, PDF import/annotation/export | ✅ done |
| 4–5 | Claude-powered AI Tutor: chat, practice, edits on the page | planned (panel shown as "not connected") |
| 6 | Packaging, installers, theming, accessibility pass | planned |

## Requirements

- Node.js 20+ (developed on Node 22) and npm
- Windows 10/11, macOS or Linux. Electron's binary is downloaded by `npm install`.

## Install and run

```bash
npm install
npm run dev        # development, with hot reload
npm run build      # production build into out/
npm start          # run the production build
```

Notes are saved to the OS app-data folder (`%APPDATA%\Inkling\Library` on Windows, `~/Library/Application Support/Inkling/Library` on macOS). Set `INKLING_DATA_DIR` to use another folder. Settings → Storage shows the path.

## Testing

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # unit tests (vitest): storage, history, commands, geometry, eraser, viewport, migration, assets, notes/Markdown, search/links/graph, PDF export, assistant context
npm run build
npm run test:e2e    # drives the real Electron app with mouse input (Phase 1, 2, 3 and regression suites)
```

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

## Ready for the AI Tutor

`renderer/src/services/notebookContext.ts` is the only interface a future Claude integration needs. It keeps notebook access separate from any model or network code:

| Need | API |
|---|---|
| Read structured notes | `page(id)` → note JSON, plain text and Markdown (live link titles) |
| Read canvas pages | `page(id)` → typed objects, text boxes, PDF text |
| Search notebook text | `search(query, { notebookId })` |
| Linked notes | `connections(id)` → links, backlinks, related |
| Selected handwriting | `selection()` → the lasso-selected objects plus a PNG of that region as displayed (ink over paper or PDF), for a vision model |
| Create or modify content | `applyCanvasCommands(pageId, commands)`: typed, validated, tagged as AI-authored, one undo step; user content is refused unless `allowEditUserContent` is set. `appendToNote(id, markdown)` (sanitised) |
| Outline | `outline()` → every live page and note |

The acceptance tests exercise this API in the real app (`INKLING_TEST_HOOKS=1` exposes it to the test runner only).

## Architecture

```
src/
  main/         Electron main process: window, validated IPC, storage, image asset protocol
  preload/      Narrow window.inkling bridge (contextIsolation + sandbox)
  shared/       Data schemas (zod), factories, migrations, IPC contract
  renderer/src/
    canvas/     Konva page canvas, command layer, geometry, ink, shapes, viewport, thumbnails
    components/ Toolbar, sidebar, page navigator, AI Tutor panel, library views
    store/      Zustand store: library, pages, history, selection, tools
    services/   Debounced save queue
tests/
  unit/         vitest
  e2e/          Playwright-driven Electron acceptance tests
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

**Security.** Context isolation, sandboxed renderer, strict CSP, navigation blocked, every IPC call checks the sender and validates arguments, ids are validated before any path is built, and no filesystem or shell access is exposed to the renderer.

## Known limitations

- The AI Tutor is not connected yet (Phase 4). Audio recording and sharing are not built and are labelled as such in the UI.
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
