## Inkling {{VERSION}}

A handwriting notebook for Windows and Mac, with a free AI tutor that reads your working. **No account, key or other software needed.**

### ⬇ Download — pick one file

The easiest way is the **[download page]({{DOWNLOAD_PAGE}})**. Or download directly:

| Your computer | Download |
|---|---|
| **Windows 10 or 11** (ARM PCs too, through Windows' emulation) | [**Inkling-Setup-{{VERSION}}-x64.exe**](https://github.com/SuperGithubDuo/inkling-notebook/releases/download/v{{VERSION}}/Inkling-Setup-{{VERSION}}-x64.exe) |
| **Mac with Apple silicon** (M1 or later), macOS 12+ | [**Inkling-{{VERSION}}-arm64.dmg**](https://github.com/SuperGithubDuo/inkling-notebook/releases/download/v{{VERSION}}/Inkling-{{VERSION}}-arm64.dmg) |
| **Mac with Intel**, macOS 12+ | [**Inkling-{{VERSION}}-x64.dmg**](https://github.com/SuperGithubDuo/inkling-notebook/releases/download/v{{VERSION}}/Inkling-{{VERSION}}-x64.dmg) |

Not sure which Mac you have? *Apple menu → About This Mac*: "Chip: Apple M…" means Apple silicon; "Processor: … Intel" means Intel.

You can ignore every other file below (`.zip`, `.blockmap`, `.yml`, `.json`): Inkling uses them to check for updates.

### ⚠️ First open: security prompt

This beta isn't code-signed yet, so your computer can't verify who published it.
- **Windows:** "Windows protected your PC" → *More info* → check the file name → *Run anyway*.
- **macOS:** open Inkling once, then *System Settings → Privacy & Security → Open Anyway*.

Only install Inkling from the download page or this release, and don't install it on a school- or work-managed computer without permission. Step-by-step help: [install guide](https://github.com/SuperGithubDuo/inkling-notebook/blob/v{{VERSION}}/docs/INSTALL.md). Unsigned builds can't update themselves; Inkling tells you when a new version is out.

<details>
<summary>SHA-256 checksums (optional: check your download)</summary>

```
{{SHA256SUMS}}
```

Windows (PowerShell): `Get-FileHash .\Downloads\<file>` · macOS (Terminal): `shasum -a 256 ~/Downloads/<file>`
</details>

### Your notebooks and the AI

- **Notebooks stay on your computer.** No account, no cloud storage; we can't see them. Updating or uninstalling keeps them.
- **The AI tutor is free but limited:** about 12 answers a day per computer (resetting at 00:00 UTC), a monthly limit per computer, and a shared budget for everyone, so on a busy day it can stop earlier. The tutor shows how much is left.
- **Nothing is sent until you click *Allow*** — not even a check of how many answers are left. Then each question sends Inkling's server on Cloudflare your question, the selection or page you include (image, title, typed and PDF text), and the recent conversation on that page. It is answered by Qwen 3.8 27B, hosted by DeepInfra (United States), with Cloudflare Workers AI as a backup. Inkling's server doesn't store it. Both companies say they don't train on it or keep it after answering, apart from limited exceptions such as support cases and legal obligations. An anonymous installation ID and your internet address go with it for the limits, kept only as scrambled counts (daily ones replaced every day, each computer's monthly one at the end of the month). Updating from an earlier version, Inkling asks for permission again because the notice changed. Don't send personal or sensitive information. AI answers can be wrong.
- **Under 18?** Inkling doesn't check ages, and clicking *Allow* isn't verified parental consent; one *Allow* covers everyone on that computer account. A parent or guardian should read the privacy notice (a draft pending legal review), install Inkling and decide whether to allow the AI (see the install guide).

### What's new

See [RELEASE_NOTES.md](https://github.com/SuperGithubDuo/inkling-notebook/blob/v{{VERSION}}/RELEASE_NOTES.md).

### Known limitations

Not yet tested by people with real pens and touch screens — that's what we most want to hear about. AI answers can be wrong, including the answers to practice problems; check them. Prefer nothing to leave your computer? The local Ollama tutor is still available. Handwriting isn't searchable. No iPad, Android or web version.

### Feedback

*Help → Send Feedback or Report a Problem* in the app, or {{FEEDBACK}}. **Please don't include notebook contents or screenshots of personal notes.**

<sub>Built and tested from commit {{COMMIT}} ({{RUN}}).</sub>
