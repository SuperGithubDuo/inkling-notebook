# Building and releasing Inkling

Inkling ships as a Windows installer (`.exe`, NSIS) and a macOS disk image (`.dmg`), built by electron-builder (`electron-builder.yml`). Installers are built on GitHub Actions, on real Windows and macOS machines. You can also build one locally on a machine running that system.

## Versions

The version in `package.json` is the app version, shown in About and used by updates.
- Beta builds use pre-release versions: `0.2.0-beta.1`, `0.2.0-beta.2`, …
- Beta builds follow pre-releases; stable builds (`1.0.0`) don't.

To change the version: `npm version 0.2.0-beta.2 --no-git-tag-version`, commit, then tag (below).

## Build on GitHub (recommended)

The workflow is `.github/workflows/release.yml`. It runs on GitHub's Windows and macOS machines; nothing needs installing on yours.

### Start a build

GitHub's *Run workflow* button only lists workflows that exist on the **default branch** (`main`). Until the release work is merged, start builds by pushing a branch whose name starts with `build/`. The branch name picks the platforms:

| Push | Builds |
|---|---|
| `build/windows` | Windows installer |
| `build/macos` | macOS installers |
| `build/all` (or any other `build/…` name) | both |
| `build/draft-release` | both, **and uploads them to the draft release `v<version>`** (see *Publish* below) |

From a clone of the repository:

```bash
git fetch origin
git push origin origin/beta-release:refs/heads/build/windows --force   # Windows from the current beta-release
```

On github.com, without git: open the `beta-release` branch, open the branch menu, type `build/windows` and choose *Create branch build/windows from beta-release*. Pushing the same branch again (with `--force`) starts a new build.

Once the workflow is on `main`: *Actions → Release → Run workflow*, choose the branch (e.g. `beta-release`) and the platforms.

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

**Draft without a public tag (used for Beta 2).** Push `build/draft-release` from the commit to ship:

```bash
git push origin origin/beta-release:refs/heads/build/draft-release --force
```

The workflow creates the draft pre-release `v<version>` (or reuses it, pointing it at the new commit; it refuses to touch a published one), builds and tests both installers on real Windows and macOS machines, and uploads them. When every job has passed, *Draft release notes* runs `scripts/release/finalize-draft.mjs`, which:

- checks the draft targets the commit that was built, and that every file carries the version;
- downloads every file and checks each installer's SHA-256 against the one computed on the build machine and GitHub's own digest;
- checks the update metadata (`latest.yml`, `latest-mac.yml`): right version, and the files it points at exist with the SHA-512 and size it claims;
- replaces the two per-OS checksum files with one `Inkling-<version>-SHA256SUMS.txt`;
- writes user-friendly notes from `.github/release-notes.md` (download table with direct links, the security prompt, checksums, privacy, feedback), ending with a hidden **verified-build marker**.

If anything failed, the draft says **DO NOT PUBLISH** instead and carries no marker. The git tag is only created when someone presses **Publish**. Pushing again replaces the files (and changes their checksums).

**Publishing is the approval.** Nothing publishes automatically. Review the draft, then press **Publish** (tick *Set as a pre-release* for betas). The download site then follows within minutes: it offers the newest published release that has the verified-build marker, whose tag points at the verified commit and whose installers still match the verified checksums. A release published without the marker, or one whose notes say DO NOT PUBLISH or WITHDRAWN, is never offered. To take a release off the download page, add its tag to `withdrawn` in `site/config.json` (or write WITHDRAWN in its notes). See [maintainers/DOWNLOAD-SITE.md](maintainers/DOWNLOAD-SITE.md).

**Or with a tag.** Tag the commit and push the tag (the tag is visible in the public repository at once, though the release stays a draft):

```bash
git tag v0.2.0-beta.1
git push origin v0.2.0-beta.1
```

The workflow builds both installers and uploads them to a **draft** GitHub release, together with the `latest*.yml` files that in-app updates read. A draft is invisible to users. Review it, tick *Set as a pre-release* for betas, then press **Publish**. Only published releases reach users or their update checks.

### Repository settings the workflow reads

| Name | Kind | Purpose |
|---|---|---|
| `INKLING_BETA_URL` | Variable | The cloud AI beta server built into the app (`https://inkling-ai-beta.<you>.workers.dev`). Leave unset to ship without cloud AI. |
| `INKLING_FEEDBACK_URL` | Variable | Where *Send feedback* goes: an `https://` form or a `mailto:` address. The default is a new GitHub issue, which needs a GitHub account. |
| `INKLING_DOWNLOAD_PAGE_URL` | Variable | Optional. The download page linked from release notes. Default `https://supergithubduo.github.io/inkling-notebook/`. |
| `INKLING_SITE_ENABLED` | Variable | `true` lets the *Download site* workflow deploy to GitHub Pages. Unset: the site is built and checked but not deployed. |
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
npm run dist:win     # on Windows → release/Inkling-Setup-<version>-x64.exe (and arm64)
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

Push one of these branches from any branch (and delete it afterwards so it can be pushed again). The workflow is `.github/workflows/beta-server-ops.yml`; it uses the `INKLING_ADMIN_TOKEN` secret, so nobody else can run these against the server.

| Push | Does |
|---|---|
| `ops/summary` | Read-only: today's (UTC) Neurons used of the 9,000 cap, answers, installations, networks, whether paused. Shown as the run's annotation and summary. |
| `ops/pause` | Stops all AI answers at once (the app says the AI is paused; notebooks work). |
| `ops/resume` | Turns AI answers back on. |

```bash
git push origin origin/beta-release:refs/heads/ops/summary && git push origin --delete ops/summary
```

On github.com: open any branch's menu, type `ops/summary`, *Create branch*, then read *Actions → AI server emergency switch*. With the token on your own computer, `cd beta-server && npm run admin -- summary` does the same. Cloudflare's dashboard (*Workers AI → Usage*) shows the account's own Neuron count.

## Release checklist

1. All workflow jobs green. The Windows and macOS jobs run on real systems (virtual machines), but without real pens or touch screens.
2. Install the built `.exe` and `.dmg` on a real Windows PC and Mac, and go through `docs/DEVICE-TESTING.md`.
3. Update `RELEASE_NOTES.md`. Bump the version.
4. Tag, wait for the draft, check its assets: `.exe` ×2, `.dmg` ×2, `.zip` ×2, `latest.yml`, `latest-mac.yml`, `.blockmap` files.
5. Publish as a pre-release. Announce to testers with `docs/INSTALL.md`.
