# Release readiness: public beta, 7 November 2026

Status as of 31 Oct 2026, 01:00 UTC, on branch `beta-release`, commit `4ea46be` (Beta 2). Earlier entries refer to `974177b` (Beta 1). Builds run on GitHub Actions; results come from the check runs on that commit.

## Beta 2 for 5–10 invited testers (31 Oct 2026, 00:40 UTC)

**Draft pre-release `v0.2.0-beta.2`** (no git tag until published) was built from `f00f3dd` by pushing `build/draft-release` (run 41149694675). It is marked **DO NOT PUBLISH**.

| Check | Result |
|---|---|
| Version `0.2.0-beta.2` (package.json; About in the packaged app) | ✅ |
| Linux checks; Windows and macOS acceptance suites (phase 1–4, regressions, Ollama, cloud stand-in incl. allowance count, layout, release, large notebook) | ✅ all passed |
| Installers built from one commit; every file name carries `0.2.0-beta.2` (`.exe` x64, `.dmg` arm64 + x64, update `.zip`/`.blockmap`/`latest*.yml`) | ✅ uploaded to the draft |
| Packaged app answers a real question anonymously (Windows, macOS) | ❌ **AI server refused: "used up for everyone"** |
| Installer lifecycle (notebooks survive update/uninstall/reinstall) | ⏸ not reached (runs after the step above) |
| Server redeploy: security 21/22, limits 5/13, plan Workers Free, Cloudflare count 1,648 Neurons | ❌ same cause |
| `INKLING_FEEDBACK_URL` | ⚠️ not set: *Send Feedback* opens a GitHub issue |

**Cause:** just after 00:00 UTC Workers AI refused a request as "free allocation used up", and the server latched that for the rest of the UTC day (global limit pinned at 1,330 Neurons) although Cloudflare's own count for 31 Oct was only 1,648 of 10,000 Neurons.

**Fix deployed 31 Oct 00:5x UTC** (`61e0973` + `864dc1e` on `beta-release`, approved): an allocation error now stops answers for 15 minutes, answered as its own refusal (`503 server`, scope `upstream_unavailable`, the real retry time, "briefly unavailable from its provider. Try again in about N minutes") instead of a daily quota until midnight; the app keeps no pause for it and the next try after recovery is answered without a restart; Inkling's allowance is reported unpinned meanwhile; a genuinely used-up Inkling allowance is unchanged (`daily_quota` until the UTC reset); only `4006` / "daily free allocation" count. Unit tests 226/226 (regressions fail on the old code).

**Cloudflare is still refusing.** In the post-deploy run (41152494794) every real request, on production and on the separate temporary limits server, got the strict `4006` refusal; Cloudflare's count rose by 2 requests and 0 Neurons. So Workers AI itself is withholding the account's free allocation, not a misread error. Likely cause: the previous UTC day's heavy test usage (production plus temporary limits servers share the account's 10,000) with Cloudflare's reset lagging 00:00 UTC; unconfirmed. Live inference, the limit checks and the packaged/lifecycle tests can only pass once Cloudflare answers again; the server now retries automatically every 15 minutes.

**Usage monitor:** push `ops/summary` (read-only; `docs/RELEASING.md`). Tested: "1330 of 9000 Neurons used (14%), 19 answers, 6 installations, 3 networks, paused=false".

### Must fix before inviting testers
1. **Green verification once Cloudflare answers again:** re-run `deploy/beta-server` (security, live model, limits 13/13, plan) and then `build/draft-release` (packaged real answer on Windows and macOS, installer lifecycle). Then find out from Cloudflare's dashboard why the allocation was withheld, and keep test runs from using the testers' daily allowance.
2. **Feedback form** (`docs/FEEDBACK-FORM.md`): create it, set `INKLING_FEEDBACK_URL`, rebuild the draft; annotation *Feedback link built in*.
3. **Age policy** for the beta (18+ is simplest; under-18 or school use needs parental/school consent wording and counsel). State it in the invitation.
4. **Privacy notice:** `docs/PRIVACY.md` is a draft with placeholders (who we are, contact, children). Testers need at least a named contact and the age rule; counsel before any students.
5. **Hands-on install** on one real Windows PC and one real Mac from the draft's files (SmartScreen / Gatekeeper prompts, pen, consent, AI count). CI has no real pen, touch or download prompts.
6. **A contact for testers** (who answers problems and data questions). Not invented here.

### Before sharing with students or publicly (not needed for 5–10 adult testers who agree)
- Code signing (Apple Developer ID + notarization; Windows certificate or Azure Trusted Signing).
- Trademark check on "Inkling" (Wacom Inkling; Inkling digital textbooks) before any public announcement.
- Counsel review: COPPA / FERPA / GDPR age of consent, school agreement; moderation of AI answers.
- Merge to `main` (only with approval).

