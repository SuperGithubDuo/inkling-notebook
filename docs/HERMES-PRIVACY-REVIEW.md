# Inkling Beta2: independent privacy / all-ages / AI-safety review

Scope: static source review of `C:/Users/shenj/AppData/Local/hermes/cache/scratch/inkling-launch-review`, plus current primary-source retrieval. No app, model, network-capture, deployed Worker, account configuration, or release-artifact tests performed. No repository changes. Recommendations are risk assessment, not legal approval.

## Decision

**Do not describe the current cloud-enabled beta as cleared for all ages.** Preserve the all-ages notebook goal by separating offline notebook availability from eligibility for network AI. For the first 5–10 testers, prefer a genuinely restricted offline/local configuration, or explicitly recruit adult-only cloud testers while resolving the issues below. An adult pilot does not itself cure Gemini's app-level terms or establish that the wider product is not child-directed. No claim of COPPA/FERPA compliance is supported by this review.

## Prioritized findings and evidence

### P0 — Under-13 cloud authorization is only a user permission switch, not verifiable parental consent

`src/renderer/src/ai/ConsentDialog.tsx:88–124` has a generic Allow button without parent verification or school authorization. `src/main/ai/config.ts:39–52,219–221` stores only consent version/time, per installation, not a verified parent's authority, child scope, or verification evidence. Main-process checks at `service.ts:342–349` are valuable content gates but only check that boolean. On shared machines, one person's consent persists for another user.

For covered collection, the Rule requires VPC before collection/use/disclosure, and a method reasonably calculated to ensure the actor is the parent—not a checkbox or a child's claim of permission.[1] Free access, no accounts, transient processing and salted identifiers do not by themselves establish an exemption. Notebook content may contain names, identifiable records or photos; COPPA collection includes encouraging online submission.[2] Counsel must determine child-directed/mixed-audience/actual-knowledge status, appropriate age routing, narrow internal-operations exceptions for identifiers, and Cloudflare's processor/disclosure classification. Separate VPC for non-integral third-party disclosure is required where applicable; do not categorically treat every processor transfer as requiring a second opt-in.[1]

**Launch condition:** block under-13 cloud use pending a documented legal basis and operational notice/VPC or school-authorized process. Do not collect more children's information merely to build that process.

### P0 — Gemini 18+ click does not cure the all-ages app restriction

`src/shared/ai.ts:60–62` already quotes the app-level restriction; nevertheless Gemini remains selectable (`AiSettings.tsx:86`) and consent merely says “I'm 18 or older” (`ConsentDialog.tsx:54–80`). Google's effective March 23, 2026 terms prohibit API clients directed toward **or likely accessed by under-18s**, not merely underage API-key owners.[5] The same terms require paid services for API clients made available in EEA/Switzerland/UK and forbid sensitive/confidential/personal information on unpaid services.[5]

**Launch condition:** remove/disable Gemini in the all-ages distribution pending written provider clarification and counsel review; optional BYOK plus an 18+ label is not sufficient evidence of permission. Paid Gemini would not remove the under-18 app restriction.

### P0 — Published privacy essentials remain placeholders

`docs/PRIVACY.md:1–5,35–37,52` is expressly draft: operator identity/address/contact, children's policy and date are unresolved. Cloud consent links only Cloudflare's policy (`ConsentDialog.tsx:110–115`), not a completed Inkling operator notice/parent contact procedure. `docs/READINESS.md:56` loosely groups all under-18s together; distinguish COPPA under-13, teen privacy rules, and Gemini under-18 contractual restriction.

Covered operators need written security and retention programs, not only reassuring UI copy.[7][8] Establish actual operator/contact, parent/school request owner, access/deletion/revocation process, retention inventory, incident handling and provider commitments. Do not invent an entity or imply counsel approval. Cloudflare places necessary rights/permissions on its customer.[10]

### P1 — “Nothing sent until you ask” excludes pre-consent identifier traffic

`src/main/ai/service.ts:171–197` refreshes cloud status without checking cloud consent. `cloud.ts:56–68,161–163` sends status requests with the installation header; `beta-server/src/handler.ts:92–95,129–132` reads installation ID and Cloudflare's IP header. `src/main/index.ts:109–111` makes cloud default when a build URL exists. Thus notebook content is gated, but installation/network metadata can leave before Allow and after revocation. `PrivacyContent.tsx:22` says connections occur only for AI questions and updates, omitting quota/status traffic.

**Action:** distinguish content permission from metadata traffic; gate unnecessary requests and review any narrowly claimed internal-operations exception. Verify launch artifact traffic, including first start, Not now and consent withdrawal.

### P1 — Actual AI context is materially broader than notice shorthand

