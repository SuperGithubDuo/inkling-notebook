# Release readiness: public beta, 7 November 2026

Status as of 30 Oct 2026, 01:00 UTC, on branch `beta-release`, commit `5c3af71`. Builds run on GitHub Actions; results come from the check runs on that commit.

## ✅ Verified (automated, on real Windows and macOS runners)

| Item | Windows Server 2022 (x64) | macOS 15 (Apple silicon) | Linux |
|---|---|---|---|
| Installer builds (NSIS `.exe` x64; DMG and zip, arm64 and x64) | ✅ | ✅ | AppImage, for testing only |
| Packaged app: first launch, welcome, data folder `…/Inkling`, no developer menu, handwriting saved, PDF import, rendering and export, restart | ✅ | ✅ | ✅ |
| **Installer lifecycle:** install → use → install a newer version over it → uninstall → reinstall; notebooks identical after every step, no repair needed, no welcome for a returning user | ✅ (silent NSIS) | ✅ (copied out of the DMG) | – |
| Unit tests (203) | ✅ | ✅ | ✅ |
| Phase 1–3: notebooks, canvas, lasso, shapes, images, zoom, undo/redo, notes, search, links, graph, PDF | ✅ | ✅ | ✅ |
| Regressions (backup recovery, cross-notebook paste, …) | ✅ | ✅ | ✅ |
| AI Tutor flows against stand-ins for each provider: cloud beta, Ollama, Gemini (consent, streaming, practice, previewed and approved page marks, allowance used up, errors) | ✅ | ✅ | ✅ |
| Release: first launch; killed process loses nothing saved; damaged library rebuilt; newer-version files untouched; daily backup + restore; oldest file format upgraded; single running copy | ✅ | ✅ | ✅ |
| Narrow windows: no overlapping controls from 960×600 up | ✅ | ✅ | ✅ |
| Large notebook (330 pages, one page with 150,000 points): opens in ~2.2–2.7 s; ~17 ms median frame; stroke saved in ~0.5–2 s | ✅ | ✅ | ✅ |

Bugs found and fixed by these runs:
1. **macOS:** ⌘Q left Inkling running with no window. Saving cancelled the quit; the quit is now resumed after saving.
2. **Windows:** reopening right after a crash did nothing, because the dying copy still held the single-instance lock. The lock is now retried for up to 4 s.

## ⚠️ Not verified yet

| Item | Why | How to verify |
|---|---|---|
| An installer **with cloud AI built in** | Needs the deployed server's address | Set the repository variable `INKLING_BETA_URL`, then push `build/windows` |
| Real pens, touch screens, trackpads, display scaling (125%/150%), multiple monitors | CI machines have no such hardware | `docs/DEVICE-TESTING.md` on a real Windows PC with a pen and a real Mac |
| Windows 10, Windows on ARM (via x64 emulation), Intel Macs, macOS 12–14 | CI used Windows Server 2022 and macOS 15 on Apple silicon | Testers on those systems |
| Security prompts on first open (SmartScreen, Gatekeeper "Open Anyway") | Only appear for downloaded files on real machines | Download the artifact on a real PC and Mac and follow `INSTALL.md` |
| In-app update notice from a published release | Needs a published release | After publishing beta.1, publish beta.2 as a pre-release and check *About* |

## ⛔ Blockers before public testers

| # | Blocker | Owner |
|---|---|---|
| 1 | ~~Deploy the cloud AI server and pass the real-model test~~ **Done 30 Oct:** 50/50 checks, 82 Neurons per interaction, Workers Free confirmed (`docs/live-results/cloud-qwen3.8-27b.md`) | – |
| 2 | Hands-on install and pen test on one real Windows PC and one real Mac | You or a trusted tester |
| 3 | Decide the beta's age policy (18+ is simplest; under 18 needs parental/school consent wording), and have counsel review `docs/PRIVACY.md` | You |
| 4 | Feedback channel testers can use without a GitHub account (`INKLING_FEEDBACK_URL`: an email or form) | You |
| 5 | Trademark check on "Inkling" before announcing publicly (Wacom Inkling pen; Inkling digital textbooks) | You and counsel |

**Accepted for the beta, not blockers:**
- Unsigned installers (security prompts, explained in `INSTALL.md`), and no in-app self-update on macOS until signed.
- A small AI allowance: about 110 interactions a day across all testers (measured).
- No moderation model on AI answers.
- `workers.dev` request floods could use up the free daily request limit. The result is an outage, not a cost.

## Cloud AI: checks before enabling it for testers

| Check | Status |
|---|---|
| Provider terms suit a student app: no age minimum in Cloudflare's agreement; no training on content; no retention by default; Qwen weights Apache-2.0 | ✅ reviewed 29 Oct (see `docs/AI.md`). Our own age policy is still to decide (blocker 3). |
| No paid usage possible | ✅ by design: the deploy workflow refuses a Workers Paid account unless you confirm it; the server refuses to run without `ACCOUNT_PLAN=free`; the server caps the day at 9,000 Neurons; Cloudflare's Free plan errors instead of billing. |
| Cost | $0 on Workers Free (no subscriptions on the account before and after the test). If moved to Paid later: $0.011 per 1,000 Neurons, about $1 per 1,100 interactions at the measured 82 Neurons each. |
| Usage limits | 900 Neurons per tester per day (about 11 interactions; adjustable per tester), 6 requests a minute, 1 answer at a time, 9,000 for the whole beta, reset 00:00 UTC. |
| Security | Codes stored hashed; no Cloudflare token in the app or server; admin API returns 404 without the admin token; server owns prompts and output caps; request size and image limits. The deploy workflow re-checks the 401 and 404 responses after every deploy. |
| Real-model quality, speed, cost per answer | ✅ 30 Oct: 13/13 answers and 50/50 checks (handwriting reading, maths, annotation placement); first words about 0.5 s (17 s when the model is cold), answers 2–15 s; 82 Neurons per typical interaction, matching Cloudflare's own count |

## Exact steps to a Windows tester build with working AI

1. **Cloudflare (10 min).** Add the secrets `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `INKLING_ADMIN_TOKEN`; details in `beta-server/README.md` → *Deploy*.
2. **Deploy and test (≈10 min, automatic).** Push the branch `deploy/beta-server`: on github.com open the branch menu, type `deploy/beta-server`, and create it from `beta-release`. Read the run's annotations for the server address and the real-model results.
3. **Build in the address.** In *Settings → Secrets and variables → Actions → Variables*, add `INKLING_BETA_URL` = the address from step 2.
4. **Build Windows (≈5 min).** Create or update the branch `build/windows` from `beta-release`. Download `inkling-Windows` from the run's *Artifacts*.
5. **Add a tester and try it on a real PC.** Run `npm run admin -- add "Your name"` (see `beta-server/README.md`), install the `.exe`, paste the code in *Settings → AI Tutor*, and go through `DEVICE-TESTING.md`.
6. **Then macOS.** Use the branch `build/macos` and the `inkling-macOS` artifact.

Nothing is merged to `main` and nothing is published. A public release needs a `v*` tag, which only creates a draft, and then your *Publish*.
