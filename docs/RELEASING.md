# Building and releasing Inkling

Inkling ships as a Windows installer (`.exe`, NSIS) and a macOS disk image (`.dmg`), built by electron-builder (`electron-builder.yml`). Installers are built on GitHub Actions, on real Windows and macOS machines. You can also build one locally on a machine running that system.

## Versions

The version in `package.json` is the app version, shown in About and used by updates.
- Beta builds use pre-release versions: `0.2.0-beta.1`, `0.2.0-beta.2`, …
- Beta builds follow pre-releases; stable builds (`1.0.0`) don't.

To change the version: `npm version 0.2.0-beta.3 --no-git-tag-version`, then commit. A published version can't be rebuilt: the workflow refuses to touch it, so bump the version first.

## Build on GitHub (recommended)

The workflow is `.github/workflows/release.yml`. It runs on GitHub's Windows and macOS machines; nothing needs installing on yours.

### Start a build

*Actions → Release → Run workflow*, branch `main`, and choose:

| Choice | Builds |
|---|---|
| `windows` | Windows installer |
| `macos` | macOS installers |
| `both` | both |
| `draft-release` | both, **and uploads them to the draft release `v<version>`** (see *Publish* below) |

Fallback without the button: push a branch named `build/windows`, `build/macos`, `build/draft-release` (any other `build/…` name builds both), and delete it afterwards:

```bash
git fetch origin
git push origin origin/main:refs/heads/build/windows && git push origin --delete build/windows
```

Pushing a `v*` tag does **not** start a build: pressing Publish creates the tag.

### Get the installers

Open *Actions → Release*, then the run, then **Artifacts** at the bottom of the summary. You need to be signed in to GitHub.
- `inkling-Windows` contains `Inkling-Setup-<version>-x64.exe`.
- `inkling-macOS` contains the `.dmg` files (arm64 and x64) and the `.zip` files used for updates.

Nothing is published as a release. Note that this repository is public, so anyone signed in to GitHub who finds the run can download its artifacts. They aren't announced or linked anywhere, and they expire after 90 days.

### What every build checks

| Job | Where | What |
|---|---|---|
| Checks (Linux) | Ubuntu | typecheck, unit tests, production build, beta-server typecheck and bundle |
| Installer | Windows / macOS | unit tests on that system, the installers, the packaged-app smoke test, then the **installer lifecycle**: install (silent NSIS / copy from the DMG) → use (handwriting, PDF import and export) → install a newer build over it → uninstall → reinstall. The notebooks must be unchanged after every step. |
| Acceptance | Windows / macOS | every end-to-end suite, each as its own step (Phase 1–4, regressions, Ollama, cloud beta, layout, release, large notebook) |

When a step fails, its key error lines appear as annotations on the run summary, and screenshots are in the `test-results-*` artifacts.

### Publish a release (only with approval)

**Make the draft.** *Actions → Release → Run workflow*, branch `main`, platforms **draft-release**.

The workflow creates the draft pre-release `v<version>` (or reuses it, pointing it at the new commit; it refuses to touch a published one), builds and tests both installers on real Windows and macOS machines, and uploads them. When every job has passed, *Draft release notes* runs `scripts/release/finalize-draft.mjs`, which:

- checks the draft targets the commit that was built, and that every file carries the version;
- downloads every file and checks each installer's SHA-256 against the one computed on the build machine and GitHub's own digest;
- checks the update metadata (`latest.yml`, `latest-mac.yml`): right version, and the files it points at exist with the SHA-512 and size it claims;
- replaces the two per-OS checksum files with one `Inkling-<version>-SHA256SUMS.txt`;
- writes user-friendly notes from `.github/release-notes.md` (download table with direct links, the security prompt, checksums, privacy, feedback), ending with a hidden **verified-build marker**.

If anything failed, the draft says **DO NOT PUBLISH** instead and carries no marker. The git tag is only created when someone presses **Publish**. Running it again replaces the draft's files (and changes their checksums).