`context.ts:131–154` includes page title, typed/PDF text, Markdown notes and a page-region image; with a PDF background the image area is the **whole page** (`145–147`). `tutorStore.ts:100,116` defaults to auto context: absent a selection it sends current page context. `turns.ts:30–49` resends prior complete exchanges and may keep an earlier image. “Question and image of what you selected” (`shared/ai.ts:36–37`) is incomplete.

“No context” only affects the current turn; history can still contain notebook text/image. Threads are page-keyed, not provider-keyed (`tutorStore.ts:63,73–85`), while provider switching (`service.ts:201–207`) does not clear renderer threads. **Static risk:** a local conversation's prior notebook content may be sent to a newly selected cloud provider on follow-up. Not live-reproduced.

**Action:** preview actual payload scope before send; separate current context/history controls; clear or explicitly re-authorize history at provider changes. Test local→cloud, local→Gemini and context-none follow-ups using synthetic notes.

### P1 — Absolute retention/anonymity claims exceed evidence

`PRIVACY.md:20–23,46`, `shared/ai.ts:37`, and `PrivacyContent.tsx:12` promise no retained content and counts deleted every day. Cloudflare's current policy explicitly qualifies standard-inference zero retention with stateful-feature and legal/security exceptions; operational metadata can include request source, account/model IDs and timestamps.[6] Local salted hashes are privacy protections, not proof that content or network activity cannot identify someone.

`beta-server/src/ledger.ts:163–174` rotates/deletes daily state on the **next call to today()**, not through a demonstrated midnight deletion job. No alarm is implemented in `index.ts:59–95`. Persisted reservations are separately loaded/stored (`ledger.ts:177–186`). Therefore strict midnight erasure is not established. Config disables invocation logs but enables console logs (`wrangler.jsonc:16–17`); inspect real deployed logging, backups, provider retention and reservations before publishing an end-to-end erasure promise.

**Action:** make qualified claims and implement/verify the promised schedule with Claude's backend owner; this review made no backend edits.

### P1 — Loopback Ollama is not proof inference remains local

Good: `ollama.ts:94–98` refuses non-loopback addresses. Gap: it discovers arbitrary installed models (`107–123`) and sends model IDs to the local API (`132–138`); model validation is a name regex (`shared/ai.ts:103–107`), not a locally-resident-model guarantee. Ollama officially supports cloud features and documents `OLLAMA_NO_CLOUD=1` / `disable_ollama_cloud` to disable them.[9] A loopback daemon may relay cloud-model requests. This path was **not live-tested**.

**Action:** qualify “nothing leaves” until approved local models plus Ollama local-only configuration are verified. Test offline with the preinstalled approved model; disable external AI and update traffic for a strict offline build. Updates otherwise check automatically (`updater.ts:57–78`); “usable offline” and “never contacts internet” are different claims.

### P1 — No demonstrated child-content safety layer or evaluated child-safety behavior

`prompts.ts:16–28` contains useful tutoring/unclear-handwriting and text prompt-injection instructions, but no child-specific response rules for self-harm, sexual content, grooming, weapons, bullying or dangerous advice. `service.ts:379–400` streams free-text deltas directly and validates structured result shape, not content safety. `handler.ts:203–218,247–265` similarly forwards generation; no explicit moderation call appears in that path. Gemini parses provider blocks (`gemini.ts:14,77–79`), but that does not establish comparable Ollama/Qwen protection. No matching child-harm evaluation cases were found in `tests/live` in this review.

**Action:** before minors use any tutor, define age-appropriate safety scope, refusal/support behavior, visible fallibility notice and a private reporting path; evaluate synthetic prompts across every shipped provider/model, including text/image prompt injection and streamed harmful output. Absence of a visible layer is a gap, not proof the model will produce harmful answers. A prompt alone is not validation.

Positive controls: structured validation and no renderer-selected system prompt; `markupStore.ts:97–117,134–156` previews validated marks and requires approval before an undoable page change. Preserve these; they address edit control, not child-content safety.

### P1 — School deployment and feedback need separate treatment

FERPA is not a blanket restriction on every student's personal notebook: school-authorized disclosure of education records needs a valid basis. The school-official route requires institutional function, direct school control, purpose/redisclosure restrictions and annual-notice criteria.[4] COPPA school authorization is limited to the educational context/use and benefit of the school, with no other commercial purpose; actual school authority must be verified.[3] A teacher/child checking Allow is not proof. Keep school pilots synthetic-data-only until school approval, appropriate contract/data terms, provider chain, deletion/access and state-law review are settled. Do not advertise “FERPA compliant.”

Feedback defaults to GitHub issue creation (`src/shared/product.ts:9–13`, `main/index.ts:571–574`); neither public visibility nor a child-safe private channel is established by the in-app “opt-in” wording (`PrivacyContent.tsx:23`). Confirm actual destination/visibility; prohibit student records/screenshots and route child feedback through a responsible adult. No live feedback form was submitted.

