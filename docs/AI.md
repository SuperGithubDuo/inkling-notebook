# The AI Tutor: providers, terms and the hosted plan

Inkling's tutor reads handwriting from an image of what the student selected. It answers in chat, makes practice sets and checks answers, and proposes corrections on the page. A correction is drawn on the page only after the student approves it.

The tutor talks to models through one small interface, `src/main/ai/provider.ts`. Three implementations exist: the cloud beta, Ollama and Gemini. The instructions, output schemas, validation, consent and the canvas command layer are shared by all three.

## Guarantees in the app (verified by automated tests)

| Guarantee | Where | Tests |
|---|---|---|
| Nothing is sent before the user agrees (cloud beta and Gemini each have their own consent) and asks. | `src/main/ai/service.ts`, `src/renderer/src/ai/client.ts` | `tests/unit/ai.test.ts`, `beta.test.ts`, e2e `phase4`, `cloud` |
| AI marks are previewed. Nothing reaches the page before *Add to my page*, and adding is one undoable step. AI objects can't modify the user's own ink. | `src/renderer/src/ai/annotate.ts`, `canvas/commands.ts` | e2e `phase4`, `ollama`, `cloud` |
| No developer API credential in the app. The cloud beta app holds only the tester's own revocable access code. The server reaches Workers AI through a binding, so no API token exists. Gemini uses the user's own key, encrypted with the OS keychain. | `src/main/ai/config.ts`, `beta-server/` | `beta.test.ts` (code never stored in clear text) |
| Clear errors for an invalid key or code, rate limits, daily allowance used up, unavailable model, network failure, bad answers. Inkling never retries in a loop and never switches provider or model on its own. | `service.ts`, providers | unit and e2e |
| The notebook works fully with AI off or unavailable. | | e2e `phase1`–`phase3`, `release` (no AI configured) |

## Providers and their terms (reviewed 29 Oct 2026)

| | Inkling beta (cloud) | Ollama (local) | Google Gemini (own key) |
|---|---|---|---|
| Model | Qwen 3.8 27B on Cloudflare Workers AI (Apache-2.0 weights) | Qwen3-VL 2B/4B/8B (Apache-2.0) | Gemini 3.8 Flash / 3.5 Flash-Lite |
| User setup | An access code | Install Ollama and a 2–6 GB model | Create a Google API key |
| Age | Cloudflare's agreement sets no minimum age and has no rule on services for children. As the operator, Inkling is responsible for its users (e.g. COPPA: parental consent for under-13s). | None (nothing leaves the computer) | **18+ only.** Not allowed in apps aimed at, or likely to be used by, minors |
| Data use | Cloudflare doesn't train on Workers AI content and keeps no inputs or outputs of standard inference. The beta server keeps only usage counts. | Stays on the computer | **Free tier:** Google uses inputs and outputs to improve its products, and human reviewers may read them. Paid tier: not used for training. |
| Commercial use | Allowed. Cloudflare holds the customer responsible for outputs and for its end users. | Allowed (Apache-2.0) | The Gemini API is meant for developers building for business purposes, not for consumer use. Apps offered to users in the EEA, Switzerland or the UK must use **paid** services. |
| Cost to Inkling | Free within 10,000 Neurons a day for the whole account (measured: about 110 typical interactions at 82 Neurons each, under the server's 9,000 cap). Beyond that, $0.011 per 1,000 Neurons on Workers Paid. | None | None (the user's own key) |
| Fit for a student product | **Yes**, with Inkling's own privacy notice and age policy | **Yes** | **No** as a default. Kept only as an opt-in for adults bringing their own key. |

**Conclusion for the 7 November beta:** don't build on Gemini's free tier.
- If the beta server is deployed, the default is the cloud beta.
- Otherwise the default is Ollama, and the notebook is complete without AI.
- Gemini stays available, off by default and marked 18+.

The legal points above are a product review, not legal advice. Have counsel confirm the age policy and the privacy notice before a public launch to schools or under-18s.

## Hosted AI: from beta to product

The cloud beta (`beta-server/`, see its README) is a deliberately small version of the long-term architecture:

```
Inkling app ──HTTPS──▶ Inkling API (Cloudflare Worker)
  access code / later   ├─ authenticate (beta code → later a signed licence)
  a signed licence      ├─ entitlement → daily allowance per user
                        ├─ ledger (Durable Object): reserve → settle
                        ├─ server-owned prompts, schemas, token caps
                        └─ model call (Workers AI binding; any provider behind it)
```

Deployed on 30 Oct 2026 at `https://inkling-ai-beta.shenjonas9.workers.dev` (Workers Free) and tested against the real model: 50/50 checks, 82 Neurons per typical interaction (`docs/live-results/cloud-qwen3.8-27b.md`). Steps:
1. **Beta (now).** Deploy on a Cloudflare account on the Workers Free plan and hand out codes (`npm run admin -- add`). The free allowance supports roughly 10 testers × 11 interactions a day.
2. **More testers.** Move the account to Workers Paid with the server's global cap raised deliberately. At about 82 Neurons an interaction, $1 buys roughly 1,100 interactions. Keep the per-user allowance, and set a billing alert in Cloudflare.
3. **Product.** Replace access codes with sign-in and a signed licence (see `MONETIZATION.md`). The ledger's per-user allowance comes from the entitlement: a small free allowance, more for Pro.

Each step changes only the server and the entitlement source; the app's provider interface stays as it is.
