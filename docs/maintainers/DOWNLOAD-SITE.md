# Download site and release flow

How an approved build reaches a first-time user in one click, and why an unapproved or failed build never can.

**Status: built and tested on `prep/download-experience`; not live.** The site goes live only after the approvals in [APPROVALS.md](APPROVALS.md).

- Address (GitHub Pages, free): `https://supergithubduo.github.io/inkling-notebook/`
- Source: `site/` (one page, no frameworks, no third-party requests, fonts and images self-hosted)
- Build: `scripts/site/build-site.mjs` · Deploy gate: `scripts/site/check-site.mjs` · Rules: `scripts/release/rules.mjs`
- Workflow: `.github/workflows/pages.yml` · Tests: `tests/unit/release-site.test.ts` (part of `npm test`)

## From commit to download

```
 push build/draft-release          Release workflow                        You                      Download site workflow
 (or Run workflow →          ┌──────────────────────────────┐                                ┌───────────────────────────────┐
  "draft-release")      ───▶ │ build + test on Windows/macOS │                                │ newest PUBLISHED release that: │
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

## Why a bad build can't be downloaded from the site

| Situation | Result |
|---|---|
| Draft (including today's v0.2.0-beta.2) | Not offered: drafts are never public and the rules skip them |
| Failed build ("DO NOT PUBLISH") | No marker, and the phrase itself blocks it, even if someone presses Publish |
| Published by hand without the Release workflow | No marker → not offered |
| Installer replaced after verification | GitHub's digest no longer matches the marker → not offered |
| Tag moved to another commit | Tag commit ≠ verified commit → not offered |
| Release later found bad | Add its tag to `withdrawn` in `site/config.json` (or write WITHDRAWN in its notes): the page falls back to the previous good release, or to "no download yet" |
| Anything else on the page | `check-site.mjs` fails the deploy if the page links to workflow runs/artifacts, draft (`untagged-`) URLs, any download link outside the verified data, or has preview mode on |

Every row is a unit test in `tests/unit/release-site.test.ts`, including the real shape of today's failed draft.

## What users see

**Page** (`site/index.html`):
- Hero with the version, a *Beta* label, release date and release-notes link, and **one big button for the visitor's computer** (Windows, or the right Mac when the browser can tell; otherwise both Mac buttons with "Which Mac do I have?").
- Three platform cards with file name, size, requirements and SHA-256.
- Install guide (Windows and Mac tabs) with the unsigned-build warning, system requirements, privacy summary, feedback.
- No approved release: buttons are shown disabled with "No download is available yet" and a plain explanation.
- Phones and tablets: a note that Inkling is for Windows and Mac, with *Copy this page's link*; the downloads stay listed.
- Light and dark themes, keyboard navigation, no horizontal scrolling at phone width.

**Release page** (`.github/release-notes.md`): a download table with direct links at the top, then the security-prompt explanation, checksums folded away, privacy and feedback. It tells readers to ignore `.zip`, `.blockmap` and `.yml` files. Those must stay on the release: electron-updater reads `latest*.yml`, signed macOS updates need the `.zip`, and `.blockmap` files make updates smaller.

## Preview locally

```bash
node scripts/site/build-site.mjs --out _site     # live data from GitHub (shows "no download yet" today)
# then open site/index.html in a browser and add ?preview=sample to the address
# to see the layout with made-up data (download buttons switched off)
```

The `?preview=sample` mode exists only in the unbuilt source; the build turns it off and `check-site.mjs` enforces that.

## Switching it on (needs approval)

1. Merge to `main` (the workflow only runs from there).
2. *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
3. *Settings → Secrets and variables → Actions → Variables*: `INKLING_SITE_ENABLED` = `true`. Optionally `INKLING_FEEDBACK_URL` (the no-sign-in form) and `INKLING_DOWNLOAD_PAGE_URL` (if you use a custom domain).
4. *Actions → Download site → Run workflow*. Check the page shows "No download is available yet" until you publish an approved build.

To take the site down: set `INKLING_SITE_ENABLED` to anything else and unpublish Pages in *Settings → Pages*.

## Later (not done)

- **Point the app at the site.** Unsigned builds' "new version available" link goes to the GitHub release page (`RELEASES_URL` in `src/shared/product.ts`). Pointing it at the download page would be a one-line app change; left alone here because this milestone doesn't change the app.
- **Custom domain** (e.g. `getinkling.app`), after the trademark check in `LAUNCH.md`.
- **Signed builds** remove the security prompts and turn on self-installing updates; the release workflow already uses the certificates when the secrets exist.
