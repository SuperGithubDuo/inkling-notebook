# Inkling AI server

A small Cloudflare Worker that gives everyone who installs Inkling the AI Tutor with nothing to set up: no account, code, key or download. It answers with **Workers AI** (`@cf/qwen/qwen3.8-27b`, a vision model) on Cloudflare's **free** allowance, shares that allowance out fairly among anonymous users, and never lets the service use more than the free tier.

```
Inkling app ──HTTPS──▶ Worker (this folder) ──AI binding──▶ Workers AI (Qwen 3.8 27B)
 random install ID      validates, reserves allowance,         10,000 free Neurons/day
 (no account)           adds Inkling's instructions            per account
                                 │
                                 ▼
                        Durable Object "ledger"
                        today's totals, salted hashes of
                        install IDs and networks, reservations
```

## Who answers: Workers AI or an external provider

`INFERENCE_PROVIDER` picks who runs the model; the app can't tell the difference (same API, same model name in `/v1/status`).

| `INFERENCE_PROVIDER` | Model call | Ledger unit | What bounds spending |
|---|---|---|---|
| unset / `workers-ai` (as deployed today) | `AI` binding, `@cf/qwen/qwen3.8-27b` | Neurons | Workers **Free**: Cloudflare refuses past 10,000 Neurons/day |
| `deepinfra` (recommended next) | `https://api.deepinfra.com/v1/openai`, `Qwen/Qwen3.8-27B`, key in the `INFERENCE_API_KEY` secret | µ$ (millionths of a dollar) | `GLOBAL_DAILY_USD` (any 24 h) and `GLOBAL_MONTHLY_USD` (calendar month) hard caps |
| `openrouter-free` | `qwen/qwen3.8-27b:free` (**withdrawn by OpenRouter, 4 Nov 2026: 404 "unavailable for free"**): no fallback, zero price ceiling, no data collection, a charge pauses the server | µ$ at a shadow price | `GLOBAL_REQUESTS_PER_DAY` / `_PER_MINUTE` (OpenRouter's account-wide 1,000/day, 20/min); closed to shipped apps until a notice names it |
| `openrouter` | OpenRouter pinned to DeepInfra (`allow_fallbacks: false`, `data_collection: deny`, `zdr: true`), +5.5% fee | µ$ | same; closed to shipped apps until the data notice names OpenRouter |

An external provider gets a 45 s first-byte timeout, a 45 s idle timeout, and at most 3 attempts with exponential backoff (500 ms × 2ⁿ, jittered, ≤ 4 s each, ≤ 8 s in all) for failures **before** an answer starts (timeouts, 408/429/5xx). Nothing is retried once text has streamed; a `Retry-After` longer than 4 s is passed on instead of waited for. A rejected key (401/403) is logged as an operator error; no credit (402) pauses everyone for 15 minutes like Workers AI's free-allocation error. The worker **fails closed**: without the key, the prices or both dollar caps it answers nothing. `wrangler.external.jsonc` is a ready configuration for a separate test Worker (`inkling-ai-next`). Provider research, costs and the switch/rollback procedure: [docs/AI-PROVIDERS.md](../docs/AI-PROVIDERS.md).

## Who can use it, and how it is limited

Anyone running Inkling. Each request carries the app's **installation ID**, a random value Inkling creates on first run (`inst_…`, in `ai-settings.json`). The Worker also takes the client's **network** from Cloudflare (`cf-connecting-ip`, set by Cloudflare's edge and not by the client; IPv6 grouped by /64). Both can be changed by someone determined (reinstall, another network, a VPN), so they only spread the allowance fairly among ordinary users. **The global cap is what bounds use.**

| Layer | Default | Behaviour |
|---|---|---|
| Cloudflare account on **Workers Free** | 10,000 Neurons/day | On the Free plan, usage beyond the allowance **fails with error 4006 instead of being billed**. This is the guarantee, so keep the account on Free. The Worker refuses to serve unless `ACCOUNT_PLAN` is `"free"`, and the deploy workflow refuses a Workers Paid account. |
| Global cap | 9,000 Neurons/day | The ledger stops everyone before Cloudflare's limit (cannot be set above 9,500). |
| Per installation | 900 Neurons/day (~10 answers), 6 a minute, 1 at a time | |
| Per network | 2,700 Neurons/day, 20 a minute, 4 at a time | A school or office shares this. |
| Whole service | 12 answers at a time | |
| Reservations | | Before the model is called, the request's worst case (estimated input + the full output cap) is reserved against the global cap; the installation and network need room for a typical answer. The real cost (the model's token counts × Cloudflare's rates) then replaces it; an unknown cost (stopped answer, crash) stays charged. Every ledger update runs one at a time inside the Durable Object, so simultaneous requests can't together pass a cap. |
| Request limits | | 3.5 MB body, 12,000 estimated input tokens, Inkling's request schema (at most 2 images, JPEG/PNG ≤ 1 MB, 24 turns), output caps per task. |
| Emergency pause | off | The operator can stop all answers at once (below). |
| **External provider only** | | |
| Global dollar caps | `GLOBAL_DAILY_USD` (rolling 24 h), `GLOBAL_MONTHLY_USD` (UTC month) | The worst case of every request in progress is reserved against both before the provider is called. |
| Per installation per month | `INSTALL_MONTHLY_USD` | Counted under a monthly salt, deleted when the month ends. |
| Budget protection | at `SOFT_LIMIT_FRACTION` (0.8) of either cap | Daily allowances per installation and network are multiplied by `SOFT_LIMIT_FACTOR` (0.5); `quota.reduced` is true. |
| Duplicates | 10 s | An identical request from the same installation that was **answered** in the last 10 s is refused without calling the model (a failed one can be retried at once). |
| Data notice | `MIN_NOTICE_VERSION` (4 on DeepInfra) | Apps send `x-inkling-notice`; an app whose user agreed to a notice that doesn't name the provider is told to update, before anything is sent. |

When a limit is reached the app shows a friendly message (for example *"You've used today's free AI answers on this computer. More are available in about 6 hours. Your notebooks work as usual…"*) and offers the tutor on this computer (Ollama).

**Not a general-purpose model proxy.** Callers send only a task (`chat`, `practice`, `check`, `annotate`) and the conversation. The server applies Inkling's own instructions, model, output format and token caps (`src/main/ai/prompts.ts`); anything else in the request is ignored. There are no other routes, no CORS headers (so web pages can't call it from a visitor's browser), and only `application/json` is accepted.

**No secret in the app.** The Worker reaches Workers AI through its `AI` binding: no Cloudflare API token exists at runtime. The app holds no credential at all. The only secret is the operator's `ADMIN_TOKEN` (stored as a Worker secret and a GitHub secret).

**What is kept.** Nothing of what people send: the Worker never stores or logs content, and Cloudflare says Workers AI does not train on customer content or retain inputs and outputs ([data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)). The ledger stores today's totals and, per installation and network, a count under a SHA-256 hash salted with a random value that changes every UTC day; at the day's end the salt and the counts are deleted. Per-request invocation logs are off; the Worker logs only error kinds.

## Deploy

You need a Cloudflare account on the Workers **Free** plan. Open *Workers & Pages* in the dashboard once, so the account gets its `workers.dev` subdomain.

### From GitHub Actions (recommended; nothing to install)

`.github/workflows/beta-server.yml` deploys the server and tests it.

1. In Cloudflare, create an API token (*My Profile → API Tokens → Create Token → Create Custom Token*) with: Account › Workers Scripts: Edit; Account › Account Settings: Read; Account › Billing: Read; Account › Workers AI: Read; User › Memberships: Read; User › User Details: Read. Limit it to your account.
2. In GitHub, *Settings → Secrets and variables → Actions*, add the secrets `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `INKLING_ADMIN_TOKEN` (at least 32 random characters, e.g. `openssl rand -base64 36`).
3. *Actions → Beta AI server → Run workflow* on `main` (or push the branch `deploy/beta-server` from `main`).

The workflow refuses a Workers Paid account; deploys; runs the security checks (`scripts/abuse-check.mjs security`); runs the real-model scenarios anonymously, as a freshly installed app; deploys a **temporary** copy with tiny limits to check the installation, network, per-minute, one-at-a-time, global-cap and pause limits against the real model, then deletes it; and reports Cloudflare's own Neuron count and the account's plan.

Set the server address from the run summary as the repository **variable** `INKLING_BETA_URL`; the next installer build has it built in and uses it by default.

### From your computer

```bash
npm ci                                      # in the repository root: the server shares the app's request schema and prompts
cd beta-server
npm ci
npx wrangler login                          # once
npx wrangler secret put ADMIN_TOKEN         # a long random string (≥ 32 chars)
npx wrangler deploy                         # prints https://inkling-ai-beta.<your-subdomain>.workers.dev
MAIN_VITE_INKLING_BETA_URL=https://inkling-ai-beta.<your-subdomain>.workers.dev npm run build   # in the root
```

A build without an address has no cloud AI; Ollama is its default.

## Operate

```bash
export INKLING_BETA_URL=https://inkling-ai-beta.<your-subdomain>.workers.dev
export INKLING_ADMIN_TOKEN=…                # the ADMIN_TOKEN secret

npm run admin -- summary                    # today's totals (no identities)
npm run admin -- pause                      # stop all AI answers now
npm run admin -- resume
```

Without a terminal: *Actions → AI server emergency switch → Run workflow* and choose `pause`, `resume` or `summary` (`.github/workflows/beta-server-ops.yml`).

To change a limit, edit `wrangler.jsonc` and redeploy.

## Settings (`wrangler.jsonc` → `vars`)

| Variable | Default | Meaning |
|---|---|---|
| `MODEL` | `@cf/qwen/qwen3.8-27b` | Workers AI model. If you change it, also change the two rates. |
| `ACCOUNT_PLAN` | `free` | Must be `free`: your declaration that the account is on Workers Free. |
| `GLOBAL_DAILY_NEURONS` | `9000` | The whole service's daily cap (at most 9,500). |
| `INSTALL_DAILY_NEURONS`, `NETWORK_DAILY_NEURONS` | `900`, `2700` | Daily allowance per installation and per network. |
| `INSTALL_PER_MINUTE`, `NETWORK_PER_MINUTE` | `6`, `20` | Accepted requests a minute. |
| `INSTALL_CONCURRENT`, `NETWORK_CONCURRENT`, `GLOBAL_CONCURRENT` | `1`, `4`, `12` | Answers in progress at once. |
| `TYPICAL_NEURONS_PER_ANSWER` | `90` | Only for "about N answers left". |
| `MAX_INPUT_TOKENS` | `12000` | Largest accepted request, estimated. |
| `INPUT_NEURONS_PER_M`, `OUTPUT_NEURONS_PER_M` | `40909`, `290909` | Cloudflare's published rates for the model. |
| `REASONING_EFFORT`, `DISABLE_THINKING` | `low`, `true` | Keep hidden (billed) reasoning short. |
| `STRUCTURED` | `prompt` | `prompt` spells out the JSON schema in the instructions and streams. |
| `IMAGE_PATCH` | `28` | Patch size used to estimate image tokens. |

## API

| Request | Answer |
|---|---|
| `GET /v1/status` with `x-inkling-install: inst_…` | `{ model, paused, quota }`. No model call. `model` is `qwen3.8-27b` on an external provider. |
| `POST /v1/tutor` (`application/json`, `x-inkling-install`, `x-inkling-notice`) `{ task, turns }` | Server-sent events: `delta` `{ text }`…, then `done` `{ usage, neurons, unit, finishReason, quota }` or `error` (`neurons` is the cost in the ledger's `unit`: Neurons or µ$). A refusal before the model is JSON `{ error: { code, message, retryAfter, scope, quota } }`: 400 (no or bad installation ID, bad request), 413 (too large), 415 (not JSON), 429 (allowance, pace or one-at-a-time) or 503 (busy or paused). |
| `GET /admin/summary`, `POST /admin/pause` with `Authorization: Bearer <ADMIN_TOKEN>` | Operator only; 404 without the token. |

## Tests

From the repository root: `npm test` (`tests/unit/beta.test.ts`: ledger, limits, the HTTP API in front of a fake model, the app against it), `npm run test:e2e:cloud` (the real Electron app against this server code), `npm run test:live:cloud` (the real model; see the top of `tests/live/cloud.live.test.ts`), and `node scripts/abuse-check.mjs security <url>` against a deployment.
