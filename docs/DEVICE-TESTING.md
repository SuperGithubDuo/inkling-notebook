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
