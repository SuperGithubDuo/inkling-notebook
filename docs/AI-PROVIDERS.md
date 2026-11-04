# AI inference providers: comparison, costs, limits, switch and rollback

*Researched 3 Nov 2026 from the providers' own pages (links below). Prices change; re-check them before switching production. Branch `migrate/external-inference`.*

## Summary

- **Recommendation: DeepInfra, called directly**, for Qwen 3.8 27B (`Qwen/Qwen3.8-27B`). At list price it costs **$0.59 per 1,000 measured answers** against $0.89 on Workers AI (−34%); during DeepInfra's current 25% promotion, $0.44 (−50%). It states no storage and no training on inference content, has an OpenAI-compatible streaming API with usage on the last chunk, and allows 200 concurrent requests per model by default.
- **Workers AI stays as the rollback**: one setting (`INFERENCE_PROVIDER`) switches back, on the same Worker, with the same ledger and the same app.
- **OpenRouter is supported but not recommended**: pinned to DeepInfra it is the same model on the same hardware for 5.5% more, with one more company handling notebook content, and pinning removes its main benefit (falling back to other hosts), which would be multi-provider routing.
- **Groq and Cerebras are not recommended for now**: Groq lists the model as *Preview*, is the most expensive, and counts every image as 2,048 tokens; Cerebras is the fastest but costs about 1.6× DeepInfra on Inkling's input-heavy requests.
- **Groq's free plan** is implemented as an unused, test-only option with strict request and token quotas, but is **NO-GO for production**: preview model (evaluation only, no DPA), and only ~100 answers a day (see below).

## Provider comparison (Qwen 3.8 27B)

| | Cloudflare Workers AI (today) | **DeepInfra (direct)** | OpenRouter → DeepInfra | Groq | Cerebras |
|---|---|---|---|---|---|
| Supported | Yes | Yes (since 5 Oct 2026) | Yes (23 hosts; pinned to one) | Yes, **Preview** | Yes |
| Model ID | `@cf/qwen/qwen3.8-27b` | `Qwen/Qwen3.8-27B` | `qwen/qwen3.8-27b` + `provider.order: ["deepinfra"]` | `qwen/qwen3.8-27b` | `qwen-3.8-27b` |
| Input $/M tokens | 0.45 | **0.20 list** (0.15 promo, no end date stated) | DeepInfra's + 5.5% fee | 0.80 | 0.99 |
| Output $/M tokens | 3.20 | **2.50 list** (1.875 promo) | DeepInfra's + 5.5% fee | 4.00 | 1.49 |
| Cached input $/M | 0.05 | 0.05 list (0.038 promo) | as DeepInfra | not stated | listed at 0.99 on OpenRouter |
| Context | 262,144 | 262,144 (1M via YaRN) | as DeepInfra | 131,072 | 65,536 free trial; 131,072 paid |
| Max output | not stated | not stated | not stated | 16,384 | 32,768 free; 40,960 paid |
| Rate limits | not on the model page; Workers Free stops at 10,000 Neurons/day | 200 concurrent requests per model (no RPM cap); raise on request | passed through | not on the model page | free trial 5 req/min, 1M tokens/day; Developer 300 req/min |
| Streaming | Yes | Yes; usage on the final chunk | Yes; usage always included | Yes | Yes |
| API fit | current code | OpenAI-compatible; thinking on by default, switchable per request; `reasoning_effort` | OpenAI-compatible; `reasoning`, provider routing | OpenAI-compatible; `reasoning_effort: none`; ≤ 3 images, each **2,048 tokens** | OpenAI-compatible; reasoning defaults to `high`, `none` turns it off |
| Data retention | Doesn't keep inputs/outputs of standard inference | Not stored on disk (memory only during processing); logs metadata only (request ID, cost, sampling params) | OpenRouter adds itself as a processor; `zdr: true` limits routing to zero-retention endpoints | No retention by default, **but** inputs/outputs may be logged up to 30 days for abuse/troubleshooting unless ZDR is switched on in Data Controls | Privacy policy says inputs/outputs aren't retained; API customer terms may differ |
| Training on prompts | No | No (except Google/Anthropic models, not used here) | Depends on endpoint; `data_collection: deny` enforced | Not stated on the data page | Not stated explicitly for API |
| Production suitability | Production, but the free allowance is ~120 answers/day | **Production** (SOC 2, ISO 27001 stated) | Production gateway; extra hop | **Preview** — not for production | Production; price |

