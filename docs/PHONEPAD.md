# PhonePad

*Turn your phone into a wireless writing tablet.*

PhonePad lets you write on the open handwritten page using your phone's touchscreen, with a finger or a stylus. The phone opens a small web page served by Inkling on your computer; nothing is installed on the phone, and nothing goes through the internet.

## Using it

1. Open a handwritten page in Inkling.
2. Click **Connect phone** (the phone icon in the toolbar, next to *Insert image*).
3. Scan the QR code with your phone's camera and open the link. Both devices must be on the same Wi-Fi.
4. Write on the phone. The ink appears on the page, inside the blue **PhonePad** frame that shows what the phone is looking at.

The phone is a sheet of paper that goes on in every direction. Drag with two fingers to move around it and pinch to zoom; both happen on the phone instantly and don't change the computer's zoom. Write past the edge of the page and the page grows to fit.

| On the phone | What it does |
|---|---|
| Write with one finger or a stylus | Ink in the pen colour and size shown on the colour dot |
| Colour dot (next to the pen) | One tap opens the pen card: 8 colours, three sizes (fine, medium, bold) and a size slider. Picking a colour or size closes it; tapping the paper closes it without drawing. This is the computer's pen setting too, so both stay in step |
| Eraser | Erases like the computer's eraser (whole stroke or precise, as set in Inkling) |
| Undo / Redo | The notebook's undo and redo, shared with the computer |
| Clear (tap twice) | Removes the ink in view on the phone, as one step you can undo |
| Drag with two fingers | Moves around the paper, past the page's edges too |
| Pinch with two fingers | Zooms the phone's paper. Zoom in to write small and precisely |
| Turn the phone sideways | More room to write. What you were looking at stays in the middle |

**Infinite paper and the page.** An Inkling page is a sheet with a size, used for thumbnails and PDF export. Ink written past an edge makes the page grow in that direction, in steps of whole paper squares so grid lines, rules and dots stay aligned, up to Inkling's largest page (20 000 units a side). The growth and the stroke are one undo step. Growing left or up moves everything already on the page along with it, so nothing shifts on either screen. PDF pages keep their size: the phone shows their edge, with grey beyond it.

Can't scan? Open the address shown under the QR code in the phone's browser and type the 8-character code.

**Stylus and palms.** Once a stylus has made a stroke, single fingers move the page instead of writing, so a resting hand doesn't leave marks. With finger writing alone there is no palm rejection: a phone can't tell a palm from a finger.

**Pressure.** Pressure is used only when the browser reports it from a stylus (for example Apple Pencil in Safari on iPad, or S Pen in Chrome on Android). Finger strokes have even width, as with the mouse.

## How it works

```
Phone browser ── WebSocket (LAN) ──▶ main process ── IPC ──▶ renderer ──▶ store.run(createStroke)
  page.html        normalized ink      validate, pair,        map to page,      undo · save · PDF
  (served by       batched per frame   de-duplicate,          live preview      (unchanged)
   Inkling)        outbox + resend     forward ink only
            ◀── picture of the area (JPEG), status, acks ──
```

| Part | Where | Job |
|---|---|---|
| Wire contract | `src/shared/phonepad.ts` | zod schemas for every phone message, desktop message types, `StrokeSequencer` (in-order, exactly-once) |
| Server | `src/main/phonepad/server.ts` | HTTP (one page) + WebSocket, pairing, origin/address checks, rate and size limits, heartbeats, session lifetime |
| Network choice | `src/main/phonepad/network.ts` | Private IPv4 addresses only, Wi-Fi first, virtual adapters (WSL, Hyper-V, Docker, VPNs) last |
| QR | `src/main/phonepad/qr.ts` | QR as one SVG path (`qrcode-generator`) |
| Phone page | `src/phonepad/client/` | Writing surface, outbox, reconnection, gestures; bundled into one HTML string by `scripts/phonepadPage.mjs` at build time |
| Phone camera | `src/phonepad/client/camera.ts` | Infinite paper: pan, pinch, zoom limits, paper-line positions |
| Mapping | `src/renderer/src/phonepad/region.ts` | Where the phone starts, how much the page grows, when the computer's view follows |
| Growing pages | `canvas/commands.ts` (`extendPage`), `canvas/history.ts` (`size` op) | Page size changes as ordinary undoable commands |
| Controller | `src/renderer/src/phonepad/controller.ts` | Phone events → canvas commands; the phone's picture |
| Live layer | `src/renderer/src/phonepad/live.ts` | In-progress phone ink and the frame, drawn on the canvas's existing live layer |
| UI | `src/renderer/src/phonepad/PhonePadDialog.tsx` | Toolbar button, pairing and status dialog |

