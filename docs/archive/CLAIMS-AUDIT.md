# Claims audit: README, download site and user docs

Checked 1 Nov 2026 against the code on `beta-release` (`14baed9`): the app (`src/shared/ai.ts` consent text, `src/main/updater.ts`, `src/shared/product.ts`), the AI server (`beta-server/src/handler.ts`, `ledger.ts`, `wrangler.jsonc`) and the release workflow. **This is a factual accuracy check, not a legal review. Inkling does not claim compliance with any privacy law.**

| Topic | What the code does | What the pages said before | Now |
|---|---|---|---|
| AI content | Question + selection image or page text go to Inkling's Worker, then Workers AI. The Worker never stores or logs content (logs record only error kinds) | "Inkling's AI server doesn't store it" | Same, plus who answers (Qwen on Cloudflare Workers AI). Cloudflare's no-retention/no-training is attributed to Cloudflare ("Cloudflare states"), not claimed by Inkling |
| Identifiers | Every AI request carries an anonymous installation ID (`x-inkling-install`) and the IP (`cf-connecting-ip`), stored only as SHA-256 hashes with a salt that rotates and is deleted each UTC day | Not mentioned in README or site | Stated on README, site, user guide, install guide and release notes |
| Consent | Nothing is sent before the user clicks *Allow* and asks; consent can be withdrawn in Settings. The cloud consent is one generic *Allow* per installation, with no age question | "Only what you ask about is sent, after you click Allow" | Kept (accurate) |
| Ages | The app doesn't check ages. Only Gemini (not in release builds) has an 18+ confirmation | "Under 18? A parent or guardian should install Inkling and decide" | Says the app doesn't check ages and that children's data handling hasn't been reviewed by a lawyer; guidance for parents kept |
| Tracking | No analytics, ads or crash reporting in the app. Update checks contact GitHub (IP + version) | "No ads, analytics or tracking, in the app or on this page"; "no tracking" | App: "no ads or analytics", update check disclosed. Site: "sets no cookies and runs no analytics; GitHub, which hosts it, may log visits" |
| Limits | 900 Neurons/installation/day (≈10 answers), 2,700 per network, 9,000 for everyone over a rolling 24 h (≈110) | "About 10 answers a day per computer" | Same, plus the shared limit |
| Feedback | `INKLING_FEEDBACK_URL` is unset, so *Send Feedback* opens a GitHub issue (needs an account, public) | "Opens a short form"; "needs no account" | Says the form is being set up and what happens until then; the site shows a form button only once the URL is configured |
| Features | Audio and sharing aren't built (menu entries marked unavailable); handwriting not searchable; no real-device pen tests | Screenshots showed those entries without comment | README "Not yet" line; site requirement row notes pens are untested |
| Downloads | No release is published; the only release is a draft | README implied a download exists | README status line; site shows *Coming soon* |

**Legal placeholders, kept and marked as placeholders:** `docs/PRIVACY.md` (operator name, address and contact; children section; date), terms of use/EULA (none yet, `LICENSE.txt` is a placeholder), a security contact (`SUPPORT.md`). The README and site call the privacy notice a draft pending legal review.

**For counsel (not decided here):** parental consent for under-13s (US) and under-16s (parts of the EU/UK) before a child uses the cloud AI; whether the per-installation *Allow* is adequate on shared family or school computers (Hermes H-04).
