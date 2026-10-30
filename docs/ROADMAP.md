# Status and remaining work

## Verification status

See [`READINESS.md`](READINESS.md) for the current, evidence-based checklist. As of 30 Oct, every automated suite and the installer lifecycle pass on real Windows and macOS runners; the cloud AI against the real model and hands-on pen testing are still pending.

## Before inviting external testers (7 November)

| # | Item | Who | Notes |
|---|---|---|---|
| 1 | Run **Actions → Release** once; fix anything Windows/macOS-specific | you to run, me to fix | I can't see Actions runs from here. Send me the log or failing artifacts. |
| 2 | Install the `.exe` and `.dmg` on a real PC and Mac and go through `DEVICE-TESTING.md` | you or a tester | Stylus and touch have never been tried on hardware. |
| 3 | Decide on AI for the beta: deploy `beta-server` (`beta-server/README.md`) **or** ship without cloud AI (Ollama optional) | you | Needs a Cloudflare account on the Workers Free plan. Then run `npm run test:live:cloud` for real quality and cost numbers. |
| 4 | Set `INKLING_FEEDBACK_URL` to an email or form if testers don't have GitHub | you | The default is a GitHub issue. |
| 5 | Tag `v0.2.0-beta.1`, check the draft release, publish as a pre-release | you | Workflow uploads to a draft only. |
| 6 | Tell testers about the unsigned-app prompts (`INSTALL.md`) | you | |
| 7 | Age policy for testers: adults only, or 13+ with consent | you, with counsel | Decides the privacy-policy wording and whether the cloud tutor is offered to minors. |

## Before a public launch (prioritised)

1. **Code signing and notarization.** Apple Developer ID ($99/yr), and a Windows certificate or Azure Trusted Signing. This removes the security prompts and enables self-installing updates. The workflow already uses them when the secrets exist.
2. **Trademark clearance for "Inkling"**, given prior use by Wacom (digital pen) and Inkling (digital textbooks). Have a fallback name. See `LAUNCH.md`.
3. **Legal texts:** privacy policy (draft in `PRIVACY.md`), terms of use/EULA (only a placeholder `LICENSE.txt` exists), and a school/parental-consent approach.
4. **Hosted AI at scale:** a Workers Paid account with a billing alert, sign-in, and per-user allowances from entitlements. See `AI.md`.
5. **Device coverage:** Windows on ARM, Intel Macs, Wacom/Surface/Huion pens, 4K displays, slow 8 GB laptops.
6. **Crash reporting (opt-in)** and an in-app "copy diagnostics" button, so testers can send useful reports without notebook content.
7. **Accessibility pass:** screen-reader labels on canvas tools, keyboard-only use of dialogs and menus, contrast. Basic labels and keyboard shortcuts exist; a full audit hasn't been done.
8. **Website** from the outline in `LAUNCH.md`, with downloads, the install guide, privacy and support.
9. **Payments, after demand is validated:** Stripe or a merchant of record, as in `MONETIZATION.md`.
10. **Smaller known gaps:**
    - Handwriting search (no recognition yet).
    - Asset garbage collection.
    - Audio and sharing, which are labelled as unavailable.
    - Note images across notebooks.
    - The production page security policy still allows `ws://localhost` (used only in development).

## Known data-loss risks

**None known.** Every risk found in the audit has a fix and a regression test:
- the library reset
- concurrent instances
- unsaved edits on quit
- newer-version overwrite
- the data-folder rename

Remaining by design: a hard crash can lose at most the ~0.5 s of edits before the last automatic save.
