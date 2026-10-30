# Live results: cloud beta on Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`)

Run on 30 Oct 2026, 03:45–03:48 UTC, by `.github/workflows/beta-server.yml` (commit `e73ac5a`):
- against the **deployed** beta server `https://inkling-ai-beta.shenjonas9.workers.dev`
- through Inkling's own AI service and cloud provider, with the handwriting images the app sends (`tests/fixtures/handwriting/`)
- server settings: `reasoning_effort: low`, `enable_thinking: false`, schema in the instructions (no JSON mode)

The full answers are in the run's `live-cloud-report` artifact.

## Correctness: 13 of 13 answers, 50 of 50 checks

| Scenario | What was checked | Result |
|---|---|---|
| **A** x² + 5x + 6 = 0 → (x + 2)(x + 3) = 0 → x = 2, 3 (sign mistake), chat | read the factorisation; gives roots −2 and −3; says x = 2, 3 is wrong; streamed | 5/5 |
| A, *Mark up my selection* | transcribed all 3 lines; marks a mistake; the ✗/correction is on the last line; correction gives −2, −3; summary says there's a mistake; marks become valid canvas commands | 9/9 |
| A, *Show this on my page* (with the chat answer) | same 9 checks | 9/9 |
| **B** 2x + 3 = 11 → 2x = 8 → x = 4 (correct), chat | read the work; says it's correct | 3/3 |
| B, markup | uses a ✓; no ✗ on correct work; doesn't claim a mistake | 4/4 |
| **C** free-body diagram (W, N, F, f) | weight, normal, applied force, friction | 5/5 |
| **D** question about a typed note | stroma; oxygen | 3/3 |
| **E** PDF exercise (car accelerating at 2.5 m/s² for 8 s) | 20 m/s; 80 m | 3/3 |
| **P** practice set + answer checking | valid structured set; 2 problems with hints; right answer judged correct; wrong answer judged not correct | 6/6 |
| **F** follow-up question | answers; explains using the factors being zero | 3/3 |

All structured answers (markups, the practice set, answer checks) passed Inkling's schema validation at the first attempt, without JSON mode.

## Speed (from the GitHub runner, through the deployed server)

| Interaction | First text | Complete |
|---|---|---|
| Chat about handwriting | 0.5 s (**16.7 s on the first request**: model warm-up) | 2.3–21 s; typically 2–5 s |
| Chat about typed text/PDF | 0.4–1.5 s | 2.4–9.8 s |
| Markup (structured) | 0.5–0.6 s | 6.4–7.7 s |
| Practice set (2 problems) | 0.4 s | 15.3 s |
| Answer check | 0.3–0.4 s | 1.4–1.8 s |

## Neurons: Cloudflare's count matches the server's

| | Requests | Neurons |
|---|---|---|
| Server ledger (13 answers; tokens × published rates) | 13 | 1,033 |
| Settings probe (4 direct requests) | 4 | 136.6 |
| **Sum** | 17 | **1,169.6** |
| **Cloudflare GraphQL Analytics** (`aiInferenceAdaptiveGroups.sum.totalNeurons`, same window) | 17 | **1,169.7** |

The server's accounting matches Cloudflare's own count to within 0.1 Neuron, so the daily caps are enforced against the real numbers.

| Interaction | Tokens in → out | Neurons (mean) |
|---|---|---|
| Chat (handwriting or text) | 361–924 → 66–274 | 70 |
| Markup | 840–1,218 → 268–286 | 123 |
| Answer check | 368–372 → 49–66 | 32 |
| Practice set (2 problems) | 365 → 322 | 109 |
| **Blended** (60% chat, 25% markup, 10% check, 5% practice) | | **82** |

**Capacity on the free allowance:**
- **About 110 interactions a day** for the whole beta under the server's 9,000-Neuron cap; 122 on Cloudflare's full 10,000.
- About **11 per tester per day** at the 900-Neuron default allowance, so about 10 testers can use their full allowance on the same day.

The earlier estimate was 120 Neurons per interaction and about 75 a day.

## Settings probe (one small answer-check request each)

| Settings | Output tokens | Hidden reasoning | Valid JSON | Neurons | Time |
|---|---|---|---|---|---|
| Model defaults (reasoning `xhigh`) | 104 | 233 chars | yes | 46.7 | 2.4 s |
| `reasoning_effort: low` | 62 | 69 chars | yes | 33.9 | 1.6 s |
| low + `enable_thinking: false` (**used**) | 45 | none | yes | 28.0 | 1.1 s |
| low + no thinking + JSON mode | 45 | none | yes | 28.0 | 1.2 s |

Turning thinking off removes the hidden reasoning, about 40% of the cost of a short answer, with no loss on these checks. JSON mode worked on this request, although Cloudflare doesn't list the model for it. Inkling keeps the schema in the instructions instead, so answers can stream.

## Account

- Subscriptions before and after the run: **none, so free plans only (Workers Free)**.
- Cloudflare-counted Neurons for the day after the run: 1,170 of 10,000.
- The temporary test access code was revoked at the end of the run. No other codes exist.
