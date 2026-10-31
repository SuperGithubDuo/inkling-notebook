# Repository cleanup plan

**Status: proposal. Nothing here has been done.** No branch has been deleted, no history rewritten, nothing merged to `main`, nothing published. Every action below needs approval; the exact list is in [APPROVALS.md](APPROVALS.md).

Audited 31 Oct 2026 (05:15 UTC) from the remote: 15 branches, 1 pull request, 7 workflows (6 on `beta-release` plus one orphan), 1 release (a draft), no tags.

## What the audit found

1. **`main` is stale.** It is 38 commits behind `beta-release`, which holds everything shipped since 28 Oct: installers, the release workflow, the AI server, data-safety fixes, Beta 2. `main` contains nothing `beta-release` lacks, so updating it is a clean fast-forward.
2. **History is linear.** Every branch except three is an ancestor of `beta-release`, so deleting them loses nothing.
3. **Many branches are buttons, not work.** The workflows start when a branch with a particular name is pushed (`build/*`, `deploy/beta-server`, `ops/*`). That was needed because GitHub only shows *Run workflow* buttons for workflows on the default branch, and the workflows only exist on `beta-release`. Once `main` has them, the buttons work and these branches aren't needed.
4. **Hermes's QA evidence is on one unmerged branch** (`docs/hermes-launch-review`, 34 files). It must be kept.
5. **The only release is the failed Beta 2 draft** (`v0.2.0-beta.2`, notes say **DO NOT PUBLISH**). It must not be published or linked.

## Every branch

| Branch | Tip | Relation to `beta-release` | What it is | Proposal |
|---|---|---|---|---|
| `main` | `5c0f27d` 28 Oct | 38 behind, 0 ahead | Default branch, stale | **Fast-forward to `beta-release`** (after this prep branch is reviewed), then make it the only long-lived branch |
| `beta-release` | `ff97b60` 30 Oct | — | Current product line | Keep until `main` is fast-forwarded, then delete (it equals `main`) |
| `docs/hermes-launch-review` | `3e1ab80` 30 Oct | **1 ahead** | Hermes's independent Beta 2 launch review: `HERMES-LAUNCH-REVIEW.md`, `HERMES-PRIVACY-REVIEW.md`, `HERMES-FEEDBACK-FORM.md`, `hermes-launch-evidence/` (screenshots, results JSON, harness scripts, hash verification) | **Merge** (PR into `beta-release`/`main`), and tag `qa/hermes-beta2-launch-review` at `3e1ab80` before deleting the branch |
| `accept-new-gemini-keys` + **PR #1** | `791aedb` 28 Oct | 1 ahead, 12 behind | Accept `AQ.` Gemini keys | **Superseded** by `ff97b60` on `beta-release` (accepts both key formats, adds redaction, tests). Close PR #1 with a note, tag `archive/accept-new-gemini-keys`, delete |
| `ops/cloudflare` | `db08f1b` 30 Oct | 1 ahead (an empty "probe" commit) | Button: Cloudflare diagnostics | Delete when the 31 Oct allocation incident is closed; afterwards use *Run workflow* on `main` |
| `build/draft-release` | `f00f3dd` 30 Oct | contained | Button: draft-release build; the failed Beta 2 run came from this commit | Delete; re-push it (or use *Run workflow*) for the next draft |
| `ops/summary` | `f00f3dd` | contained, same commit as `build/draft-release` | Button: AI server usage summary | Delete (`READINESS.md` already says "delete before reuse") |
| `build/windows` | `4ea46be` 30 Oct | contained | Button: Windows-only build (Hermes tested its artifact) | Delete |
| `build/all` | `974177b` 29 Oct | contained | Button: both platforms | Delete |
| `deploy/beta-server` | `864dc1e` 30 Oct | contained | Button: deploy the AI server | Keep until `main` has the workflow, then delete and use *Run workflow* |
| `fix/upstream-exhausted-retry` | `864dc1e` | contained, **same commit as `deploy/beta-server`** | Duplicate | Delete |
| `admin/add-tester/qiao` | `fa9c449` 29 Oct | contained | Button for the removed *Add beta tester* workflow | Delete, and disable the orphan *Add beta tester* workflow |
| `cloud-beta` | `26a5cc4` 29 Oct | contained | First cloud-beta commit | Delete |
| `prep/download-experience` | new | 1 ahead | This preparation work | Review, then PR into `beta-release` (or `main` after the fast-forward) |

