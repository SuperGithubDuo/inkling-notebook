# Workers AI model benchmark, 4 Nov 2026

Inkling's 13 live tutor scenarios (50 checks, `tests/live/scenarios.ts`) run on
real Workers AI through the AI server's code (direct mode, nothing deployed).
Workflow: `.github/workflows/workers-ai-bench.yml`; runs 41852988392,
41855358575, 41857278838.

| Model | Runs | Checks | Handwriting (38) | Text (12) | Neurons/run | Blended N/interaction | Median/max total |
|---|---|---|---|---|---|---|---|
| @cf/qwen/qwen3.8-27b (production) | 1 | 50 | 38 | 12 | 1,018 | 80 | 4.0 s / 81.4 s |
| @cf/google/gemma-4-26b-a4b-it | 3 | 49, 47, 49 | 37, 35, 37 | 12, 12, 12 | 125, 124, 128 | 10 | 2.8 s / 9.5 s |
| @cf/meta/llama-4-scout-17b-16e-instruct | 1 | 46 | 36 | 10 | 544 | 44 | 7.5 s / 10.8 s |
| @cf/zai-org/glm-5.3-flash | 1 | 0 | – | – | 0 | – | refused: error 5035, not on Workers Free |

Cloudflare's analytics matched the server's Neuron counts within 0.5 N for every model.

Gemma's recurring faults on handwriting (all three runs): did not read the "F"
label in the free-body diagram (the check passes on the student's word "pushed");
named the sign mistake but never gave x = −2, −3; 2 of 6 mistake markups had a
mark on the wrong line or no correction. Text-only tasks: 36/36 checks.

Scout: mistake marks on the wrong line in both markups (0–120 scale instead of
0–1000), long step lists, kinematics answer format failed; only ~2× cheaper.

Mean Neurons per request: image chat Qwen 66.2 / Gemma 8.6; markup 123.5 / 15.6;
text chat 64.0 / 8.0; typed check 31.4 / 4.6; practice 125.5 / 11.5.

Routing rule "any image → Qwen, otherwise Gemma", 60/25/10/5 chat/markup/check/practice
mix, 9,000-Neuron cap: 125 (all chats with images) to 245 (none) answers a day,
146 at this benchmark's 5-of-7 share, vs 113 on Qwen alone.

Recommendation: GO for that rule only; NO-GO for Gemma or Scout on images.