### Optional
- Native Windows arm64 build; Intel-Mac and Windows 10 testers; a scheduled usage summary (scheduled workflows only run from `main`); a dedicated domain instead of `workers.dev`.

## ✅ Verified (automated, on real Windows and macOS runners)

| Item | Windows Server 2022 (x64) | macOS 15 (Apple silicon) | Linux |
|---|---|---|---|
| Installer builds (NSIS `.exe` x64; DMG and zip, arm64 and x64) | ✅ | ✅ | AppImage, for testing only |
| Packaged app: first launch, welcome, data folder `…/Inkling`, no developer menu, handwriting saved, PDF import, rendering and export, restart | ✅ | ✅ | ✅ |
| **Installer lifecycle:** install → use → install a newer version over it → uninstall → reinstall; notebooks identical after every step, no repair needed, no welcome for a returning user | ✅ (silent NSIS) | ✅ (copied out of the DMG) | – |
| Unit tests (203) | ✅ | ✅ | ✅ |
| Phase 1–3: notebooks, canvas, lasso, shapes, images, zoom, undo/redo, notes, search, links, graph, PDF | ✅ | ✅ | ✅ |
| Regressions (backup recovery, cross-notebook paste, …) | ✅ | ✅ | ✅ |
| AI Tutor flows against stand-ins for each provider: cloud AI, Ollama, Gemini (consent, streaming, practice, previewed and approved page marks, allowance used up, errors) | ✅ | ✅ | ✅ |
| Release: first launch; killed process loses nothing saved; damaged library rebuilt; newer-version files untouched; daily backup + restore; oldest file format upgraded; single running copy | ✅ | ✅ | ✅ |
| Narrow windows: no overlapping controls from 960×600 up | ✅ | ✅ | ✅ |
| Large notebook (330 pages, one page with 150,000 points): opens in ~2.2–2.7 s; ~17 ms median frame; stroke saved in ~0.5–2 s | ✅ | ✅ | ✅ |

Bugs found and fixed by these runs:
1. **macOS:** ⌘Q left Inkling running with no window. Saving cancelled the quit; the quit is now resumed after saving.
2. **Windows:** reopening right after a crash did nothing, because the dying copy still held the single-instance lock. The lock is now retried for up to 4 s.

**30 Oct, public AI access (run 41016941312).** Beta access codes are gone. The Windows and macOS installers have the AI server address built in; a freshly installed app is ready on the cloud AI with no code, key or account, and answered a real question through the installed app on both systems. Install, update, uninstall and reinstall kept notebooks on both.

**30 Oct, deployed AI server (deploy run on `974177b`, and live runs on `e38c5eb`–`ab5bb1d`):**
- Security checks against production: 26/26 (input validation, size and token limits, no CORS, no raw model or other routes, admin hidden, client-sent model/instructions/caps ignored, one answer at a time, forged IP headers ignored).
- Usage limits on a temporary copy with tiny limits, against the real model: 13/13 (installation quota, one at a time, network and installation per-minute limits, network quota with fresh installation IDs, global cap under a 12-request burst ×2, pause and resume, no identities in the summary). The copy is deleted afterwards.
- Real-model test, anonymous as a fresh install: 13/13 answers, all checks passed, about 80 Neurons per typical interaction.
- The account has no subscriptions (Workers Free) before and after.

**31 Oct, Beta 2 QA fixes (`0.2.0-beta.2`, commits `e110268` + `4ea46be`).** Fixes from Hermes's QA of the Beta 1 installer:
- **AI answers-left count:** now pushed to the window after every server report (chat, markup, practice, check, refusals), refreshed with a free status check after a stopped answer, and re-read after the UTC reset. Regression tests fail on Beta 1 code and pass now: unit (`beta.test.ts`, 5 tests) and the cloud acceptance test reading the visible count in the real app.
- **Chats are session-only:** the chat says so; README and release notes too.
- Linux: typecheck, 222/222 unit tests, build, all 9 acceptance suites passed.
- Windows (run 41147420893): installer built; unit tests, packaged app, installer lifecycle and all 11 acceptance suites passed. The installed app answered a real question on the public server and the window received the new count (9 left) with the answer.
- `Inkling-Setup-0.2.0-beta.2-x64.exe` SHA-256 `47fcc43b5d60ef22c9a69f48a2592d3897d6ac6e46a548a2ec1a88b2e13969fa`. Not published.
- Cloud server redeployed unchanged: security 26/26, real model 13/13, limits 13/13, no subscriptions. (A first run straddling 00:00 UTC failed one per-minute check because the day rollover clears minute counters; the re-run passed.)
- Hands-on pass: `docs/BETA2-CHECKLIST.md`.

