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

You can ignore every other file below (`.zip`, `.blockmap`, `.yml`): Inkling uses them to check for updates.

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
- **The AI tutor is free but limited:** about 10 answers a day per computer (resetting at 00:00 UTC), and about 110 in any 24 hours for everyone together.
- **Only what you ask about is sent**, after you click *Allow*: your question and the selection or page text you include, to Inkling's server on Cloudflare (model: Qwen on Workers AI). It isn't stored, and Cloudflare says it doesn't keep it or train on it. Don't send personal or sensitive information. AI answers can be wrong.
- **Under 18?** A parent or guardian installs Inkling and decides whether to allow the AI (see the install guide).

### What's new

See [RELEASE_NOTES.md](https://github.com/SuperGithubDuo/inkling-notebook/blob/v{{VERSION}}/RELEASE_NOTES.md).

### Known limitations

Not yet tested by people with real pens and touch screens — that's what we most want to hear about. Handwriting isn't searchable. No iPad, Android or web version.

### Feedback

*Help → Send Feedback or Report a Problem* in the app, or {{FEEDBACK}}. No account needed. **Please don't include notebook contents or screenshots of personal notes.**

<sub>Built and tested from commit {{COMMIT}} ({{RUN}}).</sub>
