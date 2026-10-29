# Windows validation checklist (Hermes)

For the local-AI milestone. Everything here has passed on Linux (CI and a Linux
workstation with a virtual display); **none of it has run on Windows yet**. Please
record pass/fail and paste the output or screenshot for every step, and don't skip
a failing step: note it and carry on.

Machine notes to record first: Windows version, CPU, RAM, GPU (if any), display
scaling (100/125/150 %), Node version (`node -v`), npm version, Ollama version.

## 0. Prerequisites

- Node.js 22.13+ (22 LTS) or 24 LTS. Node 20, 23 and 25 are not supported.
- Git, and about 6 GB free disk (Electron ~100 MB, a model 2–6 GB).
- [Ollama for Windows](https://ollama.com/download), installed and opened (tray icon).

## 1. Fresh install

```powershell
git clone https://github.com/SuperGithubDuo/inkling-notebook
cd inkling-notebook
npm ci
```

- [ ] `npm ci` finishes without errors. The log shows `inkling@0.1.0 postinstall` and Electron's download (no warning saying it could not download).
- [ ] `node_modules\electron\path.txt` contains `electron.exe`, and `node_modules\electron\dist\electron.exe` exists. **No** manual `node node_modules/electron/install.js` was needed.

## 2. Build, launch and unit tests

```powershell
npm run typecheck
npm test
npm run build
npm start
```

- [ ] Typecheck: no errors.
- [ ] Unit tests: all pass (147 at the time of writing), **including `tests/unit/pdf.test.ts`** with no path edits.
- [ ] Build succeeds (a "chunks larger than 500 kB" warning is expected).
- [ ] `npm start` opens Inkling normally; the window can be resized down to its minimum (960×600).

## 3. Acceptance suites

```powershell
npm run test:e2e
```

Runs Phase 1, Phase 2, regressions, Phase 3, Phase 4 (Gemini, against a fake), local AI (Ollama, against a fake) and layout.

- [ ] Every suite ends with PASS / "all checks passed". Note which, if any, fail and attach `test-results\*-failure.png`.
- [ ] The Ollama suite does not touch a real Ollama (it uses its own fake), so running it with Ollama open is fine.

## 4. Phase 2 lasso resize, repeated

```powershell
for ($i = 1; $i -le 20; $i++) { npm run test:e2e:phase2 > "phase2-run-$i.log" 2>&1; "run $i exit $LASTEXITCODE" }
```

- [ ] Count of passes out of 20: ____.
- [ ] For any failure: attach the log (the assertion now prints both bounding boxes, the scale and the pixels-per-unit) and `test-results\phase2-resize-corner-failure.png`.
- [ ] Try 5 more runs at 125 % or 150 % display scaling if the first 20 were at 100 %.

## 5. Ollama connects

```powershell
ollama --version          # 0.12.7 or later
ollama pull qwen3-vl:4b-instruct   # 3.3 GB, once
ollama list
```

In Inkling: Settings (gear) → **AI Tutor**.

- [ ] **Ollama (on this computer)** is selected by default and marked DEFAULT; Gemini is marked 18+.
- [ ] "Ollama x.y.z is running on this computer." Quit Ollama from the tray and press **Check again**: "Ollama isn't running" with a link to ollama.com/download. Reopen Ollama, **Check again**: running.
- [ ] Qwen3-VL 4B shows *installed · 3.3 GB*; 2B / 8B show *not installed* with their download size (unless you installed them).
- [ ] Click Qwen3-VL 8B (not installed): an install box with `ollama pull qwen3-vl:8b-instruct` and a Copy button appears. **Test connection** says it isn't installed. Nothing is downloaded.
- [ ] Click Qwen3-VL 4B, **Test connection**: "Model answered in N s". Record N (first, cold): ____ s; press it again (warm): ____ s.
- [ ] No API key field and no consent prompt for Ollama. The tutor footer says "Answered on this computer by Ollama."

## 6. Handwriting with the real local model

Automated, with the bundled handwriting images:

```powershell
npm run test:live                                   # qwen3-vl:4b-instruct
$env:INKLING_LIVE_MODEL = 'qwen3-vl:2b-instruct'; npm run test:live; Remove-Item Env:INKLING_LIVE_MODEL   # optional
```

- [ ] Attach `test-results\live-ollama-qwen3-vl_4b-instruct.md` (and `.json`). It lists, per scenario, whether the reading and the maths were right, whether the answer streamed, first-text and total time, and whether structured output validated. Failing checks are expected to be reported there, not hidden.

By hand, with **your own handwriting** (mouse, pen or touch), in the app:

| # | Write | Select it (lasso), then | Expected |
|---|---|---|---|
| A | `x² + 5x + 6 = 0` / `(x + 2)(x + 3) = 0` / `x = 2, 3` | ✨ → *Check my work* | Spots the sign mistake: the roots are −2 and −3 |
| B | `2x + 3 = 11` / `2x = 8` / `x = 4` | *Check my work* | Says the work is correct |
| C | A box on the ground with arrows labelled W (down), N (up), F (right), f (left) | Ask "Which forces are shown?" | Weight, normal force, applied force, friction |
| D | Create a **Note**, type a few facts (e.g. photosynthesis) | Ask a question about it (context: *This page*) | Answers from the note |
| E | Import a PDF with text (… → Import PDF), open a page | Ask about its content | Answers from the PDF text |

For each, record: handwriting read correctly? (the answer starts with what it read) · explanation correct? · did text appear gradually (streaming)? · seconds to first text / to finish · anything that failed.

## 7. On-page corrections (approve, edit, undo)

Using scenario A above:

- [ ] Under the chat answer, **Show this on my page** → the On Page tab shows "What the tutor read" and a list of proposed marks; the marks are **previewed** on the page, and the page itself is unchanged (no save, nothing to undo yet).
- [ ] Marks sit on or beside the right lines (the ✗/correction by `x = 2, 3`). Screenshot it.
- [ ] Untick one mark, then **Add N to my page**: the marks become normal objects; your own strokes are untouched.
- [ ] Select an AI mark with the lasso and move it; edit the correction text with the Text tool.
- [ ] Ctrl+Z removes all the AI marks in one step (after undoing your own move/edit); Ctrl+Shift+Z restores them.
- [ ] Or run it automatically: `npm run build; npm run test:live:app` and attach `test-results\live-app-qwen3-vl_4b-instruct.md` and the screenshots.

## 8. Narrow windows

- [ ] At 960×600 with the library, page list and AI Tutor all open: the toolbar does not cover the notebook title or "Saved"; the floating dock stays inside the canvas and doesn't cover the tutor's question box; you can type and send a question. Same for a Note page.
- [ ] Repeat at 125 % / 150 % display scaling.

## 9. Gemini (only if the tester is 18+ and has a free-tier key)

- [ ] Choosing Google Gemini shows the 18+ eligibility notice; the first question asks to confirm 18+ and consent.
- [ ] Optional: `npm run test:smoke` with a key (see README, *Real Gemini smoke test*).

## Report back

Commit hash tested · machine notes · each box above with pass/fail · the two live reports · failure logs and screenshots.
