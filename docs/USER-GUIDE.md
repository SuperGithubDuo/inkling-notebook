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

Lasso some handwritten work and press ✨ *Ask AI*. The first time, Inkling asks for permission before anything is sent. Which AI answers, and what it costs (nothing), is explained in [AI providers](AI-PROVIDERS.md).

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
- **No account, no cloud storage, no tracking.** The AI tutor only sees what you ask about, after you allow it. Details: [privacy notice (draft)](PRIVACY.md).

Something wrong? See [SUPPORT.md](../SUPPORT.md).
