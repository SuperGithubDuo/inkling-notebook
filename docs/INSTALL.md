# Installing the Inkling beta

Thank you for testing Inkling! This guide takes about five minutes. You don't need anything else installed.

## Windows 10 or 11

1. Download **Inkling-Setup-0.2.0-beta.2-x64.exe**. If your PC has an ARM processor, such as a Surface Pro X or a Copilot+ PC with Snapdragon, download the **-arm64** file instead.
2. Double-click the file. Inkling installs for your user account (no administrator password needed), adds a Start menu and desktop shortcut, and opens.
3. **If Windows shows "Windows protected your PC":** click **More info**, then **Run anyway**. This appears because the beta isn't yet signed with a code-signing certificate.

To uninstall, go to *Settings → Apps → Installed apps → Inkling → Uninstall*. **Your notebooks are kept.** They stay in `%APPDATA%\Inkling`, so reinstalling brings them back.

## macOS 12 or later

1. Download the DMG for your Mac:
   - **Inkling-0.2.0-beta.2-arm64.dmg** for Apple silicon (M1 or later; *Apple menu → About This Mac* shows "Chip: Apple M…").
   - **-x64.dmg** for Intel Macs.
2. Open the DMG and drag **Inkling** into **Applications**.
3. Open Inkling from Applications. **If macOS says it can't verify the developer:** open *System Settings → Privacy & Security*, scroll down, and click **Open Anyway** next to the message about Inkling. Confirm with your password. You only need to do this once.

To uninstall, drag Inkling from Applications to the Bin. Your notebooks stay in `~/Library/Application Support/Inkling`.

## First steps

- A short welcome shows the basics. You can see it again any time with *Help → Getting Started*.
- **Writing:** pick the pen (P), highlighter (H) or eraser (E). Pens and touch screens are supported, and pen pressure is used when your pen reports it. This is one of the things we most want feedback on: please tell us how your pen or tablet behaves.
- **Selecting:** circle your work with the lasso (L) to move it, resize it, or ask the AI tutor about it.
- **Saving:** automatic, half a second after each change. The top bar shows *Saved*.
- **Backups:** Inkling keeps a copy of your whole library every day for the last 7 days. *Settings → Storage → Back up now* saves a copy wherever you like, for example a USB drive.

## The AI Tutor (beta)

The tutor is optional. Everything else works without it.
- **Inkling AI (cloud), the default.** Ready as soon as Inkling is installed: no account, code or key. Answers are free, with a daily limit (about 10 on each computer). The first time you ask, Inkling asks your permission to send what you ask about.
- **Ollama.** Runs a model on your own computer. Free and private, but it's a 2–6 GB download and needs a reasonably powerful computer.

Nothing from your notebook is sent anywhere until you agree and ask a question. *Help → Privacy* explains what is sent.

## Something went wrong?

Use **Help → Send Feedback or Report a Problem**. It opens a form with your Inkling version and system already filled in. Describe what happened and, if you can, the steps to make it happen again. No notebook content is attached.

If Inkling ever reports that it **repaired** your library, everything it found is kept. Pages it couldn't match to a notebook appear as *Recovered*. You can also restore any daily backup from *Settings → Storage → Backups*.