**Same pipeline as the pen.** A finished phone stroke becomes a `createStroke` command run through `useStore.run()`, like a mouse or stylus stroke. It is one undo step, saved by the save queue and included in PDF/PNG export, and the phone's eraser uses the same hit testing (`canvas/strokeOps.ts`, shared with `PageCanvas`). Nothing is stored that a mouse stroke wouldn't store. Strokes are `author: 'user'`, and pressure is kept only from a stylus.

**Coordinates (infinite paper).** The phone has its own camera over the page. It sends `(u, v) ∈ [0, 1]` across its writing surface, plus the page rectangle the surface showed at pen-down. That rectangle has the surface's aspect ratio, so `u` and `v` scale by the same factor, and ink never stretches, whatever the phone size, orientation, page size, zoom or display DPI.

- Each stroke keeps the rectangle it began in. If the phone rotates mid-stroke, the phone ends that stroke where it is.
- The phone draws the page's paper pattern itself, at the same positions as Inkling's own paper (`client/camera.ts`, unit-tested against them), and lays the computer's picture of the page over it.
- **Content moves.** Growing a page left or up moves its content. The store records each such move (`pageShifts`, also on undo/redo of one), and the desktop keeps its view in place. Each move bumps the page's *epoch*. The page status the phone receives carries the total move, `origin`, so the phone shifts its camera by any change, also after a reconnect. Phone messages carry the epoch their coordinates belong to, so a stroke that crossed a move in flight is corrected rather than misplaced.
- The computer's view follows the phone's frame lazily: only when the frame leaves the view does it re-centre (zooming out if needed).
- When the phone connects, or another page is opened on the computer, the phone starts on the part of the page the computer shows.

**Smoothness and traffic.** The phone reads coalesced pointer events and sends them once per animation frame. Points are rounded to 5 decimals (well below a page unit), and repeats of the same spot are dropped. The computer previews the stroke as it arrives, on the canvas's live layer, without React renders. The phone draws its own stroke immediately. Panning and zooming are drawn on the phone without waiting for the computer. When the view settles, or the page changes, the computer sends a JPEG of what the phone sees plus half a screen around it (clipped to the page, at most 2400 px), so the phone shows paper, PDF pages and existing ink. It drops its own copy of a stroke once a picture containing it arrives.

**Reliability.**
- Ink and commands stay in the phone's outbox until acknowledged and are resent after a reconnect. `StrokeSequencer` holds early arrivals and drops duplicates.
- A stroke cut off by a phone that never returns is kept after 15 s.
- The phone reconnects with backoff (250 ms → 3 s), and at once when the screen turns back on.
- Both sides detect silent Wi-Fi drops with heartbeats.
- If the paired phone stays away for 10 minutes, the session ends.

## Security

