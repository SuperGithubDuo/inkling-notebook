# Building and releasing Inkling

Inkling ships as a Windows installer (`.exe`, NSIS) and a macOS disk image (`.dmg`), built by electron-builder (`electron-builder.yml`). Installers are built on GitHub Actions, on real Windows and macOS machines. You can also build one locally on a machine running that system.

## Versions

The version in `package.json` is the app version, shown in About and used by updates.
- Beta builds use pre-release versions: `0.2.0-beta.1`, `0.2.0-beta.2`, …
- Beta builds follow pre-releases; stable builds (`1.0.0`) don't.

To change the version: `npm version 0.2.0-beta.2 --no-git-tag-version`, commit, then tag (below).

## Build on GitHub (recommended)

The workflow is `.github/workflows/release.yml`.

1. **Installers to test.** Go to GitHub → Actions → **Release** → *Run workflow*. When it finishes, download **inkling-windows-latest** and **inkling-macos-latest** from the run's *Artifacts*. Nothing is published.
2. **A release.** Tag the commit and push the tag:
   ```bash
   git tag v0.2.0-beta.1
   git push origin v0.2.0-beta.1
   ```
   The workflow builds both installers and uploads them to a **draft** GitHub release, together with the `latest*.yml` files that in-app updates read. A draft is invisible to users: review it, add the release notes (`RELEASE_NOTES.md`), tick *Set as a pre-release* for betas, then press **Publish**. Only published releases reach users or their update checks.

Every run first passes these on Linux:
- the typecheck, unit tests and the full acceptance suite
- the large-notebook check
- a smoke test of the packaged app

Each installer job then runs the unit tests and the packaged-app smoke test on its own system. A separate job runs the acceptance suite on Windows and macOS.

### Repository settings the workflow reads

| Name | Kind | Purpose |
|---|---|---|
| `INKLING_BETA_URL` | Variable | The cloud AI beta server built into the app (`https://inkling-ai-beta.<you>.workers.dev`). Leave unset to ship without cloud AI. |
| `INKLING_FEEDBACK_URL` | Variable | Where *Send feedback* goes: an `https://` form or a `mailto:` address. The default is a new GitHub issue, which needs a GitHub account. |
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

## Release checklist

1. All workflow jobs green. The Windows and macOS acceptance jobs are real systems, but not real stylus hardware.
2. Install the built `.exe` and `.dmg` on a real Windows PC and Mac, and go through `docs/DEVICE-TESTING.md`.
3. Update `RELEASE_NOTES.md`. Bump the version.
4. Tag, wait for the draft, check its assets: `.exe` ×2, `.dmg` ×2, `.zip` ×2, `latest.yml`, `latest-mac.yml`, `.blockmap` files.
5. Publish as a pre-release. Announce to testers with `docs/INSTALL.md`.