## ⚠️ Not verified yet

| Item | Why | How to verify |
|---|---|---|
| Real pens, touch screens, trackpads, display scaling (125%/150%), multiple monitors | CI machines have no such hardware | `docs/DEVICE-TESTING.md` on a real Windows PC with a pen and a real Mac |
| Windows 10, Windows on ARM (via x64 emulation), Intel Macs, macOS 12–14 | CI used Windows Server 2022 and macOS 15 on Apple silicon | Testers on those systems |
| Security prompts on first open (SmartScreen, Gatekeeper "Open Anyway") | Only appear for downloaded files on real machines | Download the artifact on a real PC and Mac and follow `INSTALL.md` |
| In-app update notice from a published release | Needs a published release | After publishing beta.1, publish beta.2 as a pre-release and check *About* |

## ⛔ Blockers before public testers

| # | Blocker | Owner |
|---|---|---|
| 1 | ~~Deploy the cloud AI server and pass the real-model, security and usage-limit tests~~ **Done 30 Oct** (see above) | – |
| 2 | Hands-on install and pen test on one real Windows PC and one real Mac | You or a trusted tester |
| 3 | Decide the beta's age policy (18+ is simplest; under 18 needs parental/school consent wording), and have counsel review `docs/PRIVACY.md` | You |
| 4 | Feedback channel testers can use without a GitHub account (`INKLING_FEEDBACK_URL`: an email or form) | You |
| 5 | Trademark check on "Inkling" before announcing publicly (Wacom Inkling pen; Inkling digital textbooks) | You and counsel |

**Accepted for the beta, not blockers:**
- Unsigned installers (security prompts, explained in `INSTALL.md`), and no in-app self-update on macOS until signed.
- A small AI allowance: about 110 interactions a day for everyone together, about 10 per installation (measured).
- Anonymous limits can be sidestepped by someone determined (new installation ID plus new networks); the global cap still bounds use and cost stays $0, but such a person could use up the day's answers for everyone.
- No moderation model on AI answers.
- `workers.dev` request floods could use up the free daily request limit. The result is an outage, not a cost.

## Cloud AI: checks before public access

| Check | Status |
|---|---|
| Provider terms suit a student app: no age minimum in Cloudflare's agreement; no training on content; no retention by default; Qwen weights Apache-2.0 | ✅ reviewed 29 Oct (see `docs/AI.md`). Our own age policy is still to decide (blocker 3). |
| No paid usage possible | ✅ by design: the deploy workflow refuses a Workers Paid account unless you confirm it; the server refuses to run without `ACCOUNT_PLAN=free`; the server caps the day at 9,000 Neurons; Cloudflare's Free plan errors instead of billing. |
| Cost | $0 on Workers Free (no subscriptions on the account before and after the test). If moved to Paid later: $0.011 per 1,000 Neurons, about $1 per 1,100 interactions at the measured 82 Neurons each. |
| Usage limits | Per installation: 900 Neurons a day (~10 interactions), 6 a minute, 1 at a time. Per network: 2,700 a day, 20 a minute, 4 at a time. Whole service: 9,000 a day, 12 at a time. Reset 00:00 UTC. Enforced atomically in the Durable Object; tested against the real model. |
| Security | No credential in the app; no Cloudflare token in the app or server; admin API (summary, pause) returns 404 without the admin token; server owns prompts, model and output caps; fixed tasks only; no CORS; JSON only; request size, image and token limits; identities stored as daily-salted hashes and deleted daily; content never stored or logged. The deploy workflow re-runs `scripts/abuse-check.mjs` after every deploy. |
| Real-model quality, speed, cost per answer | ✅ 30 Oct: 13/13 answers and 50/50 checks (handwriting reading, maths, annotation placement); first words about 0.5 s (17 s when the model is cold), answers 2–15 s; 82 Neurons per typical interaction, matching Cloudflare's own count |

## Exact steps to installers with working AI

1. **Cloudflare (done).** Secrets `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `INKLING_ADMIN_TOKEN`; variable `INKLING_BETA_URL`.
2. **Deploy and test.** Push the branch `deploy/beta-server` from `beta-release` and read the run's annotations (security, limits, live model, plan).
3. **Build.** Push `build/all` (or `build/windows`, `build/macos`) from `beta-release`; download `inkling-Windows` / `inkling-macOS` from the run's *Artifacts*.
4. **Emergency stop.** Push `ops/pause` (and later `ops/resume`) to stop or restart all AI answers.

Nothing is merged to `main` and nothing is published. A public release needs a `v*` tag, which only creates a draft, and then your *Publish*.