## Draft wording — not a VPC mechanism or publication-ready legal notice

### Ordinary cloud data permission (only for otherwise eligible/authorized users)

> **Use online AI for this question?** Inkling sends your question, the selected image or current page context shown below, and recent conversation context to Inkling's server and Cloudflare Workers AI. Page context can include its title, typed notes, PDF text and an image of the page. Do not send names, contact details, student records, health information or other private material. Online AI also sends an installation identifier and network information for service operation and usage limits. Inkling's application code is designed not to save or log question/answer content. Cloudflare states that it does not train on Workers AI customer content; its retention policy has operational, feature and legal exceptions. AI may misread your work or give wrong or inappropriate answers. Review it with a trusted adult or teacher. You can continue using notebooks without online AI and change this permission in Settings. Read [completed Inkling privacy notice] and Cloudflare's data policy.
>
> **Keep online AI off** / **Allow online AI**

Use only after privacy facts and actual behavior are reconciled. Do not promise metadata stops on withdrawal while the current status path continues. Default focus should favor the non-sending choice rather than Allow (`ConsentDialog.tsx:18–20`).

### Under-13 route, before authorization exists

> **Online AI is not enabled for this child.** Notebook features remain available without online AI. A parent/legal guardian, or an authorized school where legally permitted, must complete Inkling's separate authorization process before online AI can be enabled. Clicking a permission button here does not verify parental consent.

Do not show a working “enable” bypass; tailor notebook/local-AI availability to what the build actually supports and has safety-tested.

### Parent authorization text, only inside a verified, counsel-reviewed process

> I am this child's parent or legal guardian. I have received the direct notice identifying [actual operator and contact], the information collected, how Inkling and [identified providers] process it, applicable retention, and my rights to review, delete and stop further collection. After completing the parental verification process, I authorize the described collection and use solely to provide the optional online tutor. I understand that ordinary notebook use does not require online AI and that I may revoke this authorization through [working method]. [Where legally required, present a separate non-integral third-party disclosure choice.]

Do not activate this wording until placeholders are real, verification precedes collection, child/install scope and withdrawal work, and the provider/disclosure basis is settled. For a small pilot, a counsel-designed signed-parent-form process is an enumerated VPC option; simply collecting an unchecked emailed assertion is not equivalent.[1]

## Verification still needed

No live safety or privacy pass is claimed. Ask the build/backend owner to verify: packaged first-run and revoked-consent traffic; approved local model with internet blocked; context/history preview and provider switch; under-13/shared-device authorization; harmful-content/refusal tests; deployed logging and idle-across-midnight erasure; actual feedback visibility; published operator/contact/legal texts. No code, server, deploy or release actions were taken here.

## Sources

[1] https://www.ecfr.gov/current/title-16/section-312.5 — consent
    > "Any method to obtain verifiable parental consent must be reasonably calculated, in light of available technology, to ensure that the person providing consent is the child's parent."
[2] https://www.ecfr.gov/current/title-16/section-312.2 — definitions
    > "(1) Requesting, prompting, or encouraging a child to submit personal information online;"
[3] https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions — school
    > "Where an operator gets consent from the school rather than the parent, the operator’s method must be reasonably calculated, in light of available technology, to ensure that a school is actually providing consent, and not a child pretending to be a teacher, for example."
    > "However, the school’s ability to consent for the parent is limited to the educational context – where an operator collects personal information from students for the use and benefit of the school, and for no other commercial purpose."
[4] https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa — ferpa
    > "Is under the direct control of the agency or institution with respect to the use and maintenance of education records;"
[5] https://ai.google.dev/gemini-api/terms — google
    > "You must be 18 years of age or older to use the APIs."
    > "You also will not use the Services as part of a website, application, or other service (collectively, " API Clients ") that is directed towards or is likely to be accessed by individuals under the age of 18."
[6] https://developers.cloudflare.com/workers-ai/platform/privacy — cfprivacy
    > "For standard inference requests that do not invoke a stateful feature, Cloudflare does not retain inputs or outputs after they are no longer needed to process the request and deliver the response, subject to the limited exceptions below."
[7] https://www.ecfr.gov/current/title-16/section-312.8 — security
    > "The operator must establish, implement, and maintain a written information security program"
[8] https://www.ecfr.gov/current/title-16/section-312.10 — retention
    > "At a minimum, the operator must establish, implement, and maintain a written data retention policy"
[9] https://docs.ollama.com/faq — Ollama local-only mode
    > "By turning off Ollama’s cloud features, you will lose the ability to use Ollama’s cloud models and web search."
[10] https://www.cloudflare.com/terms — Cloudflare subscription agreement
    > "You must obtain all necessary rights, releases and permissions to provide Customer Content to Cloudflare"
