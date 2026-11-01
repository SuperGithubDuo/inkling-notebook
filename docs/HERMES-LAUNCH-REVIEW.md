# Inkling Beta 2 — independent launch review

**Decision: HOLD for tester distribution; not cleared as all-ages online AI.**

Reviewed 2026-10-31 UTC / 2026-10-30 Pacific, toward November 7. Source baseline: `build/draft-release` at `f00f3dd8bef04fc6d1ee62fe5e47ee4e5bf5c79c`. This review is documentation/QA only: no AI-server edits, deployment, release build, merge, publication or invitation was performed. Claude retains backend reliability and final-build ownership.

## 1. Ready now

- Exact **10-question**, no-contact/no-upload feedback form: [HERMES-FEEDBACK-FORM.md](HERMES-FEEDBACK-FORM.md). **Prepared, not published**; there is no working form URL yet.
- Windows **installed packaged-app** checks with synthetic, nonpersonal data: notebooks, mouse strokes, lasso/move, undo/redo, autosave/reopen, rectangle drawing, PDF import/export rendering, manual backup/restore and safety copy. Evidence and harness limitations: [evidence README](hermes-launch-evidence/README.md).
- First-time checklist and invitation below; privacy review and draft wording: [HERMES-PRIVACY-REVIEW.md](HERMES-PRIVACY-REVIEW.md).
- Current draft Windows EXE hash matches GitHub asset digest and its update metadata. **This does not mean that draft passed QA.**

## 2. What I personally tested

