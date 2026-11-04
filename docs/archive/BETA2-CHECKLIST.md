# Beta 2 hands-on checklist (Windows)

A short pass on a real Windows PC with the `0.2.0-beta.2` installer, before any public link is shared. Record the PC, Windows version, pen model and display scaling. Take a screenshot of anything that fails. `DEVICE-TESTING.md` has the full device pass.

**Before you start:** check the installer's SHA-256 matches the one reported for this build (PowerShell: `Get-FileHash .\Inkling-Setup-0.2.0-beta.2-x64.exe`). If Beta 1 is installed, install Beta 2 over it.

## 1. Install
- [ ] SmartScreen shows the unsigned-app prompt; *More info → Run anyway* installs it.
- [ ] *Help → About Inkling* shows **0.2.0-beta.2**.
- [ ] Notebooks from Beta 1 are all still there.

## 2. Real handwriting and pen
- [ ] Write a few lines of maths with the pen: strokes follow without lag or gaps, pressure changes the width.
- [ ] Resting your palm doesn't draw; one finger pans while the pen is in use.
- [ ] The pen's eraser end erases. Lasso, move and undo work with the pen.

## 3. AI correction and the daily count (the Beta 1 bug)
- [ ] Open the AI Tutor and note **"About N answers left today"** at the bottom of the panel.
- [ ] Lasso your handwriting and ask a question. When the answer finishes, the count **goes down without restarting**.
- [ ] *Show this on my page* (a markup): the count goes down again after the proposal appears.
- [ ] Practice tab → generate problems, then check an answer: the count updates after each.
- [ ] Press **Stop** during a long answer: within a few seconds the count shows the server's figure.
- [ ] Settings → AI Tutor shows the same number as the panel.
- [ ] Restart Inkling: the count is the **same** as before the restart (Beta 1 jumped, e.g. 10 → 6).

## 4. Annotations and persistence
- [ ] Untick one proposed mark, then *Add to my page*: only the ticked marks appear, as one undo step.
- [ ] Restart Inkling: the handwriting and the approved marks are still there.
- [ ] The chat says *"Chats aren't saved: they clear when you close Inkling."* After the restart the chat is empty, as expected.

## 5. Offline
- [ ] Turn Wi-Fi off. Writing, saving, search and PDF export work as usual.
- [ ] Ask the tutor: a plain "Couldn't reach Inkling's AI server… notebooks work as usual offline" message, no crash, no endless spinner.
- [ ] Turn Wi-Fi on and ask again: it answers.

## 6. Daily limit
- [ ] Keep asking until the allowance runs out (or note the count on two days). The panel says *"Today's free answers are used up"*, the tutor explains plainly, and nothing is retried.
- [ ] After midnight UTC (4 pm Pacific in winter, 5 pm in summer) with Inkling still open, the count comes back on its own within a few seconds.
