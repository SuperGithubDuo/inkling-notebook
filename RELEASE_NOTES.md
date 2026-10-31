# Inkling release notes

## 0.2.0-beta.2 — first invited beta (draft, not published)

Fixes from independent QA of the Beta 1 Windows installer. Beta 1 was never published; this build replaces it.

**Install** (guide: `docs/INSTALL.md`)
- **Windows 10/11** (x64; ARM PCs run it through Windows' emulation): `Inkling-Setup-0.2.0-beta.2-x64.exe`.
- **Mac, Apple silicon:** `Inkling-0.2.0-beta.2-arm64.dmg`. **Mac, Intel:** `Inkling-0.2.0-beta.2-x64.dmg`. macOS 12 or later.
- **Not code-signed:** Windows and macOS warn on first open and can't verify the publisher. Install only from the link you were sent, and compare the SHA-256 checksums.
- Free AI tutor with no account or key: about 10 answers a day per computer, resetting at 00:00 UTC. Notebooks stay on your computer; only what you ask about is sent, after you allow it.

**Fixed**
- **Free AI answers left:** the count under the tutor now updates after every answer, including page markups, practice sets and answer checks, instead of staying the same until Inkling was restarted. It uses the AI server's own figures, refreshes after a stopped answer, and refreshes after the daily reset at midnight UTC.

**Clarified**
- **Tutor chats aren't saved.** The chat now says that it clears when you close Inkling. Marks and corrections you add to your page are saved with the notebook, as before.

## 0.2.0-beta.1 — first public beta (draft)

The first version of Inkling you can install like any other app. No developer tools are needed.

**Install**
- **Windows 10/11:** `Inkling-Setup-0.2.0-beta.1-x64.exe` (x64 only; ARM PCs use emulation). It installs for your account with no administrator rights. Uninstalling keeps your notebooks.
- **macOS 12+:** `Inkling-0.2.0-beta.1-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel).
- This beta is **not yet code-signed**, so Windows and macOS show a security prompt the first time. `INSTALL.md` explains how to open it.

**New**
- **Welcome** on first launch; **About Inkling** with the version; **Help** menu with Getting Started, Send Feedback and Privacy.
- **Backups:** a copy of your whole library every day (last 7 kept), plus *Back up now* to any folder and one-click *Restore*. Your current library is kept as a "before restore" backup.
- **Repair instead of reset:** if Inkling's notebook list is ever damaged, it is rebuilt from your notebooks on disk. Nothing is ever replaced by an empty library.
- **Safer quitting:** Inkling saves everything before it closes, and asks before closing if it couldn't. If the window crashes, it offers to reopen, with at most the last moment of writing lost.
- **Update notices:** Inkling tells you when a new version is out. Signed releases will install updates themselves after you click *Restart to update*.
- **AI Tutor:**
  - **Inkling AI (cloud)** is ready the moment you install: free, no account, no code, nothing to download, with a daily limit on answers.
  - The local Ollama tutor and Google Gemini (adults only, with your own key) remain available.
  - Nothing is sent without your permission.
- New app icon.

**Known limitations**
- Every release is tested automatically: on Linux, and on the Windows and macOS machines that build the installers. It hasn’t been tested on real pens and tablets yet: please tell us how yours behaves.
- The free cloud AI allowance is small: about 10 answers a day on each computer and roughly 100 a day for everyone together. It resets at midnight UTC; when it runs out, your notebooks work as usual.
- Handwriting isn't searchable yet. Audio recording and sharing aren't available.
- No iPad, Android or web version.

Found a problem? *Help → Send Feedback or Report a Problem*.