- **Off until asked.** Nothing listens until you click *Connect phone*. Closing the dialog before a phone connects stops the server again, and so do *Disconnect*, closing the window and quitting. PhonePad is always off after a restart.
- **Local network only.** The server binds to one private LAN address (never `0.0.0.0`), and connections from non-private addresses are dropped before HTTP.
- **Pairing.** The QR carries a 256-bit random secret in the URL *fragment*, so it never appears in a request line, log or `Referer`; the phone removes it from the address bar. The 8-character code (40 bits) expires after 5 minutes and is replaced after 8 wrong guesses. The first phone to pair owns the session. Others are refused, and only the paired phone, identified by its own random tab id, can reconnect.
- **WebSocket hygiene.** The `Origin` header must be the page's own origin, which blocks other websites open on the phone or the LAN. Messages are capped at 256 KB and 400 per second. Each message is validated against zod schemas, and a connection that keeps sending invalid messages is closed.
- **Narrow surface.** The phone can send ink, undo/redo/clear and view gestures, nothing else. It has no IPC, no file access and no other notebook access. The renderer can only send it page status and pictures of the area (validated too), over a trusted-sender IPC channel.
- **Locked-down page.** It is served with a strict CSP (hash-pinned inline script and style, `connect-src` naming only this server), `no-store`, `nosniff`, `no-referrer`, and `frame-ancestors 'none'`.
- **No secrets in logs.** Secrets and codes are never logged.

Plain `ws://`/`http://` is used because a local server can't get a certificate browsers trust. Anyone who can watch the Wi-Fi traffic could see ink in transit. This is the same trade-off as other LAN pairing tools; on untrusted networks, don't use PhonePad.

## Modularity

The renderer only sees `PhonePadEvent`s (`src/shared/phonepad.ts`), already validated and de-duplicated. A different transport, such as Bluetooth or USB, would produce the same events, and the controller, mapping and UI would not change.

## Testing

| Layer | Where | What |
|---|---|---|
| Unit | `tests/unit/phonepad-server.test.ts` | Serving and CSP, origin checks, wrong token and code lockout, second phone refused, ordering and duplicates, invalid messages, command de-dup, resume mid-stroke, orphaned strokes, absent timeout, replacement, stop, network ranking, QR |
| Unit | `tests/unit/phonepad.test.ts` | Schemas, sequencer, phone camera (pan everywhere, pinch keeps the point under the fingers, zoom limits, paper lines match Inkling's), growth amounts and limits, follow, client helpers, controller with a real command layer (exact mapping, growth right/down and left/up, epoch correction, undo of growth, PDF pages, pressure, eraser, pen sync and per-stroke pen, clear, picture) |
| Unit | `tests/unit/extend-page.test.ts` | `extendPage`: growth in each direction, content moving with the corner, one undo step, refusals (PDF pages, the AI, oversize) |
| Acceptance | `tests/e2e/phonepad.e2e.mjs` | Real app and real phone page (in a phone-sized Electron window) over loopback: pairing, exact and undistorted placement, phone undo/redo/eraser/clear, mixing with mouse ink, pinch zoom on the phone (no stray ink), independent zooms, writing past the top-left grows the page with everything staying aligned, undo of growth, pen card (colour, presets, slider, tap-away draws nothing, synced both ways), portrait, reconnect mid-stroke, PDF export, restart, disconnect |

Run with `npm run build && xvfb-run -a npm run test:e2e:phonepad`.

**Not yet verified on real hardware.** The automated tests use Chromium on Linux over loopback with mouse input. No real phone, Wi-Fi network, firewall prompt, Safari/iOS behaviour, touch or stylus has been tested yet. The hand-test plan is in [DEVICE-TESTING.md](DEVICE-TESTING.md#6-phonepad).

## Known limitations

- Desktop and phone must be on the same network, and some guest, school and office networks isolate devices from each other. On the first connection, Windows and macOS may ask whether Inkling may accept incoming connections. Allow it on private networks.
- Traffic is unencrypted on the local network (see Security).
- iPhone Safari has no full-screen mode for web pages. The full-screen button appears only where the browser supports it (e.g. Android Chrome).
- The phone shows a picture of the page that refreshes after each change and when you stop panning, not a live mirror of edits made on the computer while you write. While panning fast, newly revealed parts show plain paper until the picture arrives.
- Clear removes ink (pen and highlighter strokes), not text, shapes or images.
- Pages grow up to 20 000 units a side; ink beyond that, or past the edge of a PDF page, is kept but sits outside the page (and outside PDF export).
- The phone writes with the pen (not the highlighter).
- Growing a lined page to the left moves the red margin line relative to the ink, because the margin is fixed at the page's left edge.
- One phone at a time.
