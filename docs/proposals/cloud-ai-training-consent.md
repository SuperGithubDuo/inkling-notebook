# Proposal: opt-in "Cloud AI (free, may train)" disclosure

*Status: PROPOSAL, not shipped. The app's current notice (`CLOUD_CONSENT_VERSION` 4) and PrivacyContent are unchanged. Written 4 Nov 2026 for the OpenRouter free-model evaluation (docs/AI-PROVIDERS.md).*

## Why it is needed

Every OpenRouter free model that actually answered in testing is hosted by NVIDIA, whose terms let it **store prompts for 30 days and use them to improve its AI models**. The shipped notice says the AI host does not keep what is sent, so no shipped app may reach such a host. The server enforces this: with `ALLOW_PROVIDER_DATA_COLLECTION=true` it requires `TRAINING_NOTICE_VERSION`, and refuses any app whose accepted notice is older.

**A notice cannot override a provider's terms.** Consent covers privacy; it does not lift a provider's own limits on who may use its service or for what (NVIDIA's API Trial terms: internal testing and evaluation only; OpenRouter: account holder 18+, and we must make our users comply with each model's terms). Those must be satisfied separately before this notice is ever shown.

## Principles

1. **Separate and optional.** A second cloud choice, never bundled with the current Cloud AI permission, never required to use Inkling.
2. **Local AI needs no cloud consent** (already true: `AiService` treats Ollama as consented). The dialog offers it as the private alternative.
3. **Off by default, per computer account**, revocable in Settings; revoking takes effect on the next request.
4. **Says who, what, how long, and for what**, in plain words, before anything is sent.
5. **Adults only**, as the providers' terms require (see below); no "parental consent" checkbox in place of verified consent.
6. **Never silent.** The model and host answering are shown in the tutor panel; answers from this pool carry a small "free AI · may train" label.

## Draft dialog

**Title:** Use free AI that may learn from what you send?

**Body:**

> Inkling's standard Cloud AI keeps nothing you send. This *optional* free AI is different.
>
> When you ask it something, Inkling sends **{model name}**, run by **{host: NVIDIA}** through **OpenRouter**:
> - your question and the conversation so far;
> - the part of the page you selected, as an image, and any notes or PDF text you included.
>
> **{Host} may keep this for up to 30 days and use it, and the answers, to improve its AI models.** Others at {host} may see it. Don't include anything personal or private — names, contact details, health or family information, or other people's work.
>
> **Adults only.** These services are for people 18 or older. By turning this on you confirm you are 18 or older.
>
> Inkling never pays for this service and never switches you to a paid one. It has a small shared daily limit and may be unavailable.
>
> You can turn this off any time in Settings → AI. For AI that never leaves your computer, use **Local AI (Ollama)** — no permission needed.

**Buttons:** `Not now` (default focus) · `I'm 18 or older — turn on`

**Links:** {host} terms · OpenRouter terms · Inkling privacy notice

## What changes in code when (and only when) approved

- `src/shared/ai.ts`: a new `CLOUD_TRAINING_SENT` list and copy constants; a separate consent record `cloudTrainingConsent` (version, acceptedAt) in `AiConfig`, independent of `cloudConsent`.
- The app sends `x-inkling-notice: <training version>` **only** to the free-may-train server; the standard Cloud AI keeps notice 4.
- A separate Worker (not `inkling-ai-beta`) with `ALLOW_PROVIDER_DATA_COLLECTION=true`, `TRAINING_NOTICE_VERSION=<n>`, `UPSTREAM_PROVIDERS` pinned to the reviewed host, and the free model's quotas.
- PrivacyContent and docs/PRIVACY.md gain a section for it, reviewed with the provider's final terms.

## Blockers found (4 Nov 2026) — this notice must not ship while any holds

| Provider path | Blocker | Kind |
|---|---|---|
| NVIDIA free endpoints (Nemotron 3.5 Super VL, Lightning, 3 Nano Omni) | API Trial Terms §1.3–1.4: internal testing and evaluation only; production needs a paid subscription | **Use restriction** (consent can't fix it) |
| NVIDIA | Agreement accepted "only by an adult of legal age of majority"; no provision for minors | Age |
| Google AI Studio (Gemma 4 31B, 26B A4B) | Gemini API terms: 18+, and no services "likely to be accessed by individuals under 18" | **Age restriction** (consent can't fix it) |
| Google AI Studio free | Unpaid services: used to improve products, human review | Privacy (consent can address it, for adults) |
| OpenRouter | Account holder 18+; customer must make its users comply with each model's terms (§5.1–5.2) | Pass-through |
