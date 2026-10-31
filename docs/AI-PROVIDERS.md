# AI Tutor providers

How the tutor gets its answers, what each option sends where, and what has been measured. For the terms and the hosted-AI plan see [AI.md](AI.md); for running the server see [beta-server/README.md](../beta-server/README.md).

> **Release builds** offer *Inkling AI (cloud)* and *Ollama (local)*. Google Gemini is only available in development builds made with `MAIN_VITE_INKLING_ENABLE_GEMINI=1`; it is not offered in published installers while its adults-only terms are reviewed for an all-ages app.

## Providers

The tutor answers through one of three providers, chosen in Settings → AI Tutor. All use the same instructions, structured-output schemas, validation and canvas commands; only the transport differs (`src/main/ai/cloud.ts`, `src/main/ai/ollama.ts`, `src/main/ai/gemini.ts`).

### Inkling AI (cloud; the default in release builds)

Free for everyone who installs Inkling, with nothing to set up: no account, access code, API key or download. Answers come from **Qwen 3.8 27B** (`@cf/qwen/qwen3.8-27b`, Apache-2.0, with vision) on Cloudflare Workers AI, through Inkling's own small server (a Cloudflare Worker in [`beta-server/`](../beta-server/README.md)), whose address is built into release installers.

**Set up.** None. Install, open, and ask. The first time you ask, Inkling asks permission to send what you ask about to its AI server.

**It's free, and limited.** Cloudflare gives each account 10,000 *Neurons* a day of Workers AI, reset at midnight UTC. On its Workers Free plan, usage beyond that is refused, never billed. The server shares it out:
- about 10 typical answers a day per installation (900 Neurons), 2,700 Neurons per internet connection (a school or office shares this), and 9,000 Neurons for everyone together;
- one answer at a time per installation, a few a minute.

The panel shows roughly how many answers are left, using the server's own count: it updates after every answer (chat, markup, practice and checks), after a stopped answer, and again after the midnight UTC reset. The app never estimates or counts down by itself. When an allowance runs out, the tutor says so plainly, notebooks work as usual, and it offers a one-click switch to the local Ollama tutor. Inkling never switches by itself and never moves to paid usage.

**What is sent and kept.** Your question, and an image of your selection or the page's typed/PDF text plus an image of its handwriting. The app sends only the task and the conversation; the server adds Inkling's instructions and limits, so it can't be used as a general AI service. Neither Inkling's server nor Cloudflare keeps the content ([Cloudflare's data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)). To enforce the limits, the server counts usage per installation (a random ID the app creates) and per network address, stored only as hashes with a salt that changes daily and deleted at the end of each UTC day. There is no credential in the app, and no Cloudflare API token anywhere: the server reaches Workers AI through its built-in binding.

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
2. Open Settings → AI Tutor, choose **Google Gemini**, paste the key and press Save. Inkling runs a connection test: it lists the models your key can use and sends one tiny request. No notebook content is sent.
3. Choose a model: **Gemini 3.8 Flash** (default, best quality) or **Gemini 3.5 Flash-Lite** (lighter, more generous free limits). Models your key can't use are flagged.
4. The first time you ask something, Inkling asks you to confirm you are 18 or older and agree to send notebook content to Google.

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
Measured with real models in Ollama 0.40.13 on a slow machine (2 CPU cores, 8 GB RAM, no GPU); full answers, timings and screenshots in [`docs/live-results/`](live-results/README.md).

- **Qwen3-VL 4B instruct** read every handwriting scenario correctly: it found the sign mistake in x² + 5x + 6 = 0 (roots −2, −3) and put a ✗ and the correction on the right line, recognised correct work, named all four forces in a free-body diagram, and answered from a note and a PDF. In the app, the whole workflow worked: streamed answer, previewed proposal, approval, editable AI objects, undo/redo.
- **Qwen3-VL 2B instruct** was right in every chat answer except missing the weight in the diagram, and completed the app workflow, but its own markups were less reliable: once it marked the wrong work as correct.
- All structured answers validated. On this machine the first words of an answer about an image took 75–145 s; text-only questions 3–7 s.
- **Memory:** 4B peaks at about 5.5 GB and was killed by the OS four times in testing (out of about 30 requests) when other programs, or the app itself, also needed memory; the app explained it and left the page unchanged. Use 2B on 8 GB computers.
<!-- /local-model-results -->

### Cloud beta results

<!-- cloud-beta-results -->
Measured on 30 Oct 2026 against the deployed server and the real model. Details: [`docs/live-results/cloud-qwen3.8-27b.md`](live-results/cloud-qwen3.8-27b.md).

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
