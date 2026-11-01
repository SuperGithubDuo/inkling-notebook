# Evidence notes

Collected by Hermes on 2026-10-31 UTC (2026-10-30 Pacific).

## Artifact and execution

- Downloaded **fresh** from successful Release run 41147420893, artifact 13021637988, commit 4ea46be4c38ee912803b672daf08a4bf72706424.
- Installer: `Inkling-Setup-0.2.0-beta.2-x64.exe`, 128636974 bytes, SHA-256 `47fcc43b5d60ef22c9a69f48a2592d3897d6ac6e46a548a2ec1a88b2e13969fa`.
- Executed NSIS `/S /D=<isolated scratch install>`; exit 0. Tested resulting **installed** `Inkling.exe`; `app.isPackaged === true`, version `0.2.0-beta.2`. No development server or rebuilt app used.
- Windows Authenticode query returned unsigned. Silent installation does not exercise SmartScreen/download warnings, normal wizard interactions or uninstall/upgrade.
- Playwright mouse/keyboard automation and synthetic algebra glyphs, **not physical pen/touch**. PDF dialog choices and backup restore confirmation were stubbed inside Electron to point only at synthetic QA files. The actual application's import/export/backup/restore code executed. This does not establish native file-picker usability.
- `INKLING_DATA_DIR` and `INKLING_CONFIG_DIR` isolated notebook/config files. The app pins Electron `userData` to `%APPDATA%/Inkling`; `--user-data-dir` and APPDATA environment overrides did not provide a fully fresh Chromium/welcome profile. Existing notebook contents were not intentionally read or changed; first smoke screenshot showed prior ink. It is excluded from this evidence folder. Do not claim clean-profile welcome testing.

## Interpreting results / harness corrections

- `qa-results.json`: packaged launch, notebook creation, two mouse strokes, autosave, lasso vector move, undo/redo, consent decline, anonymous live status, window bounds, saved stroke restart comparison passed. The shape test initially used nonexistent `tool-shapes`; this is a **harness defect**, not an app bug.
- `qa2-results.json`: corrected shape selector passed. Two-page synthetic PDF import and three-page export passed basic header/page count checks. Backup test initially looked for a nonexistent Storage button; Storage is a section heading, not a tab. **Harness defect**.
- `qa3-results.json`: repeated PDF import added two more pages. An early file-exists check read the previous export before the new export finished; its reported three-page count is **not final PDF acceptance evidence**. Final exported file is five pages: ink page, red PAGE 1, green PAGE 2, red PAGE 1, green PAGE 2. Final bytes were rendered with pdf.js and verified separately in `pdf-render-results.json`, including distinct pixels/text; `export-render-1.png` visibly preserves the ink/rectangle. Backup assertion initially expected library.json in the selected parent folder rather than its timestamped backup child; **harness defect**, not data loss.
- `backup-results.json`: corrected path read from the application's success message; manual copy verified, new stroke added after copy, restore invoked through Settings, restored page objects compared equal to backup, and before-restore safety copy compared equal to the newer work. `pass: true` is final backup result. Daily auto-backup folder also existed, but seven-day pruning/scheduling was not exercised.
- `live-results.json`: real anonymous cloud model request with drawn incorrect algebra failed with provider-unavailable server error and retryAfter 900. No fake success. Status probe returned available immediately beforehand. Counter remained about 10 and installUsed remained 0 after the failed request. The script stopped on that error: subsequent correction preview/approval/AI undo-redo/correct-answer/practice paths did **not** execute. Backend diagnosis/fix remains Claude's scope.
- PDF renderer initially called nonexistent `doc.destroy` after rendering; corrected to `doc.loadingTask?.destroy()`. Final rendering/assertion command exited 0. These cleanup failures do not establish a product PDF defect.
- Original smoke and malformed interim copied harness failed before acceptance; excluded as superseded harnesses. Original structured failing attempts are retained, not relabeled as product failures.
- No uncaught renderer page errors recorded in `qa-results.json`. This is not proof that no console/main-process warnings occurred.

## Reproduction

Harnesses refer to cached `../inkling-notebook-qa/node_modules` and to `__dirname/installed/Inkling.exe` and scratch state. They are **execution records**, not portable CI tests; recreate these dependencies and isolate files before rerunning. Do not run blindly against a user's notebook library. `manifest.json` records SHA-256/size for evidence files (excluding this README and the manifest itself).

No macOS host was available. No physical stylus, touch, palm rejection, native display-scaling changes, uninstallation/upgrade, forced-crash loss recovery or production release acceptance was tested in this pass.
