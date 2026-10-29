# Inkling AI beta server

A small Cloudflare Worker that gives beta testers the AI Tutor with nothing to download. It answers with **Workers AI** (`@cf/qwen/qwen3.8-27b`, a vision model) on Cloudflare's **free** allowance. Each tester has a personal access code and a daily allowance, and the server never lets the beta use more than the free tier.

```
Inkling app ──HTTPS──▶ Worker (this folder) ──AI binding──▶ Workers AI (Qwen 3.8 27B)
 access code            checks the code, reserves              10,000 free Neurons/day
 (tester's own)         allowance, adds instructions           per account
                                 │
                                 ▼
                        Durable Object "ledger"
                        testers, daily usage, reservations
```

## What keeps it free

| Layer | Behaviour |
|---|---|
| Cloudflare account on the **Workers Free** plan | Workers AI gives every account 10,000 Neurons a day, reset at 00:00 UTC. On the Free plan, usage beyond that **fails with an error (4006) instead of being billed**. This is the guarantee, so keep the account on the Free plan. On Workers Paid the same traffic would be billed, so the Worker refuses to serve unless `ACCOUNT_PLAN` is `"free"`. |
| Global cap (`GLOBAL_DAILY_NEURONS`, default 9,000) | The ledger stops the beta before Cloudflare's limit, with headroom for estimation error. It can't be set above 9,500. |
| Tester allowance (`TESTER_DAILY_NEURONS`, default 900) | This is per access code, per UTC day. It can be changed per tester. |
| Reservations | Before each request, the worst case is reserved against the global cap: the estimated input plus the full output cap. The real cost (the model's token counts × Cloudflare's published rates) then replaces it. If the real cost is unknown, for example after a stopped answer, the reservation stays charged. |
| Pacing | One answer at a time per tester, and 6 requests a minute. |
| Fixed instructions | The app sends only a task and the conversation. The server applies Inkling's own instructions, output format and token caps (`src/main/ai/prompts.ts`), so an access code can't be used as a general free LLM API. |

Neurons are Cloudflare's usage unit. For this model, Cloudflare's price list gives 40,909 Neurons per million input tokens and 290,909 per million output tokens. Output, including any hidden reasoning, is about 7× the price of input. For that reason the server sends `reasoning_effort: "low"` and `enable_thinking: false`, and caps output per task.

**No API token anywhere.** The Worker reaches Workers AI through its `AI` binding. The app holds only the tester's access code. The server stores just the SHA-256 of each code. The code is shown once, when it is created.

**What is kept.** The Worker keeps only per-tester usage counts. Cloudflare says Workers AI does not train on customer content and does not retain inputs or outputs of ordinary inference ([data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)). Per-request invocation logs are off; the Worker itself logs only error kinds, never request content.

## Deploy

You need a Cloudflare account on the Workers **Free** plan.

```bash
cd beta-server
npm ci
npx wrangler login                          # once
npx wrangler secret put ADMIN_TOKEN         # paste a long random string (≥ 32 chars), e.g. from: openssl rand -base64 36
npx wrangler deploy                         # prints https://inkling-ai-beta.<your-subdomain>.workers.dev
```

Build the beta app with that address built in. Testers then only paste their access code:

```bash
MAIN_VITE_INKLING_BETA_URL=https://inkling-ai-beta.<your-subdomain>.workers.dev npm run build
```

A build without it still offers the cloud beta in Settings → AI Tutor, where the tester enters the server address. Ollama stays the default provider in such a build.

## Manage testers

```bash
export INKLING_BETA_URL=https://inkling-ai-beta.<your-subdomain>.workers.dev
export INKLING_ADMIN_TOKEN=…                # the ADMIN_TOKEN secret

npm run admin -- add "Ada (class 10B)"      # prints the access code once
npm run admin -- add "Bo" --neurons 600     # a smaller allowance
npm run admin -- list                       # testers and today's use
npm run admin -- summary                    # the whole beta today
npm run admin -- revoke t_abc123            # or: restore t_abc123
npm run admin -- limit t_abc123 1200
npm run admin -- pause                      # stop all AI answers now; `resume` to restart
```

## Settings (`wrangler.jsonc` → `vars`)

| Variable | Default | Meaning |
|---|---|---|
| `MODEL` | `@cf/qwen/qwen3.8-27b` | Workers AI model. If you change it, also change the two rates below to that model's published Neuron rates. |
| `ACCOUNT_PLAN` | `free` | Must be `free`, which is your declaration that the account is on Workers Free. |
| `GLOBAL_DAILY_NEURONS` | `9000` | The beta's daily cap (at most 9,500). |
| `TESTER_DAILY_NEURONS` | `900` | Default allowance for new testers. |
| `PER_MINUTE` | `6` | Requests per tester per minute. |
| `TYPICAL_NEURONS_PER_ANSWER` | `150` | Used only to tell testers roughly how many answers they have left. |
| `INPUT_NEURONS_PER_M`, `OUTPUT_NEURONS_PER_M` | `40909`, `290909` | Cloudflare's published rates for the model. |
| `REASONING_EFFORT` | `low` | Sent as `reasoning_effort`. Empty means not sent. |
| `DISABLE_THINKING` | `true` | Sends `chat_template_kwargs.enable_thinking = false`. |
| `STRUCTURED` | `prompt` | `prompt` spells out the JSON schema in the instructions, and answers stream. `json_schema` uses Workers AI JSON mode, which doesn't stream and isn't listed as supported for this model. |
| `IMAGE_PATCH` | `28` | Pixel patch size used to estimate image tokens before a request. |

## API

| Request | Answer |
|---|---|
| `GET /v1/status` with `Authorization: Bearer ink_…` | `{ tester, model, paused, quota }`. No model call. |
| `POST /v1/tutor` `{ task, turns }` | Server-sent events: `delta` `{ text }`…, then `done` `{ usage, neurons, finishReason, quota }` or `error` `{ code, message }`. A refusal before the model is plain JSON `{ error: { code, message, retryAfter, scope } }` with status 401, 413, 429 or 503. |
| `/admin/*` with `Authorization: Bearer <ADMIN_TOKEN>` | Testers, summary, pause. Without the secret these return 404. |

The request schema is Inkling's own (`src/shared/ai.ts`): at most 2 images (JPEG or PNG, ≤ 1 MB each) and 60,000 characters of text.

## Tests

From the repository root:

- `npm test` runs `tests/unit/beta.test.ts`, which covers the ledger, cost estimates, the HTTP API in front of a fake Workers AI, and the app against it.
- `npm run test:e2e:cloud` drives the real Electron app against this server code with a fake model.
- `npm run test:live:cloud` runs the real model. See the top of `tests/live/cloud.live.test.ts`. It can run against the deployed Worker, or run this server code locally against Workers AI's REST API without deploying.
