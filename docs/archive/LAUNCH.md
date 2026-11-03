# Launch kit

Nothing here is published. Per your instructions: no domain bought, no release published and no website deployed without your approval.

## Product description

**Short (≤ 140 characters):** Handwritten notes on your computer, with an AI tutor that reads your working and marks it up on the page.

**One paragraph.** Inkling is a notebook for students who think on paper. Write and draw with a pen, mouse or touch screen, mix handwritten pages with typed notes, and annotate PDFs from class. When you're stuck, circle your working and ask the AI tutor. It reads your handwriting, gives a hint instead of the answer, or checks your steps and shows corrections right on your page, which you choose to keep or not. Your notebooks are files on your own computer, saved as you write and backed up every day.

## Feature list (only what is built and tested)

- **Handwriting.** Pen, highlighter, whole-stroke and precise eraser, shapes, text boxes and images. Lasso to move, resize and restyle. Zoom and pan. Undo and redo.
- **Pages your way.** Grid, lined, dotted or blank paper; A4, Letter, square and 16:9 sizes.
- **Typed notes** beside handwritten pages:
  - headings, lists, checklists, tables and code
  - LaTeX formulas
  - Markdown import and export
- **Connected notes.** Search everything (titles, tags, typed text, PDF text), with `[[links]]`, backlinks and a knowledge graph.
- **PDFs.** Import lecture slides or handouts, write on them, and export the annotated notebook as a PDF. Original pages are kept unchanged.
- **AI Tutor (beta):**
  - hints, explanations and checking of handwritten work
  - practice problems with step-by-step hints
  - corrections drawn on your page after you approve them
  - runs on Inkling's cloud beta or privately on your own computer
- **Safe by design.**
  - autosave
  - daily backups
  - one-click restore
  - automatic repair of damaged files
  - no account, no tracking

## Landing page (content outline)

1. **Hero.**
   - Headline: "Write by hand. Get unstuck."
   - Subhead: the short description.
   - Buttons: *Download for Windows* · *Download for Mac*. Detect the visitor's system; link the other.
   - Under the buttons: "Free beta · Windows 10/11 · macOS 12+".
2. **Three panels**, each with a screenshot:
   - **Your handwriting, organised:** notebooks, pages and PDFs.
   - **A tutor that reads your working:** the tutor explaining a mistake.
   - **Corrections on your page, your choice:** the markup preview with checkboxes.
3. **Privacy in plain words.** Notebooks stay on your computer; the AI only sees what you ask about; no tracking. Link to the privacy policy.
4. **Beta notes:**
   - It's free during the beta, and AI answers have a daily limit.
   - The first open shows a security prompt because the beta isn't signed yet. Link to the install guide (`INSTALL.md`).
5. **FAQ:**
   - Does it work offline? (Yes, except cloud AI.)
   - Where are my notes? (A folder on your computer.)
   - iPad? (Not yet.)
   - Will it cost money? (The notebook stays free; see the roadmap.)
6. **Footer.** Privacy · Support/feedback · Release notes · © 2026.

Screenshots to use: `test-results/release-welcome.png`, `cloud-chat.png`, `cloud-markup-applied.png`, `p3-06-pdf.png`. Retake them at 2× with real handwriting before launch.

## What the website must have

| Page | Required for | Status |
|---|---|---|
| Download | everyone | Links to the published GitHub release assets, or your own hosting. |
| Install guide | unsigned beta (security prompts) | Draft: `docs/INSTALL.md` |
| Privacy policy | law (GDPR/CCPA/COPPA), app stores, schools | **Draft for legal review:** `docs/PRIVACY.md` |
| Support / feedback | testers | *Send feedback* opens GitHub Issues by default. Testers without GitHub need an email or form (set `INKLING_FEEDBACK_URL`). |
| Release notes | updates | `RELEASE_NOTES.md` |
| Terms of use / EULA | before charging, or a public launch | Placeholder only (`LICENSE.txt`). **Needs counsel.** |

## Name and trademark: needs legal review before any public launch

"Inkling" has been used before in this exact field:
- **Wacom Inkling** (2011): a digital sketch pen that captures handwriting from paper. Wacom is the leading pen-tablet company, and its products are exactly what Inkling users write with.
- **Inkling** (Inkling Systems, from 2010): an interactive digital-textbook platform backed by major education publishers. Same audience (students), same category (digital learning).

The name is descriptive and appealing, but a search of the USPTO, EUIPO and UKIPO registers, and a clearance opinion, are needed before:
- buying a domain
- registering the company or product name
- spending on branding

Have a fallback name ready. The app's name is in one place (`src/shared/product.ts`, plus `productName` in `package.json` and `electron-builder.yml`).

## Third-party licences

`npm run notices` writes `THIRD_PARTY_NOTICES.txt`, which is shipped in the app and linked from About. It covers 134 packages, and every one is permissive:
- MIT (110)
- BSD-3-Clause (11)
- Apache-2.0 (8)
- ISC (7)
- OFL-1.1 (2, the Inter and Caveat fonts)
- one each of Python-2.0, MIT AND Zlib, BlueOak-1.0.0 and 0BSD

Electron and Chromium add their own notices to the installed app. The build fails if a copyleft or unknown licence appears.

Obligations:
- Keep the notices file shipped (done).
- Apache-2.0 packages (e.g. `@google/genai`, `pdfjs-dist`): keep their NOTICE text, which is included.
- OFL fonts can be bundled and embedded in exported PDFs, but not sold on their own.

Models: Qwen weights are Apache-2.0. Gemini is a service with its own terms (see `AI.md`).

## Validating demand during the beta

- Ask in the feedback form, and in a 3-question survey after a week of use: What would you pay for? What almost made you stop? What do you use instead?
- Count what testers use. There's no telemetry, so ask testers directly; and if usage analytics are added later, make them opt-in and documented in the privacy policy.
