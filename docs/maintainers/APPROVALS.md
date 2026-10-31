# Changes waiting for approval

Everything prepared for the "download in one click" milestone is on the branch **`prep/download-experience`** (based on `beta-release` @ `ff97b60`). Nothing below has been done. Each item is independent unless it says otherwise; approve them one by one.

## A. Merging the preparation work

| # | Change | Effect | Reversible? |
|---|---|---|---|
| A1 | Open a PR `prep/download-experience` → `beta-release` and merge it | New README and docs, download site source, stricter release verification, tests. No app code changes | Yes (revert the merge) |
| A2 | Merge Hermes's `docs/hermes-launch-review` (PR into `beta-release`) | Brings Hermes's Beta 2 launch review, privacy review, feedback form and evidence into the main line. Docs only | Yes |
| A3 | Fast-forward `main` to `beta-release` (after A1 and A2) | `main` becomes current; workflows get *Run workflow* buttons; the README on the repository's front page becomes the new product page. It's a fast-forward: no merge commit, no history rewritten | Yes, by resetting `main` to `5c0f27d` (that *would* need a force push) |
| A4 | Protect `main`: PRs required, CI must pass, no force pushes; turn on *Automatically delete head branches* | Enforces the simplified structure | Yes |

## B. Branch cleanup (after A3)

| # | Change | Notes |
|---|---|---|
| B1 | Create tag `qa/hermes-beta2-launch-review` at `3e1ab80`, then delete `docs/hermes-launch-review` | Only after A2 |
| B2 | Close PR #1 with a note that `ff97b60` supersedes it; tag `archive/accept-new-gemini-keys` at `791aedb`; delete the branch | |
| B3 | Delete branches whose commits are all on `beta-release`: `cloud-beta`, `admin/add-tester/qiao`, `build/all`, `build/windows`, `build/draft-release`, `ops/summary`, `fix/upstream-exhausted-retry` | Loses no history |
| B4 | Delete `ops/cloudflare` and `deploy/beta-server` | Only once the 31 Oct Cloudflare incident is closed and *Run workflow* works on `main` |
| B5 | Disable the orphan *Add beta tester* workflow | |
| B6 | Delete `beta-release` | Only after A3, when it equals `main` |

## C. Download site

| # | Change | Notes |
|---|---|---|
| C1 | *Settings → Pages → Source: GitHub Actions* | Needs A3 |
| C2 | Repository variable `INKLING_SITE_ENABLED=true` | The site goes public at `https://supergithubduo.github.io/inkling-notebook/`. It shows "No download is available yet" until C5 |
| C3 | Repository variable `INKLING_FEEDBACK_URL` | The no-sign-in feedback form (Hermes's 10-question version). Without it the page shows only the in-app route and GitHub issues. Installers need a rebuild to pick it up |
| C4 | Optional: `INKLING_DOWNLOAD_PAGE_URL` | Only for a custom domain |

## D. Releases

| # | Change | Notes |
|---|---|---|
| D1 | Rebuild the Beta 2 draft from the fixed commit with the new verification (push `build/draft-release`, or *Run workflow → draft-release* after A3) | The existing draft holds installers from `f00f3dd` and says DO NOT PUBLISH. Rebuilding replaces its files and notes |
| D2 | **Press Publish** on a draft whose notes start with "Inkling <version>" and contain no DO NOT PUBLISH | This is the approval step. The site then offers it within minutes. Do **not** publish the current draft |
| D3 | Withdraw a release later, if needed | Add its tag to `withdrawn` in `site/config.json` |

## E. Decisions only you can make

- **Licence.** `package.json` says `UNLICENSED` and `LICENSE.txt` says "all rights reserved". The README is styled like an open-source project page but says, accurately, that Inkling is not open source. Choosing an open-source licence (e.g. MIT, Apache-2.0, GPL-3.0) is a separate decision.
- **Privacy notice.** `docs/PRIVACY.md` is a draft for legal review with the operator's name and contact missing. The site and README link to it labelled "draft". Public launch needs the reviewed version.
- **Age policy and the cloud AI for minors** (Hermes's H-04): the site tells under-18s that a parent or guardian should decide.
- **App link to the site** (`RELEASES_URL` in `src/shared/product.ts`): pointing the "new version" notice at the download page is a one-line app change, not made here.

## What was verified on this branch

- `npm run typecheck` and `npm test` pass (the existing 235 unit tests plus 24 new ones for release verification and the site).
- The site was built from the **real** release list on 31 Oct: it offers nothing, because the only release is the DO NOT PUBLISH draft; the deploy check passed.
- The page was rendered in Chrome at 1280 px and 390 px, light and dark, as a Windows, Mac and iPhone visitor: no horizontal scrolling, no console errors, every download button disabled in the no-release state.
- Links in the README and docs were checked: every relative link resolves to a file and heading on this branch.
- External links: the site's links to `blob/main/…` files (install guide, privacy, licence, support) return 404 today because `main` is stale; the same paths return 200 on `beta-release`, so they work after A3. *Open a public issue* asks anonymous visitors to sign in, as labelled.
- Download links on the site and in release notes are direct `releases/download/<tag>/<file>` URLs, which work without a GitHub account for this public repository.
