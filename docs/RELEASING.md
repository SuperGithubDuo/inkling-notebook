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
| **Windows** | Builds and installs. On first run SmartScreen shows "Windows protected your PC", and users click *More info → Run anyway*. | Signed with your certificate. An EV certificate, or Azure Trusted Signing, removes the SmartScreen warning at once. A standard OV certificate builds reputation over time. Updates are also checked to come from the same publisher. |
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

In-app updates use electron-updater with GitHub Releases, configured by `publish:` in `electron-builder.yml`.
- The app checks 15 seconds after start and every 6 hours. *About → Check for updates* checks on demand.
- **Integrity.** Every download is checked against the SHA-512 in the release's `latest.yml`. On Windows a signed build also checks that the update is signed by the same publisher. On macOS, Squirrel only accepts an update signed with the same Developer ID.
- **Never silent.** Signed builds download in the background and show *Restart to update*. Before restarting, Inkling saves every notebook and takes a *before update* snapshot. Unsigned builds only say a new version exists, with a link to its release page.
- Development builds and `npm start` never check.

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

The Windows uninstaller is configured with `deleteAppDataOnUninstall: false`. Reinstalling, or installing a new version over an old one, opens the same library. Files saved by a newer version are never overwritten by an older one: the older app refuses to open them and asks for an update.

## Watching and pausing the free AI server

*Actions → AI server emergency switch → Run workflow* (`.github/workflows/beta-server-ops.yml`). It uses the `INKLING_ADMIN_TOKEN` secret, so nobody else can run these against the server.

| Choice | Does |
|---|---|
| `summary` | Read-only: Neurons used in the last 24 h of the 9,000 cap, today's use, answers, installations, networks, whether paused. Shown as the run's annotation and summary. |
| `pause` | Stops all AI answers at once (the app says the AI is paused; notebooks work). |
| `resume` | Turns AI answers back on. |

Fallback: push a branch `ops/summary`, `ops/pause` or `ops/resume`, then delete it. With the token on your own computer, `cd beta-server && npm run admin -- summary` does the same. *Actions → Cloudflare AI diagnostics → Run workflow* shows the account's hourly Workers AI use and whether Cloudflare accepts requests right now; Cloudflare's dashboard (*Workers AI → Usage*) shows its own count.

## Release checklist

1. All workflow jobs green. The Windows and macOS jobs run on real systems (virtual machines), but without real pens or touch screens.
2. Install the built `.exe` and `.dmg` on a real Windows PC and Mac, and go through `docs/DEVICE-TESTING.md`.
3. Update `RELEASE_NOTES.md`. Bump the version.
4. *Run workflow → draft-release*; when it's green, check the draft's assets: one `.exe`, two `.dmg`, two `.zip`, `Inkling-<version>-SHA256SUMS.txt`, `latest.yml`, `latest-mac.yml`, `.blockmap` files, and that the notes contain no DO NOT PUBLISH.
5. Publish as a pre-release. The download site follows within minutes. Announce to testers with `docs/INSTALL.md`.

## Download site

How an approved build reaches a first-time user in one click, and why an unapproved or failed build never can.

**Status:** live since 3 Nov 2026 (GitHub Pages, deployed from `main`). It has offered `v0.2.0-beta.2` since that release was published on 3 Nov 2026, 05:17 UTC.

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
