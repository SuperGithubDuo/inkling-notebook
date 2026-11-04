# Changes waiting for approval

Status on 1 Nov 2026. What's done is listed first so this page stays the single record. **Nothing has been published and no branch has been deleted.**

## Done (approved 1 Nov 2026)

| Step | Result |
|---|---|
| Rebase the preparation work onto the latest `beta-release` | Clean rebase onto `14baed9`; both newer commits (`d086a06`, `14baed9`) kept |
| Accuracy audit of README, site and docs | [CLAIMS-AUDIT.md](CLAIMS-AUDIT.md) |
| PR [#2](https://github.com/SuperGithubDuo/inkling-notebook/pull/2): download experience → `beta-release` | CI green, merged (merge commit `d9211ff`) |
| PR [#3](https://github.com/SuperGithubDuo/inkling-notebook/pull/3): Hermes's launch review and evidence → `beta-release` | CI green, merged (`2e37ec5`); Hermes's commit `3e1ab80` kept, his 34 files byte-identical |
| PR [#4](https://github.com/SuperGithubDuo/inkling-notebook/pull/4): update `main` | Fast-forward `5c0f27d` → `2e37ec5`: no merge commit, no rewritten history. CI and *Download site* green on `main` |
| Draft-release checks from `main` | See [READINESS.md](READINESS.md#beta-2-for-510-invited-testers): run started with *Run workflow* on `main` |

## Waiting for you

### 1. Switch on the download site (one click) — done 3 Nov 2026

Done: Pages is on, and *Download site* deploys from `main` (first deploy run [41562297790](https://github.com/SuperGithubDuo/inkling-notebook/actions/runs/41562297790)). Kept below as the record.

*Settings → Pages → Build and deployment → Source: **GitHub Actions*** ([settings](https://github.com/SuperGithubDuo/inkling-notebook/settings/pages)). Repository settings can't be changed from Claude's session. After the click, *Actions → Download site → Run workflow* (or the next change to `site/` on `main`) deploys `https://supergithubduo.github.io/inkling-notebook/`, which shows *Coming soon / No download is available yet* until step 3.

### 2. Feedback form (before inviting testers)

Create the no-sign-in form from [HERMES-FEEDBACK-FORM.md](HERMES-FEEDBACK-FORM.md) and set the repository **variable** `INKLING_FEEDBACK_URL`. The site then shows a *Send feedback* button; installers pick it up only when the draft is rebuilt (*Actions → Release → Run workflow → draft-release*).

### 3. Publish a release (the approval that makes downloads live)

Press **Publish** on the `v0.2.0-beta.2` draft only when its notes start with "## Inkling 0.2.0-beta.2" and contain no DO NOT PUBLISH. The site then offers it within minutes. Publishing creates the public tag `v0.2.0-beta.2`.

### 4. Branch deletions

`main` is now the only long-lived branch. Each branch below has no commit that isn't on `main`, except where noted. Deleting a branch doesn't delete its commits from `main`.

| Delete | Tip | Why it's safe | Precondition |
|---|---|---|---|
| `prep/download-experience` | `16a3231` | Merged in #2 | — |
| `docs/integrate-hermes-review` | `b9c5b38` | Merged in #3 | — |
| `docs/hermes-launch-review` | `3e1ab80` | Merged via #3; Hermes's commit is on `main` | Optional tag `qa/hermes-beta2-launch-review` at `3e1ab80` first |
| `cloud-beta` | `26a5cc4` | Contained in `main` | — |
| `admin/add-tester/qiao` | `fa9c449` | Contained; trigger for the removed *Add beta tester* workflow | Disable that workflow too (it only exists on this branch) |
| `build/all` | `974177b` | Contained; build trigger, replaced by *Run workflow* | — |
| `build/windows` | `4ea46be` | Contained; build trigger | — |
| `build/draft-release` | `d086a06` | Contained; replaced by *Run workflow → draft-release*, tested from `main` on 1 Nov | — |
| `ops/summary` | `f00f3dd` | Contained; ops trigger (README says "delete before reuse") | — |
| `fix/upstream-exhausted-retry` | `864dc1e` | Contained; older duplicate of a deploy | — |
| `deploy/beta-server` | `7dc07f9` | Contained; deploy trigger. *Beta AI server* has a *Run workflow* button on `main` | Run *Beta AI server* once from `main` first, if you want it proven before deleting |
| `ops/cloudflare` | `9285237` | One commit not on `main`, but it's **empty** (a probe trigger) | Its workflow runs only on pushes to this branch; add `workflow_dispatch` first if you still want the diagnostics |
| `accept-new-gemini-keys` + PR #1 | `791aedb` | One commit not on `main`, **superseded** by `ff97b60` (both key formats, redaction, tests) | Close PR #1 with a note; optional tag `archive/accept-new-gemini-keys` |
| `beta-release` | `2e37ec5` | Identical to `main` | Last, once nothing points at it (`docs/RELEASING.md` mentions it as an example) |

**Kept:** `main`.

### 5. Settings that keep it clean (optional)

- Protect `main`: pull requests required, CI must pass, no force pushes.
- *Settings → General → Automatically delete head branches*.

### 6. Decisions only you can make

- **Licence.** `LICENSE.txt` says "all rights reserved" (`UNLICENSED`). The README says so. An open-source licence is a separate decision.
- **Privacy notice.** [PRIVACY.md](../PRIVACY.md) is a draft pending legal review; who runs Inkling, a contact address and the children section are placeholders.
- **Children and the cloud AI** (Hermes H-04, [CLAIMS-AUDIT.md](CLAIMS-AUDIT.md)): the app doesn't check ages and uses one *Allow* per installation. Parental consent for under-13s (US) and under-16s (parts of the EU/UK) needs counsel.
- **Security contact** (`SUPPORT.md` placeholder).
- **App's "new version" link** points at the GitHub release page; pointing it at the download site is a one-line app change, not made.
- **Hermes's evidence** contains local Windows paths with the tester's account name, and one manifest hash (`hash-verification.json`) doesn't match its file in Hermes's own commit. Left unchanged; Hermes may want to regenerate the manifest.
