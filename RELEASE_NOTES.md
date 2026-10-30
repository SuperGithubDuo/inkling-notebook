# Inkling release notes

## 0.2.0-beta.1 — first public beta (draft)

The first version of Inkling you can install like any other app. No developer tools are needed.

**Install**
- **Windows 10/11:** `Inkling-Setup-0.2.0-beta.1-x64.exe` (or `-arm64`). It installs for your account with no administrator rights. Uninstalling keeps your notebooks.
- **macOS 12+:** `Inkling-0.2.0-beta.1-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel).
- This beta is **not yet code-signed**, so Windows and macOS show a security prompt the first time. `INSTALL.md` explains how to open it.

**New**
- **Welcome** on first launch; **About Inkling** with the version; **Help** menu with Getting Started, Send Feedback and Privacy.
- **Backups:** a copy of your whole library every day (last 7 kept), plus *Back up now* to any folder and one-click *Restore*. Your current library is kept as a "before restore" backup.
- **Repair instead of reset:** if Inkling's notebook list is ever damaged, it is rebuilt from your notebooks on disk. Nothing is ever replaced by an empty library.
- **Safer quitting:** Inkling saves everything before it closes, and asks before closing if it couldn't. If the window crashes, it offers to reopen, with at most the last moment of writing lost.
- **Update notices:** Inkling tells you when a new version is out. Signed releases will install updates themselves after you click *Restart to update*.
- **AI Tutor:**
  - A new **Inkling beta (cloud)** option: free for testers with an access code, a daily allowance, nothing to download.
  - The local Ollama tutor and Google Gemini (adults only, with your own key) remain available.
  - Nothing is sent without your permission.
- New app icon.

**Known limitations**
- Every release is tested automatically: on Linux, and on the Windows and macOS machines that build the installers. It hasn’t been tested on real pens and tablets yet: please tell us how yours behaves.
- The cloud AI allowance is small (roughly 100 answers a day across all testers), and it resets at midnight UTC.
- Handwriting isn't searchable yet. Audio recording and sharing aren't available.
- No iPad, Android or web version.

Found a problem? *Help → Send Feedback or Report a Problem*.