**Publishing is the approval.** Nothing publishes automatically. Review the draft, then press **Publish** (tick *Set as a pre-release* for betas). The download site then follows within minutes: it offers the newest published release that has the verified-build marker, whose tag points at the verified commit and whose installers still match the verified checksums. A release published without the marker, or one whose notes say DO NOT PUBLISH or WITHDRAWN, is never offered. To take a release off the download page, add its tag to `withdrawn` in `site/config.json` (or write WITHDRAWN in its notes). See [Download site](#download-site) below.

### Repository settings the workflow reads

| Name | Kind | Purpose |
|---|---|---|
| `INKLING_BETA_URL` | Variable | The cloud AI beta server built into the app (`https://inkling-ai-beta.<you>.workers.dev`). Leave unset to ship without cloud AI. |
| `INKLING_FEEDBACK_URL` | Variable | Where *Send feedback* goes: an `https://` form or a `mailto:` address. The default is a new GitHub issue, which needs a GitHub account. |
| `INKLING_DOWNLOAD_PAGE_URL` | Variable | Optional. The download page linked from release notes. Default `https://supergithubduo.github.io/inkling-notebook/`. |
| `INKLING_SITE_ENABLED` | Variable | Kill switch: `false` stops the *Download site* workflow from deploying. Deploys otherwise happen only when *Settings → Pages → Source* is *GitHub Actions*. |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Secrets | Developer ID Application certificate (`.p12`, base64-encoded) and its password. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Secrets | Notarization with Apple. |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Secrets | Windows code-signing certificate (`.pfx`, base64) and password. |

`GITHUB_TOKEN` is provided by Actions. The workflow needs *Settings → Actions → General → Workflow permissions: Read and write* so it can create draft releases.

## Signing and notarization

| | Without credentials | With credentials |
|---|---|---|
| **Windows** | Builds and installs. On first run SmartScreen shows "Windows protected your PC", and users click *More info → Run anyway*. Updates install in-app. | Signed with your certificate. An EV certificate, or Azure Trusted Signing, removes the SmartScreen warning at once. A standard OV certificate builds reputation over time. Updates are also checked to come from the same publisher. |
| **macOS** | Ad-hoc signed so it runs on Apple silicon. Gatekeeper blocks the first open: users go to *System Settings → Privacy & Security → Open Anyway*. In-app updates can't install themselves; Inkling shows a *Download* link instead. | Signed with your Developer ID, notarized and stapled: opens normally, and updates install in-app. |

**Unsigned builds are for testers who have been told about the warnings. They are not production-ready.** For a public launch you need:
- **macOS:** an Apple Developer Program membership ($99 a year) and a *Developer ID Application* certificate.
- **Windows:** a code-signing certificate or Azure Trusted Signing.

To export the Mac certificate for the workflow, export it from Keychain Access as a `.p12`, then run `base64 -i cert.p12 | pbcopy` and paste the result into `MAC_CSC_LINK`.

## Build locally

```bash
npm ci
npm run dist:win     # on Windows → release/Inkling-Setup-<version>-x64.exe
npm run dist:mac     # on macOS   → release/Inkling-<version>-arm64.dmg, -x64.dmg, and .zip files for updates
npm run dist:linux   # on Linux, for testing only → release/linux-unpacked/, AppImage
```

The macOS DMG can't be built on Windows or Linux. The Windows installer can be built on Linux only with Wine installed. `npm run dist*` regenerates `THIRD_PARTY_NOTICES.txt`, and the build stops if a dependency has a copyleft or unknown licence.

Set `MAIN_VITE_INKLING_BETA_URL=…` before building to include the cloud AI beta server.

## Updates

Install once, then: **open Inkling → the update downloads in the background → Restart & Update → done.** No uninstalling, no installer to download. Code: `src/main/updater.ts` (electron-updater with GitHub Releases, `publish:` in `electron-builder.yml`), decisions in `src/main/updatePolicy.ts`, interface in `src/renderer/src/app/Updates.tsx`.

**For users**
- Inkling checks 15 seconds after it starts and every 6 hours (30 minutes after a failed attempt). *Settings → Updates → Check for Updates* (or *Help → Check for Updates…*) checks now.
- The download runs in the background. A small notice in the bottom-left corner shows its progress, then *Inkling X is ready* with **Restart & Update** and **Later**. The notice appears only after a few seconds without pen, mouse or keyboard input, never takes focus, and nothing restarts unless the user clicks.
- **Later** leaves everything as it is. Nothing is installed on quit; the next start offers the already downloaded update again.
- **Restart & Update** first, in this order: checks the release's update approval again, saves every notebook, takes a *Before update* snapshot (the newest 3 are kept, under *Settings → Storage → Backups*), and records the pending update. If any step fails (offline, saving fails, the backup can't be made, the record can't be written), Inkling doesn't restart or install anything: the notice says what happened, and *Try again* is right there. Only then does it install silently and open the new version. The first start after an update says *Updated to Inkling X*, or, if the installer didn't finish, that it didn't and that the notebooks weren't changed; the update is offered again.

**Channels.** *Settings → Updates → Release channel*: **Stable** or **Beta**. A copy starts on the channel of the version that was installed (`0.2.0-beta.4` → beta) and saves it in `update-settings.json` on first start, so it never changes by itself: stable copies never see betas, and a beta tester who receives a stable release stays on beta and gets the next beta. Switching to stable never downgrades; a beta stays until a newer stable release is out. (electron-updater: `allowPrerelease` = beta, `allowDowngrade` = false.) A release is a beta when GitHub marks it *pre-release*, which the Release workflow does for any version with a `-`.

**Nothing unfinished is ever installed.**
1. GitHub never lists draft releases, so a draft can't be found by the app.
2. An update is downloaded only when its release also carries `Inkling-<version>-update-approval.json`. `finalize-draft.mjs` uploads it as the very last step, only after every build, test and file check passed, and it lists the exact SHA-512 of each file `latest*.yml` points at (`checkApproval` in `scripts/release/rules.mjs`). The app refuses the update if the approval is missing, is for another version, or doesn't match the files (e.g. installers rebuilt after verification). A failed run deletes it, and so does every rebuild of a draft before its new checks. So publishing a draft marked *DO NOT PUBLISH* still doesn't reach installed copies.
3. **To withdraw an update** that is already published, delete its `…-update-approval.json` asset from the release (and add it to `site/config.json` `withdrawn` for the download page). It takes effect for copies that already downloaded it too: the approval is fetched again before *Restart & Update* (if it can't be fetched, e.g. offline, the update waits), by the periodic check while the update is waiting (the notice goes away), and at every start. The downloaded file stays in the updater's cache and is never installed. Limits: a copy that already restarted into it keeps it (publish a newer fixed version), and GitHub's download CDN can serve a deleted file for a few minutes.

**Integrity is not authentication.** They protect against different things:
- **Integrity** (every build): electron-updater checks each download against the SHA-512 in `latest*.yml` and discards it otherwise; Inkling only downloads files whose SHA-512 the update approval lists; everything comes over HTTPS from GitHub. This catches corrupted, truncated or swapped files and installers rebuilt after verification. It does **not** prove who published the release: the metadata, the approval and the installer all come from the same GitHub release, so anyone who could publish there (e.g. with a stolen token or account) could publish a matching set.
- **Authentication** (signed builds only): a code signature proves the publisher. A signed Windows build records its publisher, and electron-updater then refuses any update not signed by that same publisher; Squirrel.Mac requires the same Developer ID.

So **unsigned builds are beta/testing only**, for testers who chose to install an unsigned beta:
- The app installs updates itself without a signature only when it is a beta (prerelease) version; an unsigned stable build only announces updates (`resolveMode`, `src/main/updatePolicy.ts`), and Settings → Updates says that updates aren't publisher-verified.
- The Release workflow refuses to make an unsigned stable release: the installer job fails a `draft-release` of a non-prerelease version without signing secrets, and `finalize-draft.mjs` refuses to approve one unless both Windows and macOS were signed. Unsigned builds are annotated "integrity-checked (SHA-512), NOT publisher-authenticated".

| | Unsigned (betas only) | Signed (required for stable) |
|---|---|---|
| **Windows** | Betas install updates themselves: integrity-checked, not publisher-authenticated. Running the installer from inside Inkling doesn't show SmartScreen. | Updates install themselves and must be signed by the same publisher. The first signed release installs over unsigned ones normally; from then on only that publisher's updates are accepted, so keep using the same certificate subject. |
| **macOS** | Ad-hoc signed: Squirrel.Mac refuses to install updates into it. Inkling announces the update with a *Download* link instead (the user installs the new DMG over the old app; notebooks stay). | Developer ID + notarized: updates install in-app like Windows. The workflow switches this on by itself when the signing secrets exist. |
| **Linux** | Not distributed. The same updater runs for AppImages, but only in the automated test. | — |

**Differential downloads.** The `.blockmap` files on each release let electron-updater download only the parts that changed (Windows: compared with the previous release's blockmap; macOS: the `.zip`). In the update test, a build that differed only in its version downloaded 0.3 MB of 130 MB. If the previous release's blockmap is gone (e.g. skipped versions where the old release was deleted), it downloads the whole file. Keep every release's files on GitHub.

**Migrating from 0.2.0-beta.3 and earlier.** Those builds never check for updates: their updater failed to load (electron-updater's `autoUpdater` was read as a named ES-module export, which is `undefined`; fixed in `updater.ts`). Testers on beta.2/beta.3 install the next release once, by running its installer (Windows installs over the old version; on macOS, drag the new app over the old one). Notebooks, settings and backups carry over, as the upgrade test in the Release workflow checks. Every update after that is in-app.

**Cost.** $0: GitHub Releases hosts the files and serves the update metadata; no update server.

**Tested by** `tests/e2e/update.e2e.mjs` (Release workflow, Windows and macOS runners; Linux AppImage locally): from an installed build A to the next-version build B through a local stand-in for GitHub Releases. It checks that an unapproved or mismatched release is never downloaded; a corrupt download is discarded and A keeps running; an interrupted download fails cleanly and the next check completes it (differentially); *Later* installs nothing on quit and the next start offers the downloaded file without downloading it again; *Restart & Update* does not restart when the before-update backup fails, when the pending-update record can't be written, or when the update was withdrawn after downloading (and a withdrawn update is dropped by the next check and the next start); then *Restart & Update* installs B in place, every notebook file is byte-identical, settings and channel are kept, and the update is recorded. Unit tests: `tests/unit/updater.test.ts`, `tests/unit/release-site.test.ts`.

```bash
npm run build && npx electron-builder --linux AppImage --publish never
npx electron-builder --linux AppImage --publish never -c.extraMetadata.version=<version>.test1 -c.directories.output=release-next
xvfb-run -a npm run test:update -- release/Inkling-<version>-x86_64.AppImage release-next release
```

Development builds and `npm start` never check. `INKLING_DISABLE_UPDATES=1` turns checks off in an installed build.

## What updates and uninstalling never touch

Notebooks, backups and settings live in the user's app-data folder, never inside the application:

| System | Folder |
|---|---|
| Windows | `%APPDATA%\Inkling\` |
| macOS | `~/Library/Application Support/Inkling/` |
| Linux | `~/.config/Inkling/` |

Inside it:
- `Library\` holds the notebooks.
- `Backups\` holds the daily snapshots.
- `ai-settings.json`, `gemini-key.bin` and `beta-access.bin` hold the tutor settings and encrypted keys.
- `update-settings.json` holds the release channel and the outcome of the last update.

Downloaded updates wait in a separate cache (`%LOCALAPPDATA%\inkling-updater\` on Windows, `~/Library/Caches/inkling-updater/` on macOS) and are removed after installing.

The Windows uninstaller is configured with `deleteAppDataOnUninstall: false`. Reinstalling, or installing a new version over an old one, opens the same library. Files saved by a newer version are never overwritten by an older one: the older app refuses to open them and asks for an update.

## Watching and pausing the free AI server

*Actions → AI server emergency switch → Run workflow* (`.github/workflows/beta-server-ops.yml`). It uses the `INKLING_ADMIN_TOKEN` secret, so nobody else can run these against the server.

| Choice | Does |
|---|---|
| `summary` | Read-only: spending in the last 24 h against the daily cap ($0.25, lower when the month needs pacing), the month against $5, answers, tokens, installations, networks, whether paused. Older apps' Workers AI use (Neurons) is reported separately. Shown as the run's annotation and summary. |
| `pause` | Stops all AI answers at once, on DeepInfra and on the Workers AI bridge for older apps (the app says the AI is paused; notebooks work). |
| `resume` | Turns AI answers back on. |

Fallback: push a branch `ops/summary`, `ops/pause` or `ops/resume`, then delete it. With the token on your own computer, `cd beta-server && npm run admin -- summary` does the same. *AI production verify* (`.github/workflows/ai-production-verify.yml`) checks the deployed server after a provider switch: Cloudflare's settings, both ledgers, and four short answers (about $0.002). *Actions → Cloudflare AI diagnostics → Run workflow* shows the account's hourly Workers AI use and whether Cloudflare accepts requests right now; Cloudflare's dashboard (*Workers AI → Usage*) shows its own count.

## Release checklist

1. All workflow jobs green. The Windows and macOS jobs run on real systems (virtual machines), but without real pens or touch screens.
2. Install the built `.exe` and `.dmg` on a real Windows PC and Mac, and go through `docs/DEVICE-TESTING.md`. The workflow also installs the build over the last published release (*Upgrade from the last published release*) on both systems.
3. Update `RELEASE_NOTES.md`. Bump the version.
4. *Run workflow → draft-release*; when it's green, check the draft's assets: one `.exe`, two `.dmg`, two `.zip`, `Inkling-<version>-SHA256SUMS.txt`, `latest.yml`, `latest-mac.yml`, `.blockmap` files, and that the notes contain no DO NOT PUBLISH.
5. Publish as a pre-release. The download site follows within minutes. Announce to testers with `docs/INSTALL.md`.

## Download site

How an approved build reaches a first-time user in one click, and why an unapproved or failed build never can.

**Status:** live since 3 Nov 2026 (GitHub Pages, deployed from `main`). It offers the newest approved release (`v0.2.0-beta.2`, published 3 Nov 2026, until the next one is published).

- Address (GitHub Pages, free): `https://supergithubduo.github.io/inkling-notebook/`
- Source: `site/` (one page, no frameworks, no third-party requests, fonts and images self-hosted)
- Build: `scripts/site/build-site.mjs` · Deploy gate: `scripts/site/check-site.mjs` · Rules: `scripts/release/rules.mjs`
- Workflow: `.github/workflows/pages.yml` · Tests: `tests/unit/release-site.test.ts` and `tests/unit/site-platform.test.ts` (part of `npm test`); `tests/e2e/site.e2e.mjs` (`npm run test:e2e:site`: the built page in Chromium as Windows, Mac, phone and Linux visitors, 320–1280 px)
- Which installer is recommended: `site/assets/platform.js` (Windows; Apple-silicon vs Intel Mac from the GPU name, then the browser's own architecture; both Macs when unsure, as in Safari; all three on other computers; none at the top on phones)

### From commit to download

```
 Run workflow →                    Release workflow                        You                      Download site workflow
 "draft-release"             ┌──────────────────────────────┐                                ┌───────────────────────────────┐
                        ───▶ │ build + test on Windows/macOS │                                │ newest PUBLISHED release that: │
                             │ upload to DRAFT v<version>    │      review the draft          │  • has the verified marker     │
                             │ finalize-draft.mjs:           │ ───▶ press **Publish**  ───▶   │  • tag = verified commit       │
                             │  version, commit, SHA-256,    │      (the approval)            │  • installers = verified SHA   │
                             │  update metadata, one sums    │                                │  • not DO NOT PUBLISH/withdrawn│
                             │  file, notes + marker         │                                │ → page with 3 direct links     │
                             │ any failure → DO NOT PUBLISH  │                                │ none → "no download yet"       │
                             └──────────────────────────────┘                                └───────────────────────────────┘
```

1. **Build.** Unchanged from today: installers are built and every acceptance suite, the packaged-app test and the install → update → uninstall → reinstall check run on real Windows and macOS runners, then upload to a **draft** release.
2. **Verify** (`scripts/release/finalize-draft.mjs`, only when every job passed). It refuses, and marks the draft **DO NOT PUBLISH**, unless:
   - the draft targets the commit that was built, and is still a draft;
   - every file carries the version (the two `latest*.yml` excepted), and the three installers are present;
   - each installer's SHA-256 equals the one computed on the build machine *and* GitHub's own asset digest;
   - `latest.yml` and `latest-mac.yml` name this version, and every file they point at exists with the SHA-512 and size they claim (so in-app update checks won't break).
   Then it replaces the two per-OS checksum files with **one** `Inkling-<version>-SHA256SUMS.txt` and writes the notes (below) with a hidden marker recording version, commit, run and the three SHA-256s.
3. **Approve.** You press **Publish** on the draft. Nothing in any workflow publishes; the `draft` job refuses to modify an already published release.
4. **Site follows.** Publishing (or editing, unpublishing, deleting) a release triggers the *Download site* workflow, which hands over to a run on `main`, rebuilds the page and deploys it. A 3-hourly run is a safety net. The page embeds the chosen release at build time; visitors' browsers never query GitHub.

### Why a bad build can't be downloaded from the site

| Situation | Result |
|---|---|
| Draft | Not offered: drafts are never public and the rules skip them |
| Failed build ("DO NOT PUBLISH") | No marker, and the phrase itself blocks it, even if someone presses Publish |
| Published by hand without the Release workflow | No marker → not offered |
| Installer replaced after verification | GitHub's digest no longer matches the marker → not offered |
| Tag moved to another commit | Tag commit ≠ verified commit → not offered |
| Release later found bad | Add its tag to `withdrawn` in `site/config.json` (or write WITHDRAWN in its notes): the page falls back to the previous good release, or to "no download yet" |
| Anything else on the page | `check-site.mjs` fails the deploy if the page links to workflow runs/artifacts, draft (`untagged-`) URLs, any download link outside the verified data, or has preview mode on |

Every row is a unit test in `tests/unit/release-site.test.ts`, including the real shape of the failed Beta 2 draft of 31 Oct.

### What users see

**Page** (`site/index.html`):
- Hero with the version, a *Beta* label, release date and release-notes link, and **one big button for the visitor's computer** (Windows, or the right Mac when the browser can tell; otherwise both Mac buttons with "Which Mac do I have?").
- Three platform cards with file name, size, requirements and SHA-256.
- Install guide (Windows and Mac tabs) with the unsigned-build warning, system requirements, privacy summary, feedback.
- No approved release: buttons are shown disabled with "No download is available yet" and a plain explanation.
- Phones and tablets: a note that Inkling is for Windows and Mac, with *Copy this page's link*; the downloads stay listed.
- Light and dark themes, keyboard navigation, no horizontal scrolling at phone width.

**Release page** (`.github/release-notes.md`): a download table with direct links at the top, then the security-prompt explanation, checksums folded away, privacy and feedback. It tells readers to ignore `.zip`, `.blockmap` and `.yml` files. Those must stay on the release: electron-updater reads `latest*.yml`, signed macOS updates need the `.zip`, and `.blockmap` files make updates smaller.

### Preview locally

```bash
node scripts/site/build-site.mjs --out _site     # live data from GitHub
# then open site/index.html in a browser and add ?preview=sample to the address
# to see the layout with made-up data (download buttons switched off)
```

The `?preview=sample` mode exists only in the unbuilt source; the build turns it off and `check-site.mjs` enforces that.

### Settings

*Settings → Pages → Source: GitHub Actions* is the switch: every run checks it and only deploys when it's on (switched on 3 Nov 2026). Optional variables: `INKLING_FEEDBACK_URL` (the page shows a *Send feedback* button once it's set) and `INKLING_DOWNLOAD_PAGE_URL` (only for a custom domain).

**Kill switch:** set the repository variable `INKLING_SITE_ENABLED` to `false` to stop deploys, and unpublish in *Settings → Pages* to take the site down.

### Later (not done)

- **Point the app at the site.** Unsigned builds' "new version available" link goes to the GitHub release page (`RELEASES_URL` in `src/shared/product.ts`). Pointing it at the download page would be a one-line app change; left alone here because this milestone doesn't change the app.
- **Custom domain** (e.g. `getinkling.app`), after the trademark check in the [launch kit](archive/LAUNCH.md).
- **Signed builds** remove the security prompts and turn on self-installing updates; the release workflow already uses the certificates when the secrets exist.
