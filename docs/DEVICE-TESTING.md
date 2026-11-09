# Testing on real computers and pens

Automated tests cover a lot. They run the real app on Linux with a virtual display, and the release workflow runs them on Windows and macOS GitHub runners. They cannot cover installers on a real PC or Mac, security prompts, display scaling, or real pens, touch screens and trackpads. Do these by hand before inviting testers, and record pass/fail with a screenshot for each failure.

Record first:
- OS version
- the machine and CPU (Intel, AMD, ARM, Apple M-series)
- RAM
- display scaling
- pen or tablet model

## 1. Install (Windows: `.exe`; Mac: `.dmg`)

- [ ] Download from the draft release or the workflow artifacts. The security prompt matches `INSTALL.md`, and *Run anyway* / *Open Anyway* works.
- [ ] Inkling opens with the welcome. The app icon shows in the taskbar/Dock, Start menu/Launchpad, and on the desktop shortcut (Windows).
- [ ] *About* shows the right version. *Help* has Getting Started, Send Feedback and Privacy.

## 2. Notebook basics

- [ ] Write a few lines and quit (close the window / ⌘Q). Reopen: everything is there.
- [ ] Draw, then end Inkling from Task Manager / Force Quit within 2 seconds of the last stroke. Reopen: at most the last stroke is missing.
- [ ] Restart the computer with Inkling open. It reopens normally, nothing lost.
- [ ] Import a real lecture PDF (20+ pages), write on it, export the notebook as PDF, and open the export in Acrobat/Preview.

## 3. Pens, touch, trackpads (the most important part)

For each device you have (Surface Pen, Wacom tablet, Apple Pencil via Sidecar, a touch screen, a trackpad):
- [ ] Strokes follow the pen without visible lag or gaps, including fast writing.
- [ ] Pressure changes the line width (pens that report pressure).
- [ ] The palm resting on the screen doesn't draw (touch screens with a pen).
- [ ] The pen's eraser end or button erases.
- [ ] Two-finger pinch zooms and two-finger drag pans (touch and trackpad); ⌃/Ctrl + scroll zooms at the pointer.
- [ ] At 125% and 150% display scaling (Windows), strokes land exactly under the pen.

## 4. Backups and updates

- [ ] *Settings → Storage* lists a "Daily" backup a minute after first start. *Back up now…* to a USB stick works. Restore it, and Inkling restarts with that library.
- [ ] Install the next beta over the current one, from the new `.exe`/`.dmg`. The library is unchanged.
- [ ] Uninstall, then reinstall. The library is still there.
- [ ] (Signed builds only) An in-app update appears as *Restart to update* and installs.

## 5. AI Tutor

- [ ] On a fresh install with no setup (cloud AI is the default): ask about handwritten algebra, and get a correct answer. *Show this on my page* previews marks, *Add* applies them, and undo removes them.
- [ ] Without any AI set up: the tutor shows how to set it up, and everything else works.
- [ ] Turn off Wi-Fi and ask: a clear "couldn't reach" message, and the notebook keeps working.

## 6. PhonePad

Not yet tested on any real phone. The automated tests (`tests/e2e/phonepad.e2e.mjs`) use Chromium over loopback with mouse input. Do each check on all four combinations, and record the phone model, OS version, browser and Wi-Fi router.

| | iPhone (Safari) | Android (Chrome) |
|---|---|---|
| Windows computer | not tested | not tested |
| macOS computer | not tested | not tested |

Also worth trying: iPad + Apple Pencil (pressure), Android + S Pen or USI stylus (pressure, palm), Samsung Internet, Firefox.

- [ ] *Connect phone* → scan the QR with the camera app → the page opens and says Connected within a few seconds. On first use, the Windows Firewall / macOS prompt appears; allowing it on private networks is enough.
- [ ] Typing the address and the 8-character code by hand also connects.
- [ ] Write a line of maths and a small diagram with a finger. Ink appears inside the blue frame on the computer while writing, without visible gaps, and the finished strokes match what the phone shows. Note the felt delay (none / slight / distracting).
- [ ] A circle drawn on the phone is round on the computer, in landscape and portrait.
- [ ] Rotate the phone while writing: the stroke ends cleanly, and the next stroke uses the new shape.
- [ ] Pinch with two fingers to zoom in; write small; it lands in the right place at the smaller size. Drag with two fingers to move along the page.
- [ ] Eraser, Undo, Redo and Clear (two taps) on the phone; undo on the computer undoes phone strokes too.
- [ ] With a stylus: pressure changes the line width on the computer; after the first stylus stroke, a resting palm doesn't draw and a finger moves the page.
- [ ] Turn Wi-Fi off on the phone for 5 s mid-stroke, then on: it reconnects by itself and the stroke is complete (no gap, no double).
- [ ] Lock the phone for 30 s and unlock it: it reconnects within a few seconds.
- [ ] A second phone scanning the same QR is refused with a clear message.
- [ ] *Disconnect* on the computer: the phone says so; scanning the old QR no longer works.
- [ ] Save, quit, reopen: the phone's handwriting is there. *Export notebook as PDF* contains it.
- [ ] On a computer with VPN/WSL/Hyper-V/Docker adapters: the right Wi-Fi address is chosen first, or the *Network* picker fixes it.
- [ ] Guest Wi-Fi with client isolation: the phone can't connect, and the "Phone can't connect?" tips explain why.