"Contained" means every commit on the branch is already on `beta-release`; deleting the branch loses no history. GitHub keeps the commits of merged PRs regardless.

## Proposed structure

```
main ──●──●──●──●──────────●───────●──▶   always releasable; releases are built from here
        \                 /       /
         feature/pen-palm ●──●───┘      short-lived: feature/*, fix/*, docs/*, ops/*
```

- **`main`** is the only long-lived branch. It's protected: changes arrive by pull request with CI green; no force pushes.
- **Short-lived branches** (`feature/…`, `fix/…`, `docs/…`) are merged by PR and deleted on merge (turn on *Automatically delete head branches*).
- **No separate `develop` branch.** With two maintainers and every release gated by a draft plus a human Publish click, a second long-lived branch only adds merging. If a release ever needs a hotfix while `main` has unreleased work, branch `release/x.y` from the tag at that time.
- **Workflows are started with *Run workflow*** (Actions tab) once they're on `main`: Release (with a "draft release" choice), Beta AI server, Cloudflare diagnostics. The branch-push triggers can stay as a fallback for one release cycle, then be removed.
- **Tags** mark what was released (`v0.2.0-beta.3`, created by Publish) and preserved history (`qa/…`, `archive/…`).

## Workflows

| Workflow | File | Status | Proposal |
|---|---|---|---|
| CI | `ci.yml` | Runs on `main` pushes and PRs | Keep |
| Release | `release.yml` | Builds, tests and drafts releases | Keep. This branch adds strict verification of the draft before it can be marked ready (see [DOWNLOAD-SITE.md](DOWNLOAD-SITE.md)) |
| Beta AI server | `beta-server.yml` | Deploys the Cloudflare Worker | Keep (deployment automation) |
| AI server emergency switch | `beta-server-ops.yml` | Pause / resume / summary | Keep |
| Cloudflare AI diagnostics | `cloudflare-diagnostics.yml` | Read-only checks | Keep |
| Add beta tester | `beta-tester.yml` | **Orphan**: only on `admin/add-tester/qiao`, removed from `beta-release` | Disable in Actions, then delete the branch |
| Download site | `pages.yml` | **New on this branch** | Inert until on `main` *and* switched on |

## Documentation

| File | Proposal |
|---|---|
| `README.md` | Rewritten as a product page; all technical content moved, nothing deleted |
| `docs/DEVELOPMENT.md`, `ARCHITECTURE.md`, `AI-PROVIDERS.md`, `USER-GUIDE.md`, `KNOWN-LIMITATIONS.md` | **New**: the old README's sections, organized |
| `docs/INSTALL.md` | Made version-neutral (was hard-coded to Beta 2 and "the link we sent you") |
| `docs/RELEASING.md`, `ROADMAP.md` | Updated for the verified release flow and the milestone table |
| `docs/history/PHASE-4.5-WINDOWS.md` | **New**: the Phase 4.5 notes, kept for history |
| `docs/READINESS.md`, `LAUNCH.md`, `BETA2-CHECKLIST.md`, `DEVICE-TESTING.md`, `FEEDBACK-FORM.md`, `MONETIZATION.md`, `AI.md`, `PRIVACY.md`, `windows-validation.md`, `live-results/` | Unchanged; indexed in [docs/README.md](../README.md) |
| Hermes's reviews and evidence | Stay as they are once merged; indexed under QA evidence |

Outdated claims removed from the README: installers "pending the first workflow run" (they pass on Windows and macOS runners), Windows/macOS acceptance runs "haven't run yet", Gemini presented as available in release builds (it isn't offered in installers since `ff97b60`), and a setup section that told ordinary users to install Node.js.

## `.gitignore`

Checked every tracked file on `beta-release` and on Hermes's branch: **no secrets, keys, installers, build output or personal test data are committed** (the only key-shaped strings are deliberately fake test keys). Large files: none over 1 MB. Changes on this branch:

- added `/release-next/` (the lifecycle test's second build), `/_site/` (built download site), `.npmrc`;
- added installer and update files (`*.exe`, `*.dmg`, `*.blockmap`, `*.AppImage`, `latest*.yml`) so a stray build can't be committed;
- anchored `/release/` to the repository root: unanchored, it would also have ignored `scripts/release/`.

Hermes's evidence includes a `draft-latest.yml` copy; it's already tracked on that branch and stays tracked (`.gitignore` only affects new files).
