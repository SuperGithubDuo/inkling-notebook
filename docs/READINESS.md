# Release readiness: public beta, 7 November 2026

Status as of 30 Oct 2026, 07:30 UTC, on branch `beta-release`, commit `974177b`. Builds run on GitHub Actions; results come from the check runs on that commit.

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
