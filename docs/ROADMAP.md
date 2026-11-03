# Roadmap

What's built, what's verified, and what's left. Point-in-time status reports from earlier milestones are in [archive/](archive/README.md).

## Milestones

| Phase | Scope | Status |
|---|---|---|
| 1 | Library, pages, pen/highlighter/eraser, text, undo/redo, local auto-save | ✅ done |
| 2 | Lasso selection, shapes, images, zoom/pan, precise eraser, page sizes, typed command layer | ✅ done |
| 3 | Rich-text notes, search, links/backlinks, knowledge graph, PDF import/annotation/export | ✅ done |
| 4 | AI Tutor on Google Gemini (free tier): streaming chat about handwriting, practice mode, previewed corrections on the page | ✅ done |
| 4.6 | Local AI tutor on Ollama (default; Qwen3-VL), Gemini optional and 18+ only, narrow-window layout | ✅ done (results: [AI providers](AI.md#local-model-results)) |
| 4.7 | Free cloud AI: Inkling's server on Cloudflare Workers AI (Qwen 3.8 27B), anonymous per-installation and per-network daily allowances inside the free tier, Ollama and Gemini kept | ✅ built; tested against a fake model and the real one |
| 4.8 | Beta release: installers (Windows NSIS, macOS DMG), updates, release workflow, data-safety fixes, daily backups/restore, welcome, About, feedback, privacy | ✅ **Beta 2 (`v0.2.0-beta.2`) published as a pre-release on 3 Nov 2026**; installers and acceptance suites pass on Windows and macOS runners; hands-on device testing pending |
| 5 | Advanced AI editing on the canvas, more providers (OpenRouter, Anthropic Claude), handwriting search | planned |
| 6 | Signing and notarization, accessibility audit, download website | download site live since 3 Nov 2026; signing and the accessibility audit planned |

## Verification status

Every automated suite runs on Linux in this repository, and on real Windows and macOS runners for every release build (*Release* workflow), including the install → update → uninstall → reinstall check. Not verified yet:

| Item | Why | How to verify |
|---|---|---|
| Real pens, touch screens, trackpads, display scaling (125%/150%), multiple monitors | CI machines have no such hardware | [DEVICE-TESTING.md](DEVICE-TESTING.md) on a real Windows PC with a pen and a real Mac |
| Windows 10, Windows on ARM (x64 emulation), Intel Macs, macOS 12–14 | CI uses Windows Server 2022 and macOS 15 on Apple silicon | Testers on those systems |
| Security prompts on first open (SmartScreen, Gatekeeper) | Only appear for downloaded files on real machines | Download from the site on a real PC and Mac and follow [INSTALL.md](INSTALL.md) |
| In-app "new version" notice | Needs a second published release | Publish the next beta and check *About* in a Beta 2 install |

## Before inviting more testers

| # | Item | Who |
|---|---|---|
| 1 | Hands-on install and pen test on one real Windows PC and one real Mac ([DEVICE-TESTING.md](DEVICE-TESTING.md)) | You or a trusted tester |
| 2 | Decide the age policy (18+ is simplest; under 18 needs parental or school consent) and have counsel review [PRIVACY.md](PRIVACY.md), including who runs Inkling and a contact address | You, with counsel |
| 3 | Trademark check on "Inkling" before announcing publicly (Wacom Inkling pen; Inkling digital textbooks) | You and counsel |

**Accepted for the beta:** unsigned installers (explained in [INSTALL.md](INSTALL.md)); a small shared AI allowance (about 110 interactions a day in total, about 10 per installation); anonymous limits that a determined person could sidestep (the global cap still bounds use, and cost stays $0); no moderation model on AI answers.

## Before a public launch (prioritised)

1. **Code signing and notarization.** Apple Developer ID ($99/yr), and a Windows certificate or Azure Trusted Signing. This removes the security prompts and enables self-installing updates. The workflow already uses them when the secrets exist.
2. **Trademark clearance for "Inkling"**, given prior use by Wacom (digital pen) and Inkling (digital textbooks). Have a fallback name. See the [launch kit](archive/LAUNCH.md).
3. **Legal texts:** privacy policy (draft in `PRIVACY.md`), terms of use/EULA (only a placeholder `LICENSE.txt` exists), and a school/parental-consent approach.
4. **Hosted AI at scale:** a Workers Paid account with a billing alert, sign-in, and per-user allowances. See [AI.md](AI.md#hosted-ai-from-beta-to-product).
5. **Device coverage:** Windows on ARM, Intel Macs, Wacom/Surface/Huion pens, 4K displays, slow 8 GB laptops.
6. **Crash reporting (opt-in)** and an in-app "copy diagnostics" button, so testers can send useful reports without notebook content.
7. **Accessibility pass:** screen-reader labels on canvas tools, keyboard-only use of dialogs and menus, contrast. Basic labels and keyboard shortcuts exist; a full audit hasn't been done.
8. **Website:** the download site is live ([RELEASING.md](RELEASING.md#download-site)). A fuller product site could follow the outline in the [launch kit](archive/LAUNCH.md).
9. **Payments, after demand is validated:** Stripe or a merchant of record, as in the [editions plan](archive/MONETIZATION.md).
10. **Smaller known gaps:**
    - Handwriting search (no recognition yet).
    - Asset garbage collection.
    - Audio and sharing, which are labelled as unavailable.
    - Note images across notebooks.
    - The production page security policy still allows `ws://localhost` (used only in development).
    - The `regressions` acceptance suite is occasionally flaky on Linux at the recovery-notice step (1 failure in 3 runs on 3 Nov 2026; passed on re-run).

## Known data-loss risks

**None known.** Every risk found in the audit has a fix and a regression test:
- the library reset
- concurrent instances
- unsaved edits on quit
- newer-version overwrite
- the data-folder rename

Remaining by design: a hard crash can lose the edits since the last automatic save. Saves happen 0.5 s after the last edit, and at least every 2 s during continuous writing or typing (before 3 Nov 2026 continuous editing could postpone saving indefinitely).
