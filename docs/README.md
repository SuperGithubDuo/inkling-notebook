# Inkling documentation

**Just want to use Inkling?** Go to the [download page](https://supergithubduo.github.io/inkling-notebook/) and follow the [install guide](INSTALL.md). Nothing below is needed to use the app.

## Using Inkling

| | |
|---|---|
| [Install guide](INSTALL.md) | Downloading, security prompts, checksums, younger users, uninstalling |
| [User guide](USER-GUIDE.md) | Canvas tools, notes, search, links, graph, PDFs, the AI tutor, your data |
| [AI providers](AI-PROVIDERS.md) | Cloud, local (Ollama) and Gemini: what each sends where, limits, measured results |
| [Known limitations](KNOWN-LIMITATIONS.md) | What doesn't work yet |
| [Privacy notice (draft)](PRIVACY.md) | Pending legal review |
| [Feedback and support](../SUPPORT.md) | How to report a problem |
| [Release notes](../RELEASE_NOTES.md) | What changed in each version |

## Developing Inkling

| | |
|---|---|
| [Developing Inkling](DEVELOPMENT.md) | Requirements, running from source, all test suites, CI |
| [Architecture](ARCHITECTURE.md) | Storage, command layer, rendering, AI requests, security |
| [AI tutor: terms and the hosted plan](AI.md) | Provider terms, guarantees, plans for hosted AI |
| [AI server](../beta-server/README.md) | The Cloudflare Worker behind the free tutor |
| [Roadmap](ROADMAP.md) | Milestones and remaining work |

## Releasing and operating

| | |
|---|---|
| [Building and releasing](RELEASING.md) | Installers, signing, the approval-gated release flow, operating the AI server |
| [Download site and release flow](maintainers/DOWNLOAD-SITE.md) | How an approved build reaches users, and why a bad one can't |
| [Repository cleanup plan](maintainers/REPOSITORY-CLEANUP.md) | Branch audit and proposed structure |
| [Changes waiting for approval](maintainers/APPROVALS.md) | Exactly what needs a yes before it happens |
| [Claims audit](maintainers/CLAIMS-AUDIT.md) | README and site checked against what the code does (privacy, AI data, ages, features) |
| [Release readiness](READINESS.md) | Evidence-based checklist for the beta |
| [Launch kit](LAUNCH.md) · [Monetization plan](MONETIZATION.md) | Product copy, website outline, editions |

## Testing and QA evidence

| | |
|---|---|
| [Device testing](DEVICE-TESTING.md) | Hands-on checks on real computers, pens and touch screens |
| [Beta 2 checklist (Windows)](BETA2-CHECKLIST.md) | The short pass before inviting testers |
| [Windows validation (Hermes)](windows-validation.md) | Hermes's Phase 4.6 checklist |
| [Hermes's Beta 2 launch review](HERMES-LAUNCH-REVIEW.md) | Independent QA of the Beta 2 Windows installer: what was tested, findings H-01–H-04, launch decision (31 Oct 2026) |
| [Hermes's privacy review](HERMES-PRIVACY-REVIEW.md) | All-ages and privacy risk assessment with sources (not legal approval) |
| [QA evidence](hermes-launch-evidence/README.md) | Screenshots, results, harness scripts and hashes behind the review; `manifest.json` lists every file's SHA-256 |
| [Live model results](live-results/README.md) | Real-model answers, timings and screenshots |
| [Feedback form (Hermes's 10-question version)](HERMES-FEEDBACK-FORM.md) | The short no-contact form recommended for testers |
| [Feedback form (original draft)](FEEDBACK-FORM.md) | Longer draft and how to connect a form to the app (`INKLING_FEEDBACK_URL`) |
| [Phase 4.5 notes](history/PHASE-4.5-WINDOWS.md) | Windows stabilisation, kept for history |
