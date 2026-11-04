# AI inference providers: comparison, costs, limits, switch and rollback

*Researched 3 Nov 2026 from the providers' own pages (links below). Prices change; re-check them before switching production. Branch `migrate/external-inference`.*

## Summary

- **Recommendation: DeepInfra, called directly**, for Qwen 3.8 27B (`Qwen/Qwen3.8-27B`). At list price it costs **$0.59 per 1,000 measured answers** against $0.89 on Workers AI (−34%); during DeepInfra's current 25% promotion, $0.44 (−50%). It states no storage and no training on inference content, has an OpenAI-compatible streaming API with usage on the last chunk, and allows 200 concurrent requests per model by default.
- **Workers AI stays as the rollback**: one setting (`INFERENCE_PROVIDER`) switches back, on the same Worker, with the same ledger and the same app.
- **OpenRouter is supported but not recommended**: pinned to DeepInfra it is the same model on the same hardware for 5.5% more, with one more company handling notebook content, and pinning removes its main benefit (falling back to other hosts), which would be multi-provider routing.
- **Groq and Cerebras are not recommended for now**: Groq lists the model as *Preview*, is the most expensive, and counts every image as 2,048 tokens; Cerebras is the fastest but costs about 1.6× DeepInfra on Inkling's input-heavy requests.

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

## OpenRouter Free (`qwen/qwen3.8-27b:free`)

*Investigated 3 Nov 2026. Not yet tested live: the repository has no `OPENROUTER_API_KEY` secret (Actions run 41775457065 stopped at "Required secrets").*

| | What the documentation says | Verified live? |
|---|---|---|
| Availability | Listed as a free variant of Qwen 3.8 27B (released 14 Aug 2026); 262,144-token context; text, image and video in | not yet |
| Price | $0 input and output | not yet (the probe reads the account's credits before and after) |
| Daily quota | 50 requests a day; **1,000 a day once at least 10 credits ($10) have been bought** (all-time purchases) | not yet (`GET /api/v1/key` → `free_model_daily_requests`) |
| Per-minute quota | 20 requests a minute | not yet (the probe bursts 26) |
| Scope | Governed globally: more keys or accounts don't add capacity | — |
| Do free requests use the $10? | Not stated in OpenRouter's docs. Free variants are priced $0, so they shouldn't; one third-party review says failed requests still count against the daily allowance. A **negative balance blocks free models too**. | not yet |
| Fallback | A free variant has one endpoint: no other host when it is busy or down; a paid model is used only if a `models` fallback list names one | — |
| Host and data policy | Not shown on the model page. Across OpenRouter's free models, about half run on hosts that may train on prompts; others keep prompts for set periods. OpenRouter itself says it doesn't train on API traffic. Routing by data policy (`data_collection: deny`) refuses an endpoint whose host collects data. | not yet (the probe prints the endpoint's host and policy, and tries `deny` and `allow`) |

**What Inkling needs from it.** Streaming, image input, a reasoning switch (`reasoning: {enabled: false}`) and long context are all listed for the model; the free endpoint's own supported parameters and output cap are read by the probe. A structured answer, three handwriting images and a ~7,000-token conversation are probed directly.

**What is implemented** (`INFERENCE_PROVIDER=openrouter-free`, `wrangler.openrouter-free.jsonc`):
- **Never paid.** Only a model ending in `:free` is accepted; the request carries `provider.allow_fallbacks: false` and `provider.max_price` of 0 for prompt, completion, request and image, merged last so operator settings can't loosen them; `models`, `route`, `model` and `plugins` can't be added. If OpenRouter ever reports a charge above $0, the server pauses all answers and logs an error.
- **The account-wide quota.** `GLOBAL_REQUESTS_PER_DAY` (900 of 1,000) and `GLOBAL_REQUESTS_PER_MINUTE` (16 of 20) are checked before a request is sent, per UTC day like OpenRouter's counter, counting retries. A 429 is never retried. A 429 whose reset is more than 5 minutes away means OpenRouter's quota is gone (shared with anything else on the account): everyone is stopped until the reset, without calling OpenRouter again.
- **Fair shares.** Allowances use a *shadow* price (DeepInfra's list price), so per-installation and per-network limits still share out the free requests; nothing is billed.
- **Graceful failure.** Downtime: one retry, then "try again in a moment". No endpoint matching the data policy, or the free variant removed: "model unavailable". Quota gone: "Inkling's free AI has reached its provider's limit for today", with the reset time. Notebooks and the local Ollama tutor keep working.
- **Closed to shipped apps** (minimum notice 99) until a data notice names OpenRouter and the free endpoint's host.

**Capacity.** One tutor answer is one request. With 900 requests a day:

| Answers per active student per day | Students served per day |
|---|---|
| 3 | ~300 |
| 5 | ~180 |
| 10 | ~90 |

Today's Workers AI allowance gives ~110 answers a day, so OpenRouter Free is about 8× that. The 20-a-minute limit is the tighter one in a classroom: 30 students asking at once get about 16 answers in the first minute; the rest are asked to wait a few seconds. Capacity is OpenRouter's to change, and the free variant can disappear.

**Recommendation: supplemental at most, not primary — NO-GO until tested.** It can only be the primary provider if the live run shows (1) the endpoint's host neither trains on nor keeps prompts, so `data_collection: deny` answers; (2) answers match the Workers AI baseline on the 50 checks; (3) the credits balance doesn't move. Even then, one endpoint with no fallback, a quota shared account-wide and terms that can change make it a source of extra free capacity beside Workers AI's free allowance, not the base of the service. Using both would be routing between two free hosts of the same model, which needs your decision (it was out of scope so far) and a notice naming both.

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
