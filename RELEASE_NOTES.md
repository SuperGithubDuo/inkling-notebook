# Inkling release notes

## 0.2.0-beta.3 — new AI host, same free tutor

**AI tutor**
- **A new host for the free AI.** Questions are now answered by the same model, Qwen 3.8 27B, hosted by **DeepInfra** (an AI hosting company in the United States). Cloudflare still runs Inkling's server, and Cloudflare Workers AI stays as a backup. Older versions of Inkling keep working on Cloudflare Workers AI until you update.
- **Inkling asks for permission again** after the update, because the data notice now names DeepInfra. Nothing is sent until you click *Allow*. DeepInfra and Cloudflare say they don't train on your requests or keep them after answering, apart from limited exceptions such as support cases and legal obligations. Inkling's server doesn't store or log them.
- **Still free, with limits:** about 12 answers a day per computer (long answers use more), a monthly limit per computer, and a shared budget for everyone, so on a busy day the tutor can stop earlier. The tutor shows how much is left and says which limit was reached.
- **Practice problems** are now written by Qwen too, as everything else. Their answers can still be wrong: check them.
- **Asking about the same page again** sends its content once instead of once per question, so long conversations use less of your allowance.
- The local Ollama tutor is unchanged and still available.

**Saving**
- **While you write without pausing**, Inkling now saves at least every 2 seconds, so a crash loses at most that.
- **A page repaired at startup** (for example after a crash during saving) is now reported when you open it, instead of silently.

Notebooks, settings and backups carry over unchanged; the update was tested by installing it over 0.2.0-beta.2.

## 0.2.0-beta.2 — first invited beta (published 3 Nov 2026)

Fixes from independent QA of the Beta 1 Windows installer. Beta 1 was never published; this build replaces it.

**Install** (guide: `docs/INSTALL.md`)
- **Windows 10/11** (x64; ARM PCs run it through Windows' emulation): `Inkling-Setup-0.2.0-beta.2-x64.exe`.
- **Mac, Apple silicon:** `Inkling-0.2.0-beta.2-arm64.dmg`. **Mac, Intel:** `Inkling-0.2.0-beta.2-x64.dmg`. macOS 12 or later.
- **Not code-signed:** Windows and macOS warn on first open and can't verify the publisher. Install only from the link you were sent, and compare the SHA-256 checksums.
- Free AI tutor with no account or key: about 10 answers a day per computer, resetting at 00:00 UTC. Notebooks stay on your computer; nothing is sent to the AI before you allow it.
- Google Gemini is not offered in this build (its terms are adults-only and are being reviewed for an all-ages app); the cloud AI and the local Ollama tutor remain. Developer builds still accept Gemini keys in both Google AI Studio formats (`AIza…` and the newer `AQ.…`).

**Fixed**
- **Free AI answers left:** the count under the tutor now updates after every answer, including page markups, practice sets and answer checks, instead of staying the same until Inkling was restarted. It uses the AI server's own figures, refreshes after a stopped answer, and refreshes after the daily reset at midnight UTC.

**Privacy**
- **Nothing reaches the cloud AI before you allow it** — not even the check of how many free answers are left. Earlier, opening the tutor or AI settings asked the server for that count (sending the installation ID and internet address, no notebook content) before permission was given. The same now applies to Google Gemini in developer builds: its key isn't checked with Google until you allow it.
- **The permission notice lists everything that is sent:** your question, what you include, the recent conversation on the page (up to 5 earlier questions, the answers and the most recent earlier image), the extra fields of markups, practice and answer checks, and the installation ID and internet address. It also says that one *Allow* covers everyone on the computer account and is not verified parental consent. Because the notice changed, Inkling asks once more on computers that had already allowed the cloud AI.
- **Ticking the permission box in Settings** now shows the same notice before anything is allowed; unticking still withdraws at once.
- **History goes only to the service that answered it:** after switching between the cloud AI and Ollama, the earlier conversation stays on screen but isn't sent to the other service.

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
