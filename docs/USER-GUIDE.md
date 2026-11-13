# Inkling user guide

Everything Inkling can do, and how to do it. New here? Start with the [install guide](INSTALL.md).

- [Using the canvas](#using-the-canvas) · [Rich-text notes](#rich-text-notes) · [Search, links and backlinks](#search-links-and-backlinks) · [Knowledge graph](#knowledge-graph) · [PDFs](#pdfs) · [AI Tutor](#ai-tutor)
- Where your notes live, backups and privacy: [Your notebooks and your data](#your-notebooks-and-your-data)

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

Lasso some handwritten work and press ✨ *Ask AI*. The first time, Inkling asks for permission before anything is sent. Which AI answers, and what it costs (nothing), is explained in [AI providers](AI.md).

| What | How |
|---|---|
| Ask about your handwriting | Lasso-select your work → ✨ on the selection toolbar (or Ask AI), then type a question. Answers stream in, with formulas typeset. Follow-up questions keep the conversation. |
| Quick actions | Give me a hint · Explain the concept · Check my work · Try a similar problem |
| Context | The composer shows what is included: your selection, or this page. Remove it to ask a general question. |
| Practice | Practice tab → difficulty, number of problems, optional topic. Reveal hints one at a time, check a typed answer or a handwritten one (select it), show the worked solution, or copy a problem onto the page. |
| Corrections on the page | On Page tab → *Mark up my selection*, or **Show this on my page** under a chat answer. The tutor proposes ✓/✗ marks, circles, underlines, corrections and notes. They are previewed on the page, you can untick any of them, and *Add to my page* inserts them as one undoable step. They are ordinary objects in a handwriting font (Caveat): move, edit or delete them like anything else. |

## Your notebooks and your data

- **Everything is saved on your computer**, as you write: `%APPDATA%\Inkling\Library` on Windows, `~/Library/Application Support/Inkling/Library` on macOS. *Settings → Storage* shows the exact folder.
- **Daily backups** of your whole library (the last 7 are kept) go to `Backups` next to it. *Settings → Storage* also has *Back up now* (to any folder) and one-click *Restore*; your current library is kept as a "before restore" copy.
- **Updating or uninstalling Inkling never touches your notebooks.** To remove them too, delete the Inkling folder above.
- **No account needed, no ads or analytics.** Signing in (Settings → Account and sync) is optional; it stores your notebooks in your account so they sync between the web app and the desktop app, and keeps earlier versions of each page. Nothing goes to the AI tutor before you allow it. After that it sees what you ask about and the recent conversation on that page, plus an anonymous installation ID and your internet address, used only for the daily limits and kept as scrambled counts replaced every day. Details: [AI providers](AI.md) and the [privacy notice (draft)](PRIVACY.md).

Something wrong? See [SUPPORT.md](../SUPPORT.md).

## Known limitations

What Inkling doesn't do yet, or does with caveats. Open work is listed in the [roadmap](ROADMAP.md).

- The cloud AI's free allowance is small: about 110 typical interactions a day for everyone together (measured; see [Cloud beta results](AI.md#cloud-beta-results)). It is shared through one Cloudflare account and resets at midnight UTC, which is the afternoon or evening in the Americas.
- **Permission for the cloud AI is per computer account, not per person, and is not age-checked.** One *Allow* covers everyone who uses Inkling on that computer account. Inkling doesn't ask for ages, and clicking *Allow* doesn't verify a parent's or guardian's consent; the notice says so. A process for verifiable parental consent has not been decided or built (see [PRIVACY.md](PRIVACY.md#children-and-students)).
- Existing installations that allowed the cloud AI under an earlier version of the notice are asked again (once) before anything more is sent, because the notice now lists more of what is sent.
- The cloud beta's model has no JSON mode on Workers AI, so practice sets, answer checks and markups rely on the instructions plus Inkling's validation: an answer in the wrong format is rejected with "Try again" and still costs allowance.
- The beta server can only declare, not verify, that its Cloudflare account is on the Workers Free plan (`ACCOUNT_PLAN`). On a Workers Paid account, usage beyond the free allowance would be billed, though the server's own cap still stops at 9,000 Neurons a day.
- The local tutor's quality and speed depend on the model and the computer. Small models (2B) misread handwriting more often; see [Local model results](AI.md#local-model-results) for what has actually been measured.
- Google Gemini is not offered in published installers. In development builds it is for adults only (Google's terms), and Inkling can't tell whether your Google Cloud project has billing enabled: use a key from a project without billing to be sure of no charges.
- **Tutor chats are kept for the session only.** They clear when Inkling closes, and the chat says so. What the tutor adds to a page after you approve it (marks, corrections, notes) is ordinary page content and is saved with the notebook. Practice sets are session-only too.
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
- Installers are not yet code-signed: Windows and macOS show a security prompt on first open, and macOS can't install updates in-app (Inkling links to the release instead). Windows installs updates in-app. See [RELEASING.md](RELEASING.md#signing-and-notarization).
- The Windows and macOS installers are built, and every acceptance suite plus the install → update → uninstall → reinstall check runs, on GitHub's Windows and macOS machines for every release build. Hands-on testing on a real PC and Mac (security prompts, display scaling) is still pending; see [DEVICE-TESTING.md](DEVICE-TESTING.md).
- Real pens and touch screens (stylus pressure, palm rejection, touch gestures) have not yet been tested on physical devices, and macOS has not been tried on real hardware. Windows was tested by independent QA with automated input (see [the Phase 4.5 notes](archive/PHASE-4.5-WINDOWS.md)).
- In windows narrower than about 1180 px some toolbar buttons fold away (they all have shortcuts or Markdown input rules), and the AI Tutor button shows only its icon. The notebook title is shortened at the minimum width (960 px).
- The production build still warns about chunks over 500 kB: the main renderer chunk (1.7 MB minified: React, Konva, Tiptap, KaTeX) and the on-demand PDF export chunk. pdf.js and the export code load only when first used.