Commercial use: the Qwen 3.8 weights are Apache-2.0; all five are commercial APIs.

**DeepInfra's terms, checked 3 Nov 2026** ([terms of service](https://deepinfra.com/terms), [privacy policy](https://deepinfra.com/privacy)):
- **Retention and training** (section 7(b), "Zero Data Retention"): no retaining, storing or logging of customer content beyond processing; no training or improving models on it. Exceptions: support cases (deleted within 30 days), non-content metadata (request counts, billing), records for legal compliance or fraud/abuse investigations, and opt-in features (batch, paid cache retention). These terms override the privacy policy and docs.
- **DPA**: incorporated by section 5(a) (trust.deepinfra.com) for personal data in customer content.
- **Users under 18**: the terms set **no minimum age** for a customer's end users and no rule against services for children (unlike the Gemini API). The customer is "solely responsible" for everyone using the service under its account and must follow applicable law (sections 5(b), 10). The privacy policy says DeepInfra's own site is not for under-18s; that concerns DeepInfra's account holders, not Inkling's users. So Inkling may serve students, but COPPA/GDPR-K obligations stay with Inkling (see PRIVACY.md).
- **Commercial terms**: customer keeps its IP in its content; no competing service, no resale, no circumventing usage limits; liability capped at six months of fees; customer indemnifies DeepInfra for its users' conduct.
- **Billing**: in practice **prepaid** — a development key with no balance got HTTP 402 "You need positive balance to do inference" on every request (3 Nov 2026). Keep auto top-up off and set the account spending limit (`POST /payment/config`, `limit` in USD) so the provider balance is a hard backstop under Inkling's own caps. The server treats 402 as "out of credit": everyone is paused 15 minutes and the Worker logs `deepinfra account has no credit` as an error.

Reliability: no provider publishes an SLA for this model on the pages checked, and no outage history was measured. The adapter's retries cover short hiccups; a long DeepInfra outage is handled by the operator rolling back to Workers AI (below).

### OpenRouter-pinned vs DeepInfra direct

| | DeepInfra direct | OpenRouter pinned to DeepInfra |
|---|---|---|
| Cost | DeepInfra's price | DeepInfra's price + 5.5% platform fee |
| Who sees notebook content | Cloudflare (Worker) → DeepInfra | Cloudflare → **OpenRouter** → DeepInfra |
| Failover | none (rollback to Workers AI is manual) | none while pinned (`allow_fallbacks: false`); unpinning = multi-provider routing, which is out of scope |
| Cost reporting | token counts (Inkling applies list price) | reported `cost` per request (Inkling adds the 5.5%) |
| One bill for several models | no | yes — not needed (one model) |
| Latency | one hop fewer | one more hop |

### Other hosts seen on OpenRouter