Freshly downloaded the installer artifact from the latest successful **Release** run [41147420893](https://github.com/SuperGithubDuo/inkling-notebook/actions/runs/41147420893), source `4ea46be4c38ee912803b672daf08a4bf72706424`, artifact `13021637988`. Installed using NSIS `/S /D=<scratch install>`: exit **0**. The launched `Inkling.exe` reported `isPackaged: true`, version `0.2.0-beta.2`; no development app/server or locally rebuilt release was used.

| Check | Actual result and evidence |
|---|---|
| Installation/launch | Silent installation and real executable launch passed. Native wizard, download security warning, upgrade/uninstall **not exercised**. |
| Notebook creation | Created `Hermes launch QA`; opened its saved page. `qa-results.json`. |
| Handwriting/autosave | Two Playwright **mouse** strokes saved as page objects. `mouse-ink-saved.png`. Not physical handwriting-quality evidence. |
| Lasso/move/undo/redo | Selected both strokes; coordinates moved from `[120,180]` to `[190.99,239.95]`; undo restored, redo reapplied. `lasso-moved.png`, `qa-results.json`. |
| Drawing | Rectangle persisted with the expected geometry. `rectangle-drawn.png`, `qa2-results.json`. |
| Restart persistence | Saved stroke objects compared equal after closing/reopening. `reopened-notebook.png`. Backup restore subsequently also compared all backed-up page objects. |
| PDF import/export | Imported red/green two-page fixture; repeated import produced a five-page notebook. Final export rendered with pdf.js: ink/rectangle page plus red PAGE 1, green PAGE 2, red PAGE 1, green PAGE 2 in order. Text, page count, distinct background pixels and visible ink confirmed. `pdf-render-results.json`, `export-render-*.png`. |
| Backups | Manual timestamped copy created; added a newer stroke; restored backup through Settings. Restored objects equaled backup, and before-restore safety copy equaled the newer work. `backup-results.json` has `pass: true`; `backup-created.png`. Daily snapshot existed; seven-day scheduling/pruning not tested. |
| Consent decline | First synthetic question showed cloud permission; chose Not now; status remained unconsented. `cloud-consent.png`, `qa-results.json`. No packet capture: not a blanket claim of zero network traffic. |
| Anonymous access/counter | No account/key supplied. Live status probe succeeded; built-in cloud URL used, quota returned, footer showed about 10 answers. `anonymous-status.png`, `qa-results.json`. |
| Real AI question | Drew incorrect algebra `2x + 3 = 7`, `2x = 5`, `x = 3` with automated mouse glyphs. Real model request failed with provider-unavailable error and `retryAfter: 900`. Counter stayed about 10, `installUsed: 0`. `live-results.json`, `incorrect-ink.png`, `incorrect-reply.png`. |
| Window bounds | Requested outer 1440×900, 1024×768, 800×600; actual renderer 1424×835, 1008×703, **944×535** (minimum width enforced). No document horizontal overflow; narrow screenshot retains tutor input/footer. `window-800x600.png`. Device pixel ratio was 1. |
| Runtime errors | No uncaught renderer page errors captured in `qa-results.json`; not a comprehensive console/main-process audit. |

**Not passed / not run:** live correct-math recognition, correction preview/approval, AI-annotation undo/redo, practice generation, successful-answer counter decrement, exhausted-quota/UTC-rollover behavior. The live harness stopped after provider failure; no mocked answers are substituted. Physical pen/touch, pressure, palm rejection, real display-scaling changes, macOS execution, offline/network recovery, crash recovery and installation-warning UX remain unverified. Mac artifacts exist, but this machine is Windows and cannot execute them.

**Isolation caveat:** notebook/config directories were isolated. The app pins Chromium `userData` to `%APPDATA%/Inkling`, so APPDATA/`--user-data-dir` did not provide a clean welcome profile. Initial smoke failed waiting for welcome; do not count it as clean-install onboarding acceptance. Existing library contents were not intentionally edited. Wrong selector, backup-path and early PDF-file checks were harness defects, retained and explained in the evidence README, not reported as product bugs.

## 3. Findings ranked by severity

| ID | Severity | Finding / reproduction | Required disposition |
|---|---|---|---|
| H-01 | **High — launch blocker** | Status Test connection succeeds, but sending the drawn incorrect algebra fails with “free AI is briefly unavailable from its provider,” retry in about 15 minutes. Reproduce: install successful-run artifact → allow cloud AI → draw sample → ask Check my work. Expected: answer; actual: server error. Screenshot: [incorrect-reply.png](hermes-launch-evidence/incorrect-reply.png). One failed generation observed; no claim of permanent outage or backend root cause. | Claude resolves reliability; independently rerun full live tutor workflow on final installer. Do not hammer the service during its retry interval. |
| H-02 | **High — distribution blocker** | Current draft's same-version installer differs from successful tested artifact; release run failed and body says DO NOT PUBLISH. Check draft metadata and hashes below. Expected: approved run and assets bound to it; actual: unapproved draft assets. Not an end-user canvas defect. | Claude supplies successful final run and asset/source/hash handoff. |
| H-03 | **Medium — feedback defect** | `INKLING_FEEDBACK_URL` unset. Source fallback opens GitHub issue creation, which requires GitHub to submit and can expose a report publicly. Reproduce from build without override: Help → Send Feedback. Static/config finding; destination submission not live-tested. | Publish owned no-sign-in form; set variable, rebuild and test both Help and Settings signed out. |
| H-04 | **High — privacy/product-safety blockers** | Generic cloud Allow, persistent shared-device consent, unfinished operator notice and selectable Gemini conflict with unqualified all-ages launch. Static findings; not independently reproduced child access or legal adjudication. | Complete safeguards in section 5 before minors' online AI; keep ordinary notebooks available. |

No data-loss or PDF-corruption defect was reproduced in the completed offline-feature checks. This is limited evidence, not a clean bill of health for every feature/platform.

## 4. Feedback form handoff

Use [the exact short form and settings](HERMES-FEEDBACK-FORM.md), not the existing 19-question draft. It covers setup, installation, UI, input/handwriting, AI accuracy, consent/counter, persistence, bugs and improvements; requests no names, ages, emails, school details, notebook content or uploads.

**Missing access:** Tally editor opened anonymously; Publish required an owner account. The browser's real Chrome profile was locked, so a fresh profile was used; vault contained no saved logins. No account was created and no form published. Owner must supply access to an owned form workspace or create it from the prepared text.

After signed-out open **and submission** verification, set Actions repository **variable** `INKLING_FEEDBACK_URL` to the real HTTPS responder link (not editor link). Workflow builds it as `MAIN_VITE_INKLING_FEEDBACK_URL`. Ask **Claude** to include it in the approved rebuild; do not force-push/rebuild independently. Existing installers cannot pick up a variable change. Verify workflow “Feedback link built in,” Help/Settings entry points, no login/upload, response read-back and deletion of synthetic QA response. Rehash all replaced assets.

## 5. All-ages/privacy actions requiring review

This is a risk assessment, **not legal compliance approval**. Full source references, exact quotations and review-only consent templates are in [HERMES-PRIVACY-REVIEW.md](HERMES-PRIVACY-REVIEW.md).

1. **Separate notebook availability from online-AI eligibility.** Keep writing, saving, PDF and backups usable without online AI. Current Allow is content permission, not verified parental consent. For covered US under-13 collection, a process must reasonably establish that the consenting person is the parent; a checkbox does not do that.[1] Resolve child-directed/mixed-audience status, age routing and shared-device authorization with qualified review. Do not collect DOB/identity documents casually to improvise a solution.
2. **Gemini is an app-level conflict.** Its current terms prohibit API clients directed toward or likely accessed by under-18s; BYOK and an “I'm 18+” click do not resolve that wording.[5] Recommend disabling/removing Gemini from the all-ages distribution pending provider/legal clearance. An adult-only first cohort alone does not establish clearance for the broader all-ages app.
3. **Finish real operator/contact and policies.** `PRIVACY.md` still has identity/contact, child-policy and date placeholders. Establish real access/deletion/revocation request route, retention/security program, incident owner and provider agreements. No company, contact address or approval has been invented here.
4. **Correct context/metadata notices.** Page context can include title, text/PDF text and a whole PDF-page image; recent history can retain earlier content even when current context is None. Provider-switch cross-transfer is a **static risk**, not a live reproduction. Cloud status sends installation/network metadata before content consent; “nothing sent until you ask” must distinguish content from metadata. Test first-run, decline, withdrawal and local→cloud switching.
5. **Qualify retention and “local” promises.** Do not promise end-to-end zero retention or strict midnight deletion without verifying provider features, logs and idle-day cleanup. Cloudflare's policy does not train on customer content but includes storage-feature considerations; review actual provider terms/configuration.[6] A loopback Ollama endpoint is not proof its selected model is offline; verify approved installed models and local-only configuration.[9] Offline-usable does not mean the installed app never checks for updates.
6. **School privacy is separate.** Confirm school authority, education-only purpose, control/redisclosure restrictions, contracts and applicable state/international rules before real student records. Neither school-official FERPA treatment nor COPPA school authorization follows from a teacher/child clicking Allow.[3][4] UK/EU consent ages and other teen protections need jurisdiction-specific review.
7. **AI child-safety acceptance is missing.** Define age-appropriate harmful-content/refusal/support policy, visible fallibility warning, private reporting and synthetic evaluation across shipped providers/models and streamed output. Existing preview/approval/undo controls are useful but not content-safety validation. No harmful response was demonstrated in this pass, nor was safety proven.
8. **Feedback has its own privacy surface.** No sign-in does not mean the form host sees no IP/cookies. Review host terms/retention, named response access and deletion schedule. Route child feedback through a reviewed responsible-adult process until appropriate safeguards are settled.

**Review-only wording, not implemented:**
> Online AI is not enabled for this child. Notebook features remain available without online AI. A parent/legal guardian, or an authorized school where legally permitted, must complete Inkling's separate authorization process before online AI can be enabled. Clicking a permission button here does not verify parental consent.

For eligible users, explain question + chosen page/selection + recent conversation, installation/network usage metadata, actual providers and qualified retention, AI fallibility and withdrawal. The longer draft in the privacy review must be reconciled with actual behavior before publication; it is not itself an authorization mechanism.

## 6. Release/version/hash verification

`package.json` and both root/package entries in `package-lock.json` agree on **0.2.0-beta.2**. Tested installed app reports that version. Filename/version alone cannot distinguish repeated rebuilds.

| Windows installer identity | Source/run | Size | SHA-256 |
|---|---|---:|---|
| **Actually installed/tested** successful-run artifact | `4ea46be…`, run `41147420893`, artifact `13021637988` | 128636974 | `47fcc43b5d60ef22c9a69f48a2592d3897d6ac6e46a548a2ec1a88b2e13969fa` |
| Current draft EXE, downloaded for hash verification only | draft `429611793`, target `f00f3dd…`, failed run `41149694675` | 128636969 | `35be71b6ddbaa445d56173c70d380f349293ce41a95653dd2e321bb67c342fa3` |

Draft SHA-256 equals GitHub's asset digest. Computed draft SHA-512 equals `latest.yml`:
` tLTHA00BiOH9G20r5Nkyp+KRIlTD4GdstTpSDfbEK4Qe7WoKu4ko7tSon0Z/Z0mdL8W5xIXPjCEAVVFL4OV30Q== `

See `hash-verification.json` and `draft-latest.yml`. No SHA256SUMS file was attached to the draft at review time. Mac checksums were **not independently computed**. Draft remains draft+prerelease with DO NOT PUBLISH; an unpublished tag/draft link is not a working ordinary-tester download. Owner must choose an approved private delivery method or later publication; this review did neither.

**Unsigned warning wording:** Windows installer was verified unsigned. Windows may display Unknown publisher/“Windows protected your PC”; warnings are not guaranteed. Only after checking the supplied source, exact filename and trusted SHA-256 should a willing tester use More info → Run anyway if available. A matching hash detects mismatch, not publisher identity or safety. Stop if organization policy blocks it; never disable protection. Mac builds are described by release configuration/docs as ad-hoc signed, not Developer ID signed/notarized; not personally verified on a Mac. Use System Settings → Privacy & Security → Open Anyway if offered (macOS 12: System Preferences → Security & Privacy → General). Do not promise an override exists. Both unsigned platforms use notify-only updates; replacement installers need manual installation.

**Documentation cleanup for owner:** correct Windows ARM/two-EXE claims to actual x64-only output; remove stale beta.1 instructions; qualify untested platform claims; do not promise “No account needed” feedback until form is built in. Do not follow the old force-push rebuild command in FEEDBACK-FORM while Claude owns the release branch.

## 7. First-time tester checklist and capacity

- [ ] Get approved installer + exact SHA-256 from the organizer; note OS/architecture, display scaling and input device; confirm About version.
- [ ] Install; report security-warning/first-launch issues without disabling system security.
- [ ] Create a disposable notebook; write/draw, erase, lasso/move, undo/redo; physical-pen testers check pressure/palm rejection and identify hardware without serial numbers.
- [ ] Import a nonsensitive two-page PDF, annotate, export and reopen; confirm page order and ink.
- [ ] Close/reopen immediately after saving; confirm notebook/pages survive. Make a backup; restore only disposable test data.
- [ ] For authorized AI testers: decline once, then enable permission, use made-up correct and incorrect maths, inspect correction preview before approval, undo/redo, try practice; verify counter updates. No real school/private notes.
- [ ] Try ordinary notebook work offline, then confirm honest AI failure/recovery; report actual scaling/window-size problems.
- [ ] Open feedback signed out; describe steps/expected/actual results and version, with no notebook screenshots or contact details.

**Rollout recommendation:** start with five **adult** volunteers while child safeguards remain unresolved; first confirm Gemini disposition with the owner/provider review. Expand to ten only after install/feedback triage. This is a cohort recommendation, not implemented age/access enforcement and not abandonment of all-ages notebooks.

Ask each tester for roughly **five AI interactions/day**, counting chat, markup and practice separately. At the configured 90-Neuron estimate, five testers estimate 2,250 Neurons and ten 4,500; actual cost varies. Current quota response: 900/install, 2,700/network, 9,000/global per UTC day. Ten full install shares exhaust 9,000 with no QA headroom; shared networks also share the network cap. Do not have every tester exhaust quota. Delegate one controlled exhaustion/rollover test; reserve QA headroom and ask Claude/operator to confirm actual free plan, caps and read-only usage monitoring. Private invitations are not technical access control; no account/invite-code enforcement is established.

## 8. Tester invitation — prepared, NOT sent

> You're invited to a small Inkling Beta 2 test. Please spend about 20 minutes with a disposable notebook and made-up examples, and keep important work backed up.
>
> Download: **[ORGANIZER: insert approved tester-accessible download URL]**
> Windows file: `Inkling-Setup-0.2.0-beta.2-x64.exe`
> SHA-256: **[insert hash of that exact approved installer—not an older same-version build]**
> Installation guide: **[insert guide URL accessible alongside the approved build]**
>
> This beta is unsigned on Windows and not Developer ID signed/notarized on Mac, so your computer may warn or block it. Follow the guide only if you trust the supplied download; do not disable security or bypass organization rules. If blocked, stop and tell the organizer through the invitation's reply channel.
>
> Try a notebook, writing/drawing, lasso and undo, PDF import/export, then close/reopen. If you are in the authorized AI test cohort, use only made-up maths, inspect AI changes before approving them, and keep to about five AI interactions a day. AI can be wrong; its free shared allowance may run out. Ordinary notebooks should remain usable without AI.
>
> Feedback (no sign-in): **[insert verified public feedback URL]**. Please report version, steps, expected and actual behavior—no names, notebook contents, homework or page screenshots. Reply to this invitation if installation prevents opening feedback.

**Do not send with placeholders.** No working download/form URL or support identity is fabricated. Organizer fills real approved links only after launch gates.

## 9. Exact remaining steps before November 7

1. **Owner + qualified privacy/provider review:** choose enforceable AI audience/authorization policy, resolve Gemini app-level terms, finish actual operator/contact notice, parent/school process, retention/security and child-safety plan. Keep notebooks available to all ages; do not invite minors to online AI on the basis of current Allow.
2. **Owner:** publish the prepared owned feedback form, configure access/retention, perform signed-out submission/read-back/deletion, then set the real `INKLING_FEEDBACK_URL` Actions variable.
3. **Claude:** complete backend reliability and final build; give a successful Release run, immutable source SHA, platform assets and recomputed trusted checksums. Current failed draft is not approved. Do not merge/publish automatically from this review.
4. **Independent QA:** install that exact final artifact and rerun all completed checks plus clean-profile welcome/native wizard and failed AI matrix: correct/incorrect maths, correction preview/approval, undo/redo, practice, successful counter refresh, consent withdrawal, context/provider boundaries, offline recovery. Verify export contents and restore safety again after changes.
5. **Hardware/platform testers:** real stylus/touch/palm/pressure and actual display scaling; macOS install/launch/import/export/persistence and warnings; supported architectures only. Record evidence and unresolved failures, not assumed passes.
6. **Release owner:** fix misleading/stale guide claims; ensure final tester-accessible download and guide match exact artifact/hash and contain working feedback. Decide distribution/publication separately; nothing has been publicly announced here.
7. **Organizer:** once gates are signed off, privately invite five approved testers, triage installation/feedback first, then expand to ten with allowance headroom. Set a real feedback-review owner and response deletion date before collection.

No task is marked passed merely because code or previous CI suggests it works. This report records completed preparation and concrete blockers, not final production acceptance.

## Sources

[1] https://www.ecfr.gov/current/title-16/section-312.5 — consent
[3] https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions — school
[4] https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa — ferpa
[5] https://ai.google.dev/gemini-api/terms — google
[6] https://developers.cloudflare.com/workers-ai/platform/privacy — cfprivacy
[9] https://docs.ollama.com/faq — Ollama local-only mode
