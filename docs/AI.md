# The AI Tutor

Inkling's tutor reads handwriting from an image of what the student selected. It answers in chat, makes practice sets and checks answers, and proposes corrections on the page. A correction is drawn on the page only after the student approves it.

This page covers how the tutor gets its answers, what each provider sends where, what has been measured, the guarantees the app makes, and the providers' terms. Running the server is in [beta-server/README.md](../beta-server/README.md).

> **Release builds** offer *Inkling AI (cloud)* and *Ollama (local)*. Google Gemini is only available in development builds made with `MAIN_VITE_INKLING_ENABLE_GEMINI=1`; it is not offered in published installers while its adults-only terms are reviewed for an all-ages app.

## Providers

The tutor answers through one of three providers, chosen in Settings → AI Tutor. All use the same instructions, structured-output schemas, validation and canvas commands; only the transport differs (`src/main/ai/cloud.ts`, `src/main/ai/ollama.ts`, `src/main/ai/gemini.ts`).

### Inkling AI (cloud; the default in release builds)

Free for everyone who installs Inkling, with nothing to set up: no account, access code, API key or download. Answers come from **Qwen 3.8 27B** (`@cf/qwen/qwen3.8-27b`, Apache-2.0, with vision) on Cloudflare Workers AI, through Inkling's own small server (a Cloudflare Worker in [`beta-server/`](../beta-server/README.md)), whose address is built into release installers.

**Set up.** None. Install, open, and ask. The first time you ask, Inkling asks permission to send what you ask about to its AI server.

**It's free, and limited.** Cloudflare gives each account 10,000 *Neurons* a day of Workers AI (measured to behave as a rolling 24-hour window, not a midnight-UTC reset). On its Workers Free plan, usage beyond that is refused, never billed. The server shares it out:
- about 10 typical answers a day per installation (900 Neurons), 2,700 Neurons per internet connection (a school or office shares this), and 9,000 Neurons for everyone together in any rolling 24 hours (about 110 typical answers);
- one answer at a time per installation, a few a minute.

The panel shows roughly how many answers are left, using the server's own count: it updates after every answer (chat, markup, practice and checks), after a stopped answer, and again after the midnight UTC reset. The app never estimates or counts down by itself. When an allowance runs out, the tutor says so plainly, notebooks work as usual, and it offers a one-click switch to the local Ollama tutor. Inkling never switches by itself and never moves to paid usage.