Several hosts list the same model cheaper (e.g. Prime Intellect $0.024/$1.324, Chutes $0.039/$1.25, about half DeepInfra's cost). They were not evaluated: their retention and training terms weren't checked, and choosing among them is exactly the multi-provider routing this migration excludes. Worth a separate review if spend becomes significant.

## Groq free plan (`qwen/qwen3.8-27b`): implemented, NO-GO for production

*Checked 3 Nov 2026 against Groq's own docs and Services Agreement (updated 22 Jun 2026). Live tests are wired up but not yet run: the repository has no `GROQ_API_KEY` secret (Actions run 41778755405 stopped at "Required secrets").*

**What Groq's documentation states**

| | Groq free plan |
|---|---|
| Model ID | `qwen/qwen3.8-27b` — listed under **Preview models** |
| Free limits (organization-wide, not per key) | 30 requests/min, 1,000 requests/day, **8,000 tokens/min, 200,000 tokens/day** |
| Context / max output | 131,072 / 16,384 |
| Input | text and images (≤ 3 per request, ≤ 20 MB, **each image counts 2,048 tokens**) |
| Streaming | yes (OpenAI-compatible SSE; usage in `x_groq.usage` on the last chunk) |
| Reasoning | off by default for this model; `reasoning_effort` low/medium/high (the docs disagree on whether `none` is accepted, so the server sends nothing) |
| Billing | the Developer (paid) plan needs a card, US bank account or SEPA debit; a Free org without a payment method has nothing to charge |
| Retention | none by default; inputs/outputs may be logged up to 30 days for abuse/reliability unless **Zero Data Retention** is switched on (Data Controls; "all customers may enable" it) |
| Training | Services Agreement §4.2: Groq may not use inputs or outputs for training without the customer's permission |
| Age | §2: the account holder must be 18+; §6.3: for an app likely used by minors, the customer is solely responsible for complying with the law |

**Why NO-GO for production**

1. **Preview = evaluation only.** Groq's models page: preview models are for evaluation and should not be used in production; they may be discontinued at short notice.
2. **Preview = Beta Service under the Services Agreement (§3.6)**: provided as-is, may be discontinued at any time, no support or indemnity, and **the DPA does not apply**. Inkling's users are students (many under 18); serving their notebooks without a data processing agreement isn't acceptable.
3. **Capacity is about the same as Workers AI Free, not 1,000 answers a day.** The token quota binds long before the request quota: measured Inkling answers use ~0.5–1.2k tokens on text and ~2.5–2.9k with a handwriting image (Groq's fixed 2,048 per image). At 180,000 planned tokens/day that is **~60 (every answer with a handwriting image) to ~300 (text only), about 110 a day for a 50/50 mix**.
4. **8,000 tokens a minute is a classroom bottleneck**: two or three image answers a minute for everyone together.
5. **The free plan can change at any time** (§3.5, §5.1). Multiple accounts to multiply the quota would breach §6.3(d)(iii) (use "intended to avoid incurring Fees").

**What is implemented (kept unused, like OpenRouter Free)**

- Provider `groq` (`beta-server/src/provider.ts`): only `qwen/qwen3.8-27b`; `service_tier` locked to `on_demand`; `reasoning_format: parsed`; no tools; `max_completion_tokens`; operator extras can't change any of these.
- Config fails closed without request **and** token quotas, with any quota above Groq's free limits, with another model, or with another base URL.
- Ledger (one Durable Object, every operation serialized): rolling 24-hour request and token counts in hourly buckets, a persisted 60-second window, each request's **worst case** (estimated input × margin + output cap, images ≥ 2,048) held before sending and replaced by Groq's reported count after. Unsettled reservations stay charged; retries count as requests. Daily requests are checked over any 24 hours as well as the UTC day.
- **Plan guard**: if Groq's `x-ratelimit-limit-requests` (> 1,000/day) or `x-ratelimit-limit-tokens` (> 8,000/min) ever show more than the free plan, the server pauses itself — an upgraded account could bill.
- New refusal `free_token_quota` (503 with the real wait); minute-quota refusals are `capacity` with the seconds until room.
- Test Worker `inkling-ai-groq-next` (`wrangler.groq.jsonc`): 900 req/day, 25/min, 180,000 tokens/day, 7,000/min; `MAX_INPUT_TOKENS` 4,000 so every worst case fits in a minute (long conversations are refused that Workers AI accepts). `MIN_NOTICE_VERSION` 4 is **test only**; with Groq's default (99) no shipped app can reach it, because no notice names Groq.
- `scripts/groq-probe.mjs`, `scripts/groq-quota-check.mjs`, workflow `ai-server-groq.yml` (push `deploy/ai-server-groq`). 22 unit tests (`tests/unit/groq.test.ts`).

**To run the live tests**: create a Groq account on the free plan (no payment method), switch on Zero Data Retention in Data Controls, create a key, add it as the repository secret `GROQ_API_KEY`, and re-run the workflow. The probe stops before deploying anything if the account's headers don't show free-plan limits.

**Revisit when** Groq moves `qwen/qwen3.8-27b` to production status (the DPA would then apply). Even then it adds a second free pool of roughly Workers AI's size, and it needs a new data notice naming Groq.

## OpenRouter's other free models: NO-GO (tested live 4 Nov 2026)

*Actions runs 41781743771 (all five, 05:51 UTC) and 41781864801 (the two Gemma models, 10 attempts each, 30 s apart, 05:52–06:02 UTC). Every request was locked as the server locks it: the `:free` model, `provider.only` = its single listed host, `allow_fallbacks: false`, a $0 price ceiling, `data_collection: "deny"`. Nothing was retried with a looser policy. Free requests used: 0 of 50; credits $0 bought, $0 used, before and after.*

| Model ID | Input | Host | Result under the lock |
|---|---|---|---|
| `nvidia/nemotron-3.5-super-vl:free` | text, image, video; 1M context | NVIDIA (API Trial terms) | **404** "No endpoints found matching your data policy (Free model training)" |
| `nvidia/nemotron-3.5-lightning:free` | text; 1M | NVIDIA | **404**, same (Free model training) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | text, audio, image, video; 256k | NVIDIA | **404**, same (Free model training) |
| `google/gemma-4-31b-it:free` | text, image, video; 262k | Google AI Studio | passes the data-policy filter, then **429 on all 10 attempts** over 4.5 min ("temporarily rate-limited upstream", `limit_source: upstream_provider_shared_pool`) |
| `google/gemma-4-26b-a4b-it:free` | text, image, video; 262k | Google AI Studio | **429 on all 10 attempts** over 4.5 min, same |

- **NVIDIA's free endpoints may train on prompts**: OpenRouter's own data-policy filter removes them. Their terms are NVIDIA's *API Trial* terms. Not usable for students' notebooks, whatever the quality.
- **Gemma 4 on Google AI Studio** is the only privacy-filter pass, but no request was answered in 22 tries: it draws on a pool shared by every free OpenRouter user. Even when it answers, Google AI Studio keeps prompts (reported 55 days) and the account allowance is **50 requests a day** (1,000 only after buying $10 of credits, which the $0 rule excludes).
- So **no quality, image or streaming result exists for any of the five**; none answered a single locked request. Workers AI Free answered 13 of 13 Inkling scenarios (50 of 50 checks) on 30 Oct.
- New safeguard kept on the branch: `openrouter-free` now requires `UPSTREAM_PROVIDERS` (locked into `provider.only`), so a request can never reach a host whose policy wasn't reviewed; a non-Qwen model reports its own name to the app.

## OpenRouter Free (`qwen/qwen3.8-27b:free`): withdrawn

*Tested live 4 Nov 2026 04:56 UTC with a development key (Actions run 41776120846).*

**The free variant is no longer offered.** Every request to `qwen/qwen3.8-27b:free` got HTTP 404 "This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen3.8-27b", and the model is no longer in OpenRouter's public model list. The free requests were not counted (0 of 50 used afterwards), and the account's credits stayed at $0 bought / $0 used.

| Check | Result |
|---|---|
| Account without purchased credits | `is_free_tier: true`, 0 credits; **50 free requests a day** (1,000 needs $10 bought), per OpenRouter's key-information API |
| Free Qwen 3.8 27B | **unavailable** (404) — streaming, images, reasoning, long context, latency and quality could not be tested |
| Host, logging, retention, training | not reported: no free endpoint exists |
| No-training restriction | `data_collection: deny` sent and locked; also refused (404, same reason) |
| Paid model with the zero price ceiling | refused by OpenRouter: 404 "No endpoints found that satisfy the max price" — the guard works against the real API |
| Credits consumed | none |

**What stays on the branch** (`INFERENCE_PROVIDER=openrouter-free`, `wrangler.openrouter-free.jsonc`), unused, in case a free variant returns:
- **Never paid.** Only a model ending in `:free`; `provider.allow_fallbacks: false`, `max_price` 0 (prompt, completion, request, image) and `data_collection: deny`, all merged last so settings can't loosen them; no `models`, `route`, `model` or `plugins` from settings. A reported charge pauses the server. The 404's suggested paid slug is never followed.
- **The account-wide quota.** `GLOBAL_REQUESTS_PER_DAY` and `_PER_MINUTE` checked before sending, retries counted, no 429 retries, a long-reset 429 stops everyone until the reset; `/admin/summary` shows OpenRouter's own counter.
- **Closed to shipped apps** (notice 99) until a notice names OpenRouter and the free host.

Even if it returned, capacity without buying credits would be 50 requests a day for the whole service (about 10 students at 5 answers each, below Workers AI's ~110 answers a day); with $10 bought, 1,000 a day and 20 a minute.

## Costs

Token profiles are **measured** with the real model (13 answers, `docs/archive/live-results/cloud-qwen3.8-27b.md`): chat 640→150, markup 1,030→278, check 370→58, practice 365→322; blended 60/25/10/5 = **697 input → 181 output tokens**. "App-size" adds full-size images and longer histories (monetization audit): 1,100 → 225. Output is 65–76% of the cost. Reproduce with `node beta-server/scripts/cost-model.mjs`.

**Measured profile (697 → 181)**

| Provider | Per answer | 1,000 | 10,000 | 100,000 | 1,000,000 |
|---|---|---|---|---|---|
| Workers AI | $0.00089 | $0.89 | $8.93 | $89.29 | $893 |
| **DeepInfra, list** | **$0.00059** | **$0.59** | **$5.92** | **$59.19** | **$592** |
| DeepInfra, promo | $0.00044 | $0.44 | $4.44 | $44.39 | $444 |
| OpenRouter → DeepInfra, list | $0.00062 | $0.62 | $6.24 | $62.45 | $624 |
| Cerebras | $0.00096 | $0.96 | $9.60 | $95.97 | $960 |
| Groq | $0.00128 | $1.28 | $12.82 | $128 | $1,282 |
| Groq, 2,048-token images | $0.00192 | $1.92 | $19.22 | $192 | $1,922 |

**App-size profile (1,100 → 225)**

| Provider | Per answer | 1,000 | 10,000 | 100,000 | 1,000,000 |
|---|---|---|---|---|---|
| Workers AI | $0.00121 | $1.21 | $12.15 | $122 | $1,215 |
| **DeepInfra, list** | **$0.00078** | **$0.78** | **$7.83** | **$78.25** | **$783** |
| DeepInfra, promo | $0.00059 | $0.59 | $5.87 | $58.69 | $587 |
| OpenRouter → DeepInfra, list | $0.00083 | $0.83 | $8.26 | $82.55 | $826 |
| Cerebras | $0.00142 | $1.42 | $14.24 | $142 | $1,424 |
| Groq | $0.00178 | $1.78 | $17.80 | $178 | $1,780 |

For scale: Workers AI's free 10,000 Neurons/day are worth $0.11/day (~123 measured answers). These DeepInfra figures are **estimates from Workers AI token counts**; DeepInfra's tokenizer and image accounting may differ slightly, so measure with the live suite (mode 3) before relying on them.

## Limits and budgets (recommended starting values)

| Setting | Value | Means |
|---|---|---|
| `INSTALL_DAILY_USD` | $0.02 | ≈ 25–34 answers a day per installation (today ~10) |
| `INSTALL_MONTHLY_USD` | $0.30 | ≈ 380–500 a month: daily use keeps its ceiling, a fresh install per day doesn't multiply a month |
| `NETWORK_DAILY_USD` | $0.06 | 3 installations' worth per network (a classroom on one IP shares it; raise for schools) |
| `GLOBAL_DAILY_USD` | $1.00 (any 24 h) | ≈ 1,300–1,700 answers a day for everyone (≈ 12× today) |
| `GLOBAL_MONTHLY_USD` | $20 | hard monthly cap; ~25,000–34,000 answers |
| `SOFT_LIMIT_FRACTION` / `_FACTOR` | 0.8 / 0.5 | at 80% of the day's or month's budget, every daily share halves |

Growth rule of thumb: an active student averaging 5 answers a day costs about $0.10 a month at list price. A $20 month supports ~200 such students; $100 ~1,000; $600 ~6,000. Keep `GLOBAL_DAILY_USD` at about 1.5× the monthly cap ÷ 30, so one busy day can't spend a week's budget. Also set a spending limit or prepaid balance on the DeepInfra account, if it offers one, as a backstop outside Inkling's own ledger.

## How it works

```
Inkling app ──HTTPS──▶ Cloudflare Worker (beta-server/)                 ──HTTPS──▶ DeepInfra (Qwen/Qwen3.8-27B)
  install ID              • validate request, server-owned prompts            Bearer INFERENCE_API_KEY (Worker secret)
  x-inkling-notice: 4     • notice gate, duplicate check                       streaming SSE, usage on last chunk
  (no key, no provider)   • Ledger (Durable Object): reserve worst case ─┐
                            against install/network/day/month caps (µ$)  │    ──binding──▶ Workers AI (rollback,
                          • provider adapter: timeouts, ≤3 attempts      │                  INFERENCE_PROVIDER=workers-ai)
                          • settle real cost from provider usage ◀───────┘
Cloudflare Pages: website and downloads (unchanged)
```

Accounting: before the call, the request's worst case (estimated input + the task's output cap, at list price) is reserved against every cap; afterwards the provider's reported usage replaces it — its token counts, cached tokens at the cached price, and its reported dollar cost when given (OpenRouter). If usage is missing, the estimate is conservative: produced text at 3 characters a token, never below the input estimate, and a stopped or broken stream is charged its full reservation. A timed-out attempt that is retried is also charged its input.

## Production switch (needs your approval; nothing here has been done)

1. **Test Worker.** Add the repository secret `DEEPINFRA_DEV_API_KEY` (a development key) and run *Actions → AI server (external provider, test)* with *live test* on. Compare its report with the Workers AI baseline (`docs/archive/live-results/cloud-qwen3.8-27b.md`): the 50 checks, first-text and total latency, tokens per answer and µ$ per answer. From a computer instead: `INKLING_LIVE_PROVIDER=deepinfra INFERENCE_API_KEY=… npm run test:live:cloud`.
2. **Check DeepInfra's terms** (minors, DPA, abuse-monitoring retention) and fill the `[OPERATOR TO SUPPLY]` items in PRIVACY.md.
3. **Release the app first.** Merge this branch and publish a release: users see the new notice (version 4, naming DeepInfra) and agree again. The production server still answers with Workers AI, and accepts both old and new apps.
4. **Switch the production Worker** (same account, same name, same ledger), once most users have updated:
   ```bash
   cd beta-server
   npx wrangler secret put INFERENCE_API_KEY      # the PRODUCTION DeepInfra key
   # in wrangler.jsonc → vars, add the external block from wrangler.external.jsonc:
   #   INFERENCE_PROVIDER=deepinfra, UPSTREAM_MODEL, PRICE_*, GLOBAL_DAILY_USD, GLOBAL_MONTHLY_USD,
   #   INSTALL_DAILY_USD, INSTALL_MONTHLY_USD, NETWORK_DAILY_USD, TYPICAL_USD_PER_ANSWER,
   #   SOFT_LIMIT_FRACTION, SOFT_LIMIT_FACTOR, UPSTREAM_*, MIN_NOTICE_VERSION=4, GLOBAL_CONCURRENT=24
   npx wrangler deploy
   npm run admin -- summary                       # unit "usd", limits as set
   ```
   The Worker can stay on **Workers Free**: inference is no longer on Cloudflare's bill, the SSE handling is the same work it does today, and staying Free keeps the rollback unable to bill. The existing deploy workflow's real-model step measures Neurons and needs adapting before it is used on an external-provider configuration.
   From that moment apps still on notice 3 get "Update Inkling to keep using it" (no content is sent to a provider their notice doesn't name).
5. **Watch** `/admin/summary` (`monthUsed`, `reduced`), DeepInfra's usage dashboard, and the Worker's error-kind logs (`deepinfra error <kind>`, `deepinfra refused the API key`) for the first days.

## Rollback

- **Fast (one setting):** set `INFERENCE_PROVIDER` to `workers-ai` in `wrangler.jsonc` and `npx wrangler deploy`. Answers come from Workers AI again at once; the ledger restarts its daily counts in Neurons (dollar counts aren't misread) and keeps the month's dollar total for a later return. Apps with notice 3 or 4 both work (`MIN_NOTICE_VERSION` defaults to 0 on Workers AI). Keep the account on Workers Free for this to stay unbillable.
- **Full:** redeploy `main` as it was before the merge (`git revert` the merge commit, then the normal *Beta AI server* workflow). The installed app keeps working (its notice names Workers AI as the backup).
- **Emergency:** `npm run admin -- pause` (or *Actions → AI server emergency switch → pause*) stops all answers immediately; `wrangler secret delete INFERENCE_API_KEY` makes the Worker refuse to serve (fails closed).

## Sources

- [DeepInfra: Qwen3.8-27B model page](https://deepinfra.com/Qwen/Qwen3.8-27B) · [launch post](https://deepinfra.com/blog/qwen3-8-27b-deepinfra) · [data privacy](https://docs.deepinfra.com/account/data-privacy) · [rate limits](https://docs.deepinfra.com/account/rate-limits.md) · [streaming](https://docs.deepinfra.com/chat/streaming)
- [OpenRouter: Qwen3.8 27B](https://openrouter.ai/qwen/qwen3.8-27b) · [provider routing](https://openrouter.ai/docs/features/provider-routing) · [ZDR](https://openrouter.ai/docs/guides/features/zdr.md) · [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md) · [pricing](https://openrouter.ai/pricing)
- [Groq: qwen/qwen3.8-27b](https://console.groq.com/docs/model/qwen/qwen3.8-27b) · [your data](https://console.groq.com/docs/your-data)
- [Cerebras: qwen-3.8-27b](https://inference-docs.cerebras.ai/models/qwen-3.8-27b.md) · [privacy policy](https://www.cerebras.ai/privacy-policy)
- [Cloudflare Workers AI: qwen3.8-27b](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/) · [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
