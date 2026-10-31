**Inkling {{VERSION}}: invited beta.** A handwriting notebook for Windows and Mac with a free AI tutor. Please follow the [tester guide](https://github.com/SuperGithubDuo/inkling-notebook/blob/v{{VERSION}}/docs/INSTALL.md); it takes about 10 minutes.

### Download one file

| Your computer | File |
|---|---|
| Windows 10 or 11 (ARM PCs too, through Windows' emulation) | **`Inkling-Setup-{{VERSION}}-x64.exe`** |
| Mac with Apple silicon (M1 or later), macOS 12+ | **`Inkling-{{VERSION}}-arm64.dmg`** |
| Mac with Intel, macOS 12+ | **`Inkling-{{VERSION}}-x64.dmg`** |

Ignore the `.zip`, `.blockmap` and `.yml` files: Inkling uses them to check for updates.

### ⚠️ Not code-signed

Windows ("Windows protected your PC" → *More info* → *Run anyway*) and macOS (*System Settings → Privacy & Security → Open Anyway*) warn the first time, because they can't verify who published this app or that it wasn't changed. Install only from the link you were sent, compare the SHA-256 below, and don't install on a computer you aren't allowed to install software on. Unsigned builds can't update themselves; Inkling tells you when a new beta is out.

```
{{SHA256SUMS}}
```

### Your notebooks and the AI

- **Notebooks stay on your computer.** No account, no cloud storage; we can't see them. Updating or uninstalling keeps them.
- **The AI tutor is free but limited:** about 10 answers a day per computer (about 110 a day for all testers together), resetting at 00:00 UTC. No account, key or download needed.
- **Only what you ask about is sent**, after you click *Allow*: your question and the selection or page text you include, to Inkling's server on Cloudflare (model: Qwen on Workers AI). It isn't stored, and Cloudflare says it doesn't keep it or train on it. Don't send personal or sensitive information. AI answers can be wrong.

### What's new since the last internal build

- The "answers left today" count now updates after every AI answer, without restarting.
- Tutor chats are not saved (the chat says so); marks you add to the page are.

### Known limitations

Not yet tested by people with real pens and touch screens — that's what we most want to hear about. Handwriting isn't searchable. No iPad, Android or web version.

### Feedback

*Help → Send Feedback or Report a Problem*, or {{FEEDBACK}}. No account needed. **Please don't include notebook contents or screenshots of personal notes.**

<sub>Built and tested from commit {{COMMIT}} ({{RUN}}).</sub>
