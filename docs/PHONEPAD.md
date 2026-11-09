# PhonePad

*Turn your phone into a wireless writing tablet.*

PhonePad lets you write on the open handwritten page using your phone's touchscreen, with a finger or a stylus. The phone opens a small web page served by Inkling on your computer; nothing is installed on the phone, and nothing goes through the internet.

## Using it

1. Open a handwritten page in Inkling.
2. Click **Connect phone** (the phone icon in the toolbar, next to *Insert image*).
3. Scan the QR code with your phone's camera and open the link. Both devices must be on the same Wi-Fi.
4. Write on the phone. The ink appears inside the blue **PhonePad** frame on the page.

| On the phone | What it does |
|---|---|
| Write with one finger or a stylus | Ink in the computer's current pen (or highlighter) colour and thickness |
| Eraser | Erases like the computer's eraser (whole stroke or precise, as set in Inkling) |
| Undo / Redo | The notebook's undo and redo, shared with the computer |
| Clear (tap twice) | Removes the ink inside the frame, as one step you can undo |
| Pinch with two fingers | Zooms the computer's view. Zooming in makes the frame smaller, so you write smaller and more precisely |
| Drag with two fingers | Moves the frame across the page |
| Turn the phone sideways | More room to write. The frame takes the phone's shape |

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
| Mapping | `src/renderer/src/phonepad/region.ts` | Normalized coordinates → page coordinates |
| Controller | `src/renderer/src/phonepad/controller.ts` | Phone events → canvas commands; the phone's picture |
| Live layer | `src/renderer/src/phonepad/live.ts` | In-progress phone ink and the frame, drawn on the canvas's existing live layer |
| UI | `src/renderer/src/phonepad/PhonePadDialog.tsx` | Toolbar button, pairing and status dialog |

**Same pipeline as the pen.** A finished phone stroke becomes a `createStroke` command run through `useStore.run()`, like a mouse or stylus stroke. It is one undo step, saved by the save queue and included in PDF/PNG export, and the phone's eraser uses the same hit testing (`canvas/strokeOps.ts`, shared with `PageCanvas`). Nothing is stored that a mouse stroke wouldn't store. Strokes are `author: 'user'`, and pressure is kept only from a stylus.

**Coordinates.** The phone sends `(u, v) ∈ [0, 1]` across its writing surface, plus the surface's aspect ratio at pen-down. The desktop maps them into the *PhonePad area*: the largest rectangle with the phone's aspect ratio inside the part of the page visible on the computer (clear of the bottom dock).

- The area has the phone's aspect ratio, so `u` and `v` scale by the same factor, and ink never stretches, whatever the phone size, orientation, page size, zoom or display DPI.
- Each stroke keeps the area it started in. If the phone rotates mid-stroke, the phone ends that stroke where it is, and the next one uses the new shape.
- Raw pixels never cross the wire.

**Smoothness and traffic.** The phone reads coalesced pointer events and sends them once per animation frame. Points are rounded to 5 decimals (well below a page unit), and repeats of the same spot are dropped. The computer previews the stroke as it arrives, on the canvas's live layer, without React renders. The phone draws its own stroke immediately. After each change, the computer sends a JPEG of the area, at most 1600 px, so the phone shows paper, PDF pages and existing ink. It drops its own copy of a stroke once a picture containing it arrives.

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
| Unit | `tests/unit/phonepad.test.ts` | Schemas, sequencer, mapping (aspect, no distortion, visibility, zoom, gestures), phone-client helpers, controller with fakes (commit, pressure, frozen area, cancel, eraser, undo/redo/clear, navigation, picture) |
| Acceptance | `tests/e2e/phonepad.e2e.mjs` | Real app and real phone page (in a phone-sized Electron window) over loopback: pairing, exact and undistorted placement, phone undo/redo/eraser/clear, mixing with mouse ink, zoomed writing, pinch, portrait, reconnect mid-stroke, PDF export, restart, disconnect |

Run with `npm run build && xvfb-run -a npm run test:e2e:phonepad`.

**Not yet verified on real hardware.** The automated tests use Chromium on Linux over loopback with mouse input. No real phone, Wi-Fi network, firewall prompt, Safari/iOS behaviour, touch or stylus has been tested yet. The hand-test plan is in [DEVICE-TESTING.md](DEVICE-TESTING.md#6-phonepad).

## Known limitations

- Desktop and phone must be on the same network, and some guest, school and office networks isolate devices from each other. On the first connection, Windows and macOS may ask whether Inkling may accept incoming connections. Allow it on private networks.
- Traffic is unencrypted on the local network (see Security).
- iPhone Safari has no full-screen mode for web pages. The full-screen button appears only where the browser supports it (e.g. Android Chrome).
- The phone shows a picture of the page that refreshes after each change, not a live mirror of edits made on the computer while you write.
- Clear removes ink (pen and highlighter strokes), not text, shapes or images.
- One phone at a time.
