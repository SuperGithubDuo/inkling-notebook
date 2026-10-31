# Known limitations

What Inkling doesn't do yet, or does with caveats. The current release-readiness status is in [READINESS.md](READINESS.md).

- The cloud AI's free allowance is small: about 110 typical interactions a day for everyone together (measured; see [Cloud beta results](AI-PROVIDERS.md#cloud-beta-results)). It is shared through one Cloudflare account and resets at midnight UTC, which is the afternoon or evening in the Americas.
- The cloud beta's model has no JSON mode on Workers AI, so practice sets, answer checks and markups rely on the instructions plus Inkling's validation: an answer in the wrong format is rejected with "Try again" and still costs allowance.
- The beta server can only declare, not verify, that its Cloudflare account is on the Workers Free plan (`ACCOUNT_PLAN`). On a Workers Paid account, usage beyond the free allowance would be billed, though the server's own cap still stops at 9,000 Neurons a day.
- The local tutor's quality and speed depend on the model and the computer. Small models (2B) misread handwriting more often; see [Local model results](AI-PROVIDERS.md#local-model-results) for what has actually been measured.
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
- Installers are not yet code-signed: Windows and macOS show a security prompt on first open, and macOS can't install updates in-app (Inkling links to the release instead). See `docs/RELEASING.md`.
- The Windows and macOS installers are built, and every acceptance suite plus the install → update → uninstall → reinstall check runs, on GitHub's Windows and macOS machines for every release build. Hands-on testing on a real PC and Mac (security prompts, display scaling) is still pending; see [READINESS.md](READINESS.md) and [DEVICE-TESTING.md](DEVICE-TESTING.md).
- Real pens and touch screens (stylus pressure, palm rejection, touch gestures) have not yet been tested on physical devices, and macOS has not been tried on real hardware. Windows was tested by independent QA with automated input (see [history/PHASE-4.5-WINDOWS.md](history/PHASE-4.5-WINDOWS.md)).
- In windows narrower than about 1180 px some toolbar buttons fold away (they all have shortcuts or Markdown input rules), and the AI Tutor button shows only its icon. The notebook title is shortened at the minimum width (960 px).
- The production build still warns about chunks over 500 kB: the main renderer chunk (1.7 MB minified: React, Konva, Tiptap, KaTeX) and the on-demand PDF export chunk. pdf.js and the export code load only when first used.
