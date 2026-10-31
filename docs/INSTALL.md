# Install Inkling

Installing Inkling and trying it takes about 10 minutes. You don't need an account, Node.js, npm, a GitHub account, an API key, or anything else installed.

## 1. Download the right file

The easiest way: open the **[download page](https://supergithubduo.github.io/inkling-notebook/)** and click the button for your computer. It shows the current version and links straight to the official installer on GitHub.

| Your computer | File (`<version>` is shown on the download page, e.g. `0.2.0-beta.2`) |
|---|---|
| Windows 10 or 11 (including ARM PCs such as Surface Pro X or Snapdragon laptops, which run it through Windows' built-in emulation) | `Inkling-Setup-<version>-x64.exe` |
| Mac with Apple silicon (*Apple menu → About This Mac* shows "Chip: Apple M…") | `Inkling-<version>-arm64.dmg` |
| Mac with an Intel processor (About This Mac shows "Processor: … Intel …") | `Inkling-<version>-x64.dmg` |

Download only from the download page or this project's [GitHub Releases](https://github.com/SuperGithubDuo/inkling-notebook/releases). If you're on a release page, ignore the other files (`.zip`, `.blockmap`, `.yml`): Inkling uses them to check for updates.

**Optional, recommended:** check that your download wasn't altered. Compare its SHA-256 with the one on the download page (also on the release page, and in `Inkling-<version>-SHA256SUMS.txt`):
- Windows (PowerShell): `Get-FileHash .\Downloads\Inkling-Setup-<version>-x64.exe`
- macOS (Terminal): `shasum -a 256 ~/Downloads/Inkling-<version>-arm64.dmg`

## 2. Install

### About the security warnings (please read)

This beta is **not code-signed**. Signing is how Windows and macOS confirm who made an app and that nobody changed it. Without it, your computer can't verify the publisher, so it warns you and you have to choose to open the app yourself. That's expected for this beta, but it means you are trusting the download link rather than the operating system. So:
- only install a file you got from the download page or this project's GitHub Releases, and check its SHA-256 if you can;
- don't install it on a computer where you aren't allowed to install your own software (for example, a school- or work-managed computer) without permission;
- if you're unsure, don't install it, and ask us.

Unsigned builds also can't update themselves. When a new version is out, Inkling tells you and links to the download.

### Windows

1. Double-click `Inkling-Setup-<version>-x64.exe`. It installs for your user account only (no administrator password) and adds Start menu and desktop shortcuts.
2. If you see **"Windows protected your PC"**: click **More info**, check that it names `Inkling-Setup-<version>-x64.exe` with publisher **Unknown publisher**, then click **Run anyway**.
3. Inkling opens when installation finishes.

### macOS (12 Monterey or later)

1. Open the `.dmg` and drag **Inkling** into **Applications**.
2. Open Inkling from Applications. macOS will say it can't verify the developer and won't open it.
3. Open **System Settings → Privacy & Security**, scroll down to the message about Inkling, click **Open Anyway**, and confirm with your password. You only do this once.

## 3. Try it (5 minutes)

1. **Create a notebook:** *New Notebook* in the sidebar, then open it.
2. **Write:** pen (P), highlighter (H), eraser (E). Use a pen, touch screen, mouse or trackpad — whatever you have. We especially want to know how pens and touch behave.
3. **Ask the AI:** write a short maths problem with your working (a small mistake is fine). Circle it with the lasso (L), then press ✨ / *Ask AI*.
4. The first time, Inkling asks **"Send what you ask about to Inkling's AI?"** Nothing is sent before you click **Allow**. Then ask, for example, *"Check my work."* Try *Show this on my page* to see corrections written onto the page.
5. Check that **"About N answers left today"** under the tutor goes down after each answer.
6. Close Inkling and reopen it: your notebook is there. (Tutor chats are not saved; marks you add to the page are.)

## What you should know

**Your notebooks stay on your computer.** Pages, notes, PDFs and backups are saved only on your computer (`%APPDATA%\Inkling` on Windows, `~/Library/Application Support/Inkling` on macOS). We have no accounts and no cloud storage, and we can't see your notebooks. Uninstalling or updating Inkling keeps them.

**The AI only sees what you send it.** When you ask the tutor something, Inkling sends your question plus the context shown in the box: an image of your lasso selection, or the current page's typed text. Nothing is sent until you have clicked *Allow* and asked. It goes over an encrypted connection to Inkling's server on Cloudflare, which gets an answer from an AI model (Qwen) on Cloudflare Workers AI. We don't store your questions, images or answers, and Cloudflare says it doesn't keep them or train on them. **Please don't send personal or sensitive information.** You can withdraw permission in *Settings → AI Tutor*; *Help → Privacy* explains the details.

**The AI is free but limited.** About 10 answers a day per computer, and about 110 a day shared by all testers. Each computer's allowance resets at 00:00 UTC (4 pm Pacific in winter, 5 pm in summer); the shared total counts the last 24 hours. When they run out, or the AI provider is briefly unavailable, the tutor pauses and everything else works. It never costs you anything. AI answers can be wrong — check them.

## Younger testers

Inkling is meant for students of every age. For a tester under 18, a parent or guardian should read this guide and the privacy notice first, install Inkling, and be the one who clicks **Allow** for the AI — or keep the AI off. Remind younger testers never to put names, addresses, photos or other personal details on a page they ask the AI about.

## Feedback

Use **Help → Send Feedback or Report a Problem** (also in *Settings*), or the feedback link on the [download page](https://supergithubduo.github.io/inkling-notebook/#feedback). More in [SUPPORT.md](../SUPPORT.md). It takes about 3 minutes. **Please don't paste or upload notebook contents, screenshots of personal notes, or anything sensitive.** Describe what happened instead.

## Uninstall

- **Windows:** *Settings → Apps → Installed apps → Inkling → Uninstall*.
- **macOS:** drag Inkling from Applications to the Bin.

Your notebooks are kept. To remove them too, delete the Inkling folder listed above. If Inkling ever says it **repaired** your library, nothing was thrown away; *Settings → Storage → Backups* restores any of the last 7 daily backups.
