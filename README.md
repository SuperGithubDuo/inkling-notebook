# Inkling

An AI-native handwriting notebook for the desktop (Electron + React + TypeScript).

**Status: Phase 1 complete** — library, pages, ink canvas, text, undo/redo and local auto-save work and are covered by tests. The AI Tutor panel is present but not connected (Phase 4).

## Run

```bash
npm install
npm run dev          # development with hot reload
npm run build        # production build into out/
npm start            # run the production build
npm run typecheck
npm test             # unit tests (storage, history, eraser geometry, ink)
xvfb-run -a npm run test:e2e   # (after build) drives the real app; drop xvfb-run on a desktop
```

Data lives in the OS app-data folder (`%APPDATA%/Inkling/Library` on Windows); set `INKLING_DATA_DIR` to override. Settings → Storage shows the path.

## Architecture

| Area | Where | Notes |
|---|---|---|
| Main process | `src/main/` | Window, secure IPC, storage. Every IPC call checks the sender and validates arguments with zod. |
| Storage | `src/main/storage.ts` | Versioned JSON. Atomic writes (temp → fsync → rename), `.bak` of the previous version with automatic fallback, conflict copies when a file was changed by another program. |
| Preload | `src/preload/` | Exposes a narrow `window.inkling` API. No filesystem or shell access in the renderer. |
| Shared model | `src/shared/schema.ts` | Page = ordered list of vector objects (strokes keep every point, pressure flag, colour, size). Never flattened to images. |
| Canvas | `src/renderer/src/canvas/` | Konva for rendering, perfect-freehand for ink outlines. Live strokes are drawn imperatively on their own layer, so pointer moves never re-render React. |
| History | `canvas/history.ts` | Every edit is a reversible transaction (add/remove/update with layer indices). Future AI edits will use the same path, so they are undoable in one step. |
| State | `src/renderer/src/store/store.ts` | Zustand. Edits mark pages dirty; `services/saveQueue.ts` debounces saves and flushes on Ctrl+S and window close. |

**Why Konva + perfect-freehand (both MIT)?** tldraw is the most complete option but its SDK licence requires a paid licence or a watermark for production use. Fabric.js is comparable to Konva but heavier. Konva gives an editable object scene graph plus a Transformer for Phase 2 selection, while our own JSON model stays the source of truth — which is what lets the AI later emit validated, typed commands rather than touching a library's internals.

## Shortcuts

P pen · H highlighter · E eraser · T text · Esc back to pen · Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) · Ctrl+S save now · Ctrl+F search notebooks · Ctrl+Enter new page · PageUp/PageDown change page

## Not yet implemented (shown as unavailable in the UI)

Lasso, shapes, images, audio, pan/zoom (Phase 2) · folders, rich-text notes, full-text search, links, graph, PDF (Phase 3) · AI Tutor connection (Phase 4–5) · sharing · packaged installers (Phase 6).
