# Release readiness: public beta, 7 November 2026

Status as of 31 Oct 2026, 01:00 UTC, on branch `beta-release`, commit `4ea46be` (Beta 2). Earlier entries refer to `974177b` (Beta 1). Builds run on GitHub Actions; results come from the check runs on that commit.

## Beta 2 for 5–10 invited testers

**Current draft (31 Oct 2026, 07:50 UTC):** `v0.2.0-beta.2` from `d086a06`, all jobs green, not published, no tag.

| File | SHA-256 |
|---|---|
| `Inkling-Setup-0.2.0-beta.2-x64.exe` | `c7361f3819d34b467b7a7a4ff0391148d12a035cc914493474200cd96c13cf5b` |
| `Inkling-0.2.0-beta.2-arm64.dmg` | `6e45cfa077be281177254e7c446eb4a78f2e577a472c38193ff124c035080ebc` |
| `Inkling-0.2.0-beta.2-x64.dmg` | `ac380bf06ee864dd4886f45cf93a0f9bd14cef1ad8452026c19df154aa6ce797` |

These change when the draft is rebuilt with `INKLING_FEEDBACK_URL`.

### History (31 Oct, 00:40 UTC)

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

**Diagnosis (31 Oct 01:27 UTC, `ops/cloudflare`, run on `2ddb474`).** Cloudflare's own hourly counts for the whole account (all workers, all tests):

| UTC hour | Requests | Neurons | Rolling 24 h |
|---|---|---|---|
| 30 Oct 03:00 | 17 | 1,170 | 1,170 |
| 30 Oct 05:00 | 2 | 22 | 1,192 |
| 30 Oct 06:00 | 182 | 6,833 | 8,025 |
| 30 Oct 07:00 | 1 | 11 | 8,036 |
| 30 Oct 15:00 | 3 | 310 | 8,345 |
| 30 Oct 23:00 | 40 | 1,388 | 9,733 |
| 31 Oct 00:00 | 46 | 1,648 | 11,382 |

By UTC calendar day: 30 Oct 9,734, 31 Oct 1,648 — neither reaches 10,000, yet a minimal direct request (2 + 3, 8 tokens) was refused at 01:27 UTC with HTTP 429, code 4006, "you have used up your daily free allocation of 10,000 neurons". The rolling 24-hour total was 11,382. So the allocation does **not** behave as a midnight-UTC calendar day; it matches a rolling (or lagging) window. The 6,833-Neuron burst on 30 Oct 06:00 UTC (test runs) leaves a rolling window at 06:00–07:00 UTC on 31 Oct, after which the total drops to about 3,400. Prediction to test: refused at 04:00 UTC, accepted from about 07:00 UTC. Probes are scheduled at 04:00, 06:25 and 07:25 UTC (one 8-token request each).

**Consequence for the beta:** the server's 9,000-Neuron cap per UTC day doesn't stop Cloudflare's limit: heavy use late one UTC day plus normal use early the next can exceed 10,000 in 24 hours, and test runs share the same allowance. The 15-minute retry keeps such an outage short and accurate rather than day-long; it does not prevent it.

**Usage monitor:** push `ops/summary` (read-only; `docs/RELEASING.md`). Tested: "1330 of 9000 Neurons used (14%), 19 answers, 6 installations, 3 networks, paused=false".

### Rolling-window protection (31 Oct, on `beta-release`, deploys with the next `deploy/beta-server`)
- **Server:** the whole-service cap (9,000 Neurons, unchanged) now counts the last 24 hours in hourly buckets that stay counted 25 hours, instead of the UTC calendar day; per-computer and per-network allowances still reset at 00:00 UTC. A refusal at the cap gives the time until enough old use leaves the window. Unsettled reservations count even across midnight. Unit tests 227/227; the 3 new ones fail on the old ledger.
- **Tests:** the full real-model suite (~1,100 Neurons) is now opt-in (`[live]`). Every deploy run first measures what tests used in the last 24 hours (Cloudflare's count minus the server's) and fails rather than let tests exceed 1,000 Neurons, the share left beside testers' 9,000. `[no-testers-yet]` overrides it, only before invitations. A build's packaged-app check uses about 20 Neurons per system.

### Exactly what blocks the first 5–10 testers
1. ~~Cloudflare accepting requests~~ **Done 31 Oct 06:26 UTC.** Refused at 04:01 UTC, accepted at 06:26 UTC once the 30 Oct 06:00 UTC test burst left the 24-hour window, while the UTC-day totals never changed: a rolling window, confirmed.
2. ~~Green verification~~ **Done.** Deploy run 41176622240 (`7dc07f9`, rolling cap live): security 26/26, usage limits 13/13, Workers Free, no subscriptions; the full live suite also ran (13/13, 981 Neurons) because the run's tag was read from the commit body — fixed in `d086a06` to read the subject only. Draft build run 41177279556 (`d086a06`): Linux checks; Windows and macOS packaged apps answered a real question anonymously ("56", 11 Neurons, window told 9 left), Gemini absent, installer lifecycle kept notebooks; all acceptance suites (Windows phase 3 failed once on a typing race in the test and passed on re-run; the test now waits for editor focus); draft notes written with checksums.
3. **Feedback form** (`docs/FEEDBACK-FORM.md`): you create it, set `INKLING_FEEDBACK_URL`, and the draft is rebuilt once more (final checksums come from that build).
4. **Children and parental consent** (all ages supported, by your decision). When a child asks the AI, Inkling sends an image of their selection, plus an anonymous installation ID and their IP address (kept only as daily-scrambled counts) to the server and Cloudflare. In the US that likely needs a parent's verifiable consent before a child under 13 uses it (COPPA), and similar rules apply under 16 in parts of the EU/UK. For 5–10 testers: invite the parent, who reads the privacy notice, agrees in writing (a reply is enough to record it), installs Inkling and clicks *Allow* themselves. Counsel should confirm this before any child tests; it's not something the app can decide.
5. **Privacy notice with real details:** `docs/PRIVACY.md` still has placeholders for who runs the beta, a contact, and the children section. Testers (and parents) need these before installing.
6. **A named contact** for problems and data questions (also deleting a tester's feedback). Not invented here.
7. **Hands-on install** of the final files on one real Windows PC and one real Mac (security prompts, pen, consent dialog, AI count). CI has no real pens, touch or download prompts.

### Before sharing with schools or publicly
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