**What is sent and kept.** Nothing at all, not even the allowance check, before you allow it in the permission dialog, which lists what is sent (`CLOUD_SENT` in `src/shared/ai.ts`). Then: your question; an image of your selection, or the page's title, typed/PDF text and an image of its handwriting; and the recent conversation on that page (up to 5 earlier exchanges and the most recent earlier image; messages answered by another provider are left out). The app sends only the task and the conversation; the server adds Inkling's instructions and limits, so it can't be used as a general AI service. Inkling's server doesn't keep or log the content, and Cloudflare states that it doesn't either ([Cloudflare's data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)). To enforce the limits, the server counts usage per installation (a random ID the app creates) and per network address, stored only as hashes with a salt that changes daily; the salt and counts are replaced with the first request after 00:00 UTC. There is no credential in the app, and no Cloudflare API token anywhere: the server reaches Workers AI through its built-in binding.

Running the server (deploying, limits, emergency pause) is described in [`beta-server/README.md`](../beta-server/README.md).

### Local: Ollama (default in development builds)

A vision model runs on your own computer through [Ollama](https://ollama.com). It's free, needs no account or key, has no usage limits, and nothing leaves the computer: Inkling only talks to Ollama on `127.0.0.1:11434` and refuses any other address.

**Set up.**
1. Install Ollama from [ollama.com/download](https://ollama.com/download) and open it.
2. Install a vision model in a terminal (a one-time download):

   | Model | Command | Download | Use |
   |---|---|---|---|
   | Qwen3-VL 4B (recommended) | `ollama pull qwen3-vl:4b-instruct` | 3.3 GB | needs ~5.5 GB free memory: 16 GB computers, or 8 GB with little else open |
   | Qwen3-VL 2B | `ollama pull qwen3-vl:2b-instruct` | 1.9 GB | 8 GB computers; faster, less reliable markups |
   | Qwen3-VL 8B | `ollama pull qwen3-vl:8b-instruct` | 6.2 GB | most capable; ~16 GB RAM or a GPU with 8 GB |

   Use the `-instruct` builds. The plain tags (`qwen3-vl:4b`, `:2b`, `:8b`) are Qwen3-VL's *thinking* builds: they write a long chain of reasoning before every answer, and Ollama (0.40) doesn't let Inkling switch that off. On a 2-core CPU test machine, with the same image and question, the 2B thinking build took 338 s to reach a correct answer (about 900 reasoning tokens first); the 2B instruct build gave a correct answer in 104 s. They still work if installed (listed as "thinking", with extra token budget for the reasoning), just slowly.

3. Settings → AI Tutor shows whether Ollama is running, which models are installed (other installed vision models are listed too; text-only models are not), the command for a model you picked but haven't installed, and a connection test that loads the model. Inkling never downloads models or installs software itself.

Answers take longer than with a cloud model, especially the first one while the model loads into memory, and depend on your hardware. Inkling asks thinking builds not to reason at length (and leaves them room when they do), shows how long an answer has been running, gives a model up to 4 minutes to load and start answering, and suggests the 2B model if a larger one runs out of memory or is too slow. Qwen3-VL marks up work with boxes in its own format (`[x1, y1, x2, y2]` on 0–1000), which Inkling converts before validating.

### Optional: Google Gemini (18+ only; development builds only)

Google's Gemini API terms require users to be 18 or older and don't allow it in apps likely to be used by under-18s, so Inkling, a student notebook, does not rely on it: it is off unless chosen, marked 18+, and its consent asks you to confirm your age. It runs through the official Gen AI SDK (`@google/genai`) and is designed to cost nothing within Gemini's free tier.

**Set up.**
1. Create a free API key in [Google AI Studio](https://aistudio.google.com/apikey). No billing is needed. To be sure you stay free, use a key from a Google Cloud project **without billing enabled**: Inkling can't see your project's billing, and Google charges for any project that has it.
2. Open Settings → AI Tutor, choose **Google Gemini**, paste the key and press Save. Inkling first asks you to confirm you are 18 or older and agree to send notebook content to Google; nothing, not even the key check, reaches Google before that. Then it runs a connection test: it lists the models your key can use and sends one tiny request. No notebook content is sent.
3. Choose a model: **Gemini 3.8 Flash** (default, best quality) or **Gemini 3.5 Flash-Lite** (lighter, more generous free limits). Models your key can't use are flagged.
4. If you declined in step 2, Inkling asks again the first time you test the key or ask something.

### Privacy, Gemini limits and keys

**Privacy.** With Ollama, nothing leaves your computer. On Gemini's free tier, Google may use what you send, and its answers, to improve its products, and human reviewers may read them ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). Don't send sensitive, confidential or personal information. Google requires API users to be 18 or older. Inkling sends only what you ask about: your question, and either a cropped image of the selected area or the current page's typed/PDF text plus an image of just its handwritten part. Nothing is sent before you agree and ask. You can withdraw permission in Settings.

**Free-tier protection (Gemini).**
- Only free-tier models are offered. Inkling never switches model or tier on its own. When a model's daily quota runs out, it says so (quotas reset at midnight Pacific) and offers a one-click switch to the other free model.
- One request at a time, at most 8 per minute, and an accidental repeat of the same request within 10 seconds is refused. After a rate-limit or quota error, Inkling waits locally instead of retrying against the API.
- Images are cropped to the relevant area and sent as JPEG, at most 1024 px on the long edge. Conversations keep only the last five exchanges, with earlier answers shortened and at most one earlier image.
- Clear messages for an invalid key, rate limits, exhausted daily quota, models without free quota, unavailable models, network problems and blocked answers.

**Key storage (Gemini).** The key lives only in the main process, encrypted with the operating system's keychain (Electron `safeStorage`) in the app's config folder (`gemini-key.bin`, next to `ai-settings.json`), never in your notebooks. The interface only ever sees its last four characters. On Linux without a keyring the key is saved with weak protection, and Settings says so. Where nothing can encrypt, it is kept in memory for the session only.

**Providers.** `src/main/ai/provider.ts` defines the small interface the tutor needs (`listModels`, `stream` with text and image parts and optional JSON-schema output). `src/main/ai/cloud.ts`, `src/main/ai/ollama.ts` and `src/main/ai/gemini.ts` implement it; `src/main/ai/service.ts` applies consent, pacing and validation per provider. OpenRouter or Anthropic Claude can be added the same way without changing the tutor or the UI.

### Local model results

<!-- local-model-results -->
Measured with real models in Ollama 0.40.13 on a slow machine (2 CPU cores, 8 GB RAM, no GPU); full answers, timings and screenshots in [`docs/archive/live-results/`](archive/live-results/README.md).

- **Qwen3-VL 4B instruct** read every handwriting scenario correctly: it found the sign mistake in x² + 5x + 6 = 0 (roots −2, −3) and put a ✗ and the correction on the right line, recognised correct work, named all four forces in a free-body diagram, and answered from a note and a PDF. In the app, the whole workflow worked: streamed answer, previewed proposal, approval, editable AI objects, undo/redo.
- **Qwen3-VL 2B instruct** was right in every chat answer except missing the weight in the diagram, and completed the app workflow, but its own markups were less reliable: once it marked the wrong work as correct.
- All structured answers validated. On this machine the first words of an answer about an image took 75–145 s; text-only questions 3–7 s.
- **Memory:** 4B peaks at about 5.5 GB and was killed by the OS four times in testing (out of about 30 requests) when other programs, or the app itself, also needed memory; the app explained it and left the page unchanged. Use 2B on 8 GB computers.
<!-- /local-model-results -->

### Cloud beta results

<!-- cloud-beta-results -->
Measured on 30 Oct 2026 against the deployed server and the real model. Details: [`docs/archive/live-results/cloud-qwen3.8-27b.md`](archive/live-results/cloud-qwen3.8-27b.md).

- **Correctness: 13 of 13 answers, 50 of 50 checks.**
  - Read all three handwritten lines of the algebra mistake, found it (roots −2 and −3), and put the ✗ and correction on the right line.
  - Recognised correct work without crossing anything out.
  - Named all four forces in the free-body diagram.
  - Answered from a note and a PDF (20 m/s, 80 m).
  - Generated and checked practice problems.
  - Every structured answer validated the first time.
- **Speed:** first words in about 0.5 s (16.7 s on the very first request while the model warmed up). Answers complete in 2–10 s; a markup takes about 7 s, a two-problem practice set about 15 s.
- **Cost:** a typical interaction uses **about 82 Neurons**:
  - chat 70
  - markup 123
  - answer check 32
  - practice set 109

  The server's own count matched Cloudflare's to within 0.1 Neuron.
- **Capacity on the free allowance:** about **110 interactions a day** for everyone together (9,000-Neuron cap), about 10 per installation.
<!-- /cloud-beta-results -->

## Guarantees in the app (verified by automated tests)

| Guarantee | Where | Tests |
|---|---|---|
| No request of any kind (question, status, model list or connection check) reaches a cloud provider before the user agrees to its current notice; the cloud AI and Gemini each have their own consent, and switching provider never grants it. Declining sends nothing. Agreement to an older notice no longer counts. | `src/main/ai/service.ts` (`mayContact`), `src/renderer/src/ai/client.ts`, `AiSettings.tsx` | `tests/unit/consent.test.ts`, `ai.test.ts`, `beta.test.ts`, e2e `phase4`, `cloud` |
| The permission notice lists what is actually sent: question, included context, recent conversation, task fields, and (cloud AI only) the installation ID and IP address. Changing its wording requires a new consent version. Tutor history goes only to the provider that answered it. | `src/shared/ai.ts` (`CLOUD_SENT`, `GEMINI_SENT`), `ConsentDialog.tsx`, `turns.ts` (`historyFor`) | `tests/unit/consent.test.ts`, e2e `cloud`, `phase4` |
| AI marks are previewed. Nothing reaches the page before *Add to my page*, and adding is one undoable step. AI objects can't modify the user's own ink. | `src/renderer/src/ai/annotate.ts`, `canvas/commands.ts` | e2e `phase4`, `ollama`, `cloud` |
| No credential in the app. The cloud AI is anonymous: the app sends only a random installation ID. The server reaches Workers AI through a binding, so no API token exists anywhere. Gemini uses the user's own key, encrypted with the OS keychain. | `src/main/ai/config.ts`, `beta-server/` | `beta.test.ts`, `scripts/abuse-check.mjs` |
| The cloud server is not a general AI proxy: fixed tasks, server-owned prompts and caps, no CORS, JSON only, size limits; daily limits per installation, per network and overall, enforced atomically. | `beta-server/` | `beta.test.ts`; security and limit checks against the deployed server in `beta-server.yml` |
| Clear errors for an invalid key, rate limits, daily allowance used up, unavailable model, network failure, bad answers. Inkling never retries in a loop and never switches provider or model on its own. | `service.ts`, providers | unit and e2e |
| The notebook works fully with AI off or unavailable. | | e2e `phase1`–`phase3`, `release` (no AI configured) |

## Providers and their terms (reviewed 29 Oct 2026)

| | Inkling AI (cloud) | Ollama (local) | Google Gemini (own key) |
|---|---|---|---|
| Model | Qwen 3.8 27B on Cloudflare Workers AI (Apache-2.0 weights) | Qwen3-VL 2B/4B/8B (Apache-2.0) | Gemini 3.8 Flash / 3.5 Flash-Lite |
| User setup | None | Install Ollama and a 2–6 GB model | Create a Google API key |
| Age | Cloudflare's agreement sets no minimum age and has no rule on services for children. As the operator, Inkling is responsible for its users (e.g. COPPA: parental consent for under-13s). | None (nothing leaves the computer) | **18+ only.** Not allowed in apps aimed at, or likely to be used by, minors |
| Data use | Cloudflare doesn't train on Workers AI content and keeps no inputs or outputs of standard inference. Inkling's server keeps only anonymous daily usage counts. | Stays on the computer | **Free tier:** Google uses inputs and outputs to improve its products, and human reviewers may read them. Paid tier: not used for training. |
| Commercial use | Allowed. Cloudflare holds the customer responsible for outputs and for its end users. | Allowed (Apache-2.0) | The Gemini API is meant for developers building for business purposes, not for consumer use. Apps offered to users in the EEA, Switzerland or the UK must use **paid** services. |
| Cost to Inkling | Free within 10,000 Neurons a day for the whole account (measured: about 110 typical interactions at 82 Neurons each, under the server's 9,000 cap). Beyond that, $0.011 per 1,000 Neurons on Workers Paid. | None | None (the user's own key) |
| Fit for a student product | **Yes**, with Inkling's own privacy notice and age policy | **Yes** | **No** as a default. Kept only as an opt-in for adults bringing their own key. |

**Current choice:** don't build on Gemini's free tier.
- Release builds have the AI server built in, and it is the default.
- Otherwise the default is Ollama, and the notebook is complete without AI.
- Gemini stays available, off by default and marked 18+.

The legal points above are a product review, not legal advice. Have counsel confirm the age policy and the privacy notice before a public launch to schools or under-18s.

## Hosted AI: from beta to product

The cloud AI server (`beta-server/`, see its README) is a deliberately small version of the long-term architecture:

```
Inkling app ──HTTPS──▶ Inkling API (Cloudflare Worker)
  install ID / later    ├─ identify (anonymous install ID + network → later a signed licence)
  a signed licence      ├─ allowance per installation, network and overall
                        ├─ ledger (Durable Object): reserve → settle
                        ├─ server-owned prompts, schemas, token caps
                        └─ model call (Workers AI binding; any provider behind it)
```

Deployed on 30 Oct 2026 at `https://inkling-ai-beta.shenjonas9.workers.dev` (Workers Free) and tested against the real model: 50/50 checks, 82 Neurons per typical interaction ([results](archive/live-results/cloud-qwen3.8-27b.md)). Steps:
1. **Public beta (now).** Anyone may use it anonymously on a Cloudflare account on the Workers Free plan. The free allowance supports about 110 interactions a day in total, roughly 10 per installation.
2. **More users.** Move the account to Workers Paid with the server's global cap raised deliberately. At about 82 Neurons an interaction, $1 buys roughly 1,100 interactions. Keep the per-installation allowance, and set a billing alert in Cloudflare.
3. **Product.** Add sign-in and a signed licence (see the [editions plan](archive/MONETIZATION.md)). The ledger's per-user allowance comes from the entitlement: a small free allowance, more for Pro.

Each step changes only the server and the entitlement source; the app's provider interface stays as it is.
