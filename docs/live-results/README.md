# Live local-model results — 29 Oct 2026

Real Qwen3-VL models in **Ollama 0.40.13**, no mocks. Test machine: Linux sandbox,
**2 CPU cores, 8 GB RAM (≈7 GB usable), no GPU** — far slower than a typical laptop,
so read the times as a pessimistic bound. Handwriting images: `tests/fixtures/handwriting/`,
the exact JPEGs Inkling sends (drawn with the tests' pen-stroke font, not by a person).

Raw reports, with every answer: `scenarios-*.md` (from `npm run test:live`) and
`app-workflow-*.md` + screenshots (from `npm run test:live:app`).

## Handwriting scenarios (provider level, same prompts and validation as the app)

| Scenario | qwen3-vl:4b-instruct (recommended) | qwen3-vl:2b-instruct |
|---|---|---|
| **A** chat: x² + 5x + 6 = 0 → (x+2)(x+3) = 0 → x = 2, 3 | ✅ read all 3 lines, found the sign mistake, roots −2 and −3. 218 s (first text 120 s) | ✅ same. 115 s (first text 76 s) |
| **A** "Mark up my selection" | ✅ valid JSON, all 3 lines transcribed, ✗ on the last line, correction "x = −2, −3". 236 s | ❌ valid JSON, transcription perfect, but **marked the work correct** (one ✓ over everything). 105 s |
| **A** "Show this on my page" (with the chat explanation) | ✅ 9/9 checks. 125 s | not run (test added after this run; the app run below covers it) |
| **B** chat: 2x + 3 = 11 → 2x = 8 → x = 4 | ✅ "correct" (169 s, rerun — the first attempt was killed for lack of memory) | ✅ "correct". 102 s |
| **B** markup | ✅ ✓ marks only, no ✗. 152 s | ⚠️ ✓ marks only, but its summary and a note wrongly say the final step has an error. 139 s |
| **C** free-body diagram (W, N, F, f) | ✅ weight, normal, applied force, friction. 187 s | ⚠️ normal, applied, friction — **missed the weight**. 114 s |
| **D** question about a rich-text note | ✅ stroma, oxygen. 51 s | ✅ 22 s |
| **E** question about PDF text | ✅ 20 m/s and 80 m. 80 s | ✅ 20 m/s and 80 m (the report shows ❌ only because of a test regex bug, since fixed). 48 s |
| **P** practice: 2 problems with hints; check a right and a wrong answer | ✅ valid, 2 problems, hints; right → correct, wrong → not correct (rerun — first attempt killed for lack of memory). 79 s + 18 s + 16 s | ✅ same. 42 s + 11 s + 16 s |

- **Streaming:** every chat answer streamed (96–268 chunks). Structured tasks are delivered whole after validation, by design.
- **Structured output:** every completed annotate, practice and check answer validated against Inkling's schemas (Ollama's JSON-schema `format`). Validation can't catch a *wrong* markup (2B on A).
- **Where the time goes:** on 2 cores, reading the ~1,300-token prompt (instructions + image) takes 70–130 s before the first word; text-only questions (D, E, P) start in 3–7 s. A cold model load took 8 s, and once 194 s on a busy machine.
- One 4B report line ("summary says there is a mistake", A markup) is a false negative of the test's keyword check; the summary does describe the mistake. The check was widened afterwards.

## Full on-page workflow in the app (`npm run test:live:app`)

**qwen3-vl:4b-instruct** (`app-4b-*.png`): handwriting written with the pen → lasso → "Check my work" streamed (first text 134 s, done 241 s), naming the mistake and −2, −3 → **Show this on my page** → after 282 s a validated proposal of 5 marks (✗ "x = 2, 3 is wrong — signs are reversed", correction "x = −2, −3", a note and two pointers) → previewed with the page unchanged → approved: 10 AI-authored objects, the student's strokes untouched → one undo removed them all, redo restored them → the AI note was edited with the text tool (`app-4b-edited.png`; the script's check of this step fired too early and was fixed). A second 4B run in the app was killed by the OS during the markup: the model peaks at ~5.5 GB, and with Electron also running that exceeded this machine's memory. The page was left unchanged and the error suggested the 2B model.

**qwen3-vl:2b-instruct** (`app-2b-*.png`, `app-workflow-qwen3-vl-2b-instruct.md`): every step passed — chat, a validated 6-mark proposal (correction "x = −2, −3" and a correct note on the right line, but also circles around every line), preview, approve (11 objects), undo, redo, edit. Faster, noisier.

## Conclusions

- A free local model **can** read this handwriting, find the error and put a correct, editable, undoable correction on the canvas. Qwen3-VL **4B** did so cleanly; **2B** reads well but its own markups are less reliable (it once marked wrong work as correct).
- **Memory**, not accuracy, was the main problem: 4B needs about 5.5 GB at its peak. On an 8 GB computer with the app open, use 2B or close other apps; 16 GB is comfortable for 4B.
- Use the `-instruct` builds: the plain `qwen3-vl:2b` (thinking) took 338 s for an answer `2b-instruct` gave in 104 s.
- Not yet tested: real student handwriting, Windows, GPUs, and `qwen3-vl:8b-instruct`.
