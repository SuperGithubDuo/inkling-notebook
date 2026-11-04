# Inkling privacy policy: DRAFT for legal review

*This is a plain-language draft that describes what the software actually does, checked against the code on 3 Nov 2026 (branch `migrate/external-inference`, external inference provider). It is not legal advice and has not been reviewed by a lawyer. It must be reviewed by counsel before publication, with particular care for users under 18, under 13 in the US (COPPA), schools (FERPA and local equivalents) and the EU/UK (GDPR, age of digital consent).*

*Items in **[OPERATOR TO SUPPLY: …]** or **[OPERATOR DECISION REQUIRED: …]** are missing on purpose: they must come from the person or organisation that runs Inkling, not from the software.*

**Who we are.** [OPERATOR TO SUPPLY: legal name of the person or organisation running Inkling, postal address, and a contact email for privacy questions and requests.]

## What stays on your device

Your notebooks are saved on your computer:
- handwritten pages, typed notes, images and PDFs
- daily backups
- settings, including AI settings (`ai-settings.json`: the AI service you chose, a random installation ID, and whether and when you allowed the cloud AI)

Tutor chats are kept only while Inkling is open. Marks you add to a page from the tutor are saved in that notebook like your own work.

We have no account system and no cloud storage, and we can't see your notebooks.

## What leaves your device, and when

### 1. The AI Tutor, only after you allow it

The AI Tutor can use one of these services, chosen in Settings → AI Tutor:

- **Inkling AI (cloud, the default in the published installers).** Inkling's server on Cloudflare, answered by Qwen 3.8 27B hosted by **DeepInfra** (DeepInfra Inc., United States). If DeepInfra is unavailable for a long time, the operator may switch the server back to **Cloudflare Workers AI**, which hosts the same model. The app's permission notice names both.
- **Ollama.** A program on your own computer. Nothing leaves your computer.
- **Google Gemini, with your own key.** Only in development versions of Inkling; the published installers don't include it. Adults only, under Google's terms.

**Before you allow it, nothing is sent to a cloud service** — no question, no connection test and no check of how many free answers are left. The permission is asked the first time you use the cloud AI (or press *Test connection*, or tick the box in Settings), and again whenever this notice changes in a way that affects what is sent. If you choose *Not now*, nothing is sent and the tutor says so.

**After you allow it,** Inkling sends something when you ask the tutor, and when it checks how many free answers are left (when you open the tutor or AI settings, shortly after midnight UTC while Inkling is open, after a limit or connection error, and after an answer that was stopped before the server reported the count). Each answer also brings the count back with it. Each question sends:

- your question, or the quick action you chose (such as "Check my work");
- what you include with it: an image of your lasso selection and any typed text in it; or the current page — its title, typed text, PDF text and an image of its handwriting (of the whole page when it has a PDF); or a note page's title and text;
- the recent conversation on that page: up to your last 5 questions with the text they included, the tutor's answers, and the most recent earlier image. Earlier messages answered by a different AI service are not sent;
- for markups, practice and answer checks: the image or answer being checked, the practice problem and its expected answer, the topic and difficulty you chose, and the tutor's earlier explanation when you choose "Show this on my page";
- to Inkling's server only: this installation's random ID (made by the app, not linked to your name) and your internet (IP) address, which every connection carries.

The allowance check sends only the installation ID (and, like any connection, your IP address); no notebook content.

**What Inkling's server does with it.**
- It doesn't store or log the content of questions, images or answers. Its logs record only the kind of an error, never content.
- To enforce the free daily limits, it counts usage per installation ID and per network address (IPv6 grouped by its /64 block), stored only as SHA-256 hashes with a random salt. The salt and the per-installation and per-network counts are replaced with the first request the server handles after 00:00 UTC each day. A total for the whole service, with no identities, is kept for about 25 hours.
- To enforce the monthly limit, it also counts this calendar month's usage per installation ID, under a **separate** salt that changes every month (UTC), so the monthly count can't be joined to the daily ones. The salt and the monthly counts are deleted with the first request after the month ends. A monthly total for the whole service, with no identities, is kept until the next month.
- Usage is counted as tokens and an estimated cost in US dollars, never as content.
- An answer in progress is held as a reservation (hashed IDs and a cost estimate) for at most 10 minutes.

**What DeepInfra does with it.** Inkling's server sends DeepInfra the question, images and conversation listed above, with Inkling's instructions, and **not** the installation ID or your IP address (DeepInfra sees only Inkling's server). DeepInfra states that standard inference requests are held in memory only while they are processed and are not stored on disk, that it doesn't use them to train models, that it doesn't share them, and that its logs keep only metadata such as request IDs, cost and sampling settings, not content ([DeepInfra data privacy](https://docs.deepinfra.com/account/data-privacy)). DeepInfra states it holds SOC 2 and ISO 27001 certifications. Its [terms of service](https://deepinfra.com/terms) (section 7(b), "Zero Data Retention") commit it not to retain, store or log customer content beyond processing the request and not to use it to train or improve models; the exceptions are support cases (deleted within 30 days of resolution), non-content metadata such as request counts and billing records, records kept to comply with law or to investigate fraud or abuse, and features Inkling doesn't use (batch requests, paid cache retention). A data processing agreement (trust.deepinfra.com) is part of those terms. [OPERATOR TO SUPPLY: review and accept DeepInfra's DPA before publication.]

**What Cloudflare does with it.** Cloudflare runs Inkling's server, so content passes through Cloudflare's network on its way to DeepInfra; the server doesn't store or log it. When the server uses Cloudflare Workers AI instead (as a backup), Cloudflare processes the content to produce the answer and states that it doesn't use it to train models and doesn't keep it afterwards ([Cloudflare's Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)). Cloudflare also keeps operational metadata for its platform, such as request times and usage counts. [OPERATOR TO SUPPLY: confirm against Cloudflare's current terms and data processing agreement before publication.]

Inkling does not claim "zero data retention": that would depend on the providers' contractual terms, which the operator has to confirm.

**Who the permission covers.** One permission covers everyone who uses Inkling on that computer account. You can withdraw it at any time in Settings → AI Tutor; from then on nothing is sent until it is given again.

**Google Gemini (development versions only).** The same content as above, but not the installation ID, goes to Google under Google's terms. On Google's free tier, Google may use it to improve its products, and human reviewers may read it. Nothing, not even a check of your key, is sent to Google before you allow it.

### 2. Update checks (installed versions)

When it starts, the app asks GitHub whether a newer version exists. GitHub sees your IP address and app version, as with any download. This happens whether or not you use the AI.

### 3. Feedback, only if you choose to send it

*Send feedback* opens a page in your browser with the app version and operating system filled in. You see and edit everything, and nothing from your notebooks is attached. Where it goes depends on how the version you installed was built: a feedback form, or, if none was set up, a new issue on GitHub, which is **public** and needs a GitHub account. [OPERATOR TO SUPPLY: the feedback form's provider, who can read responses, and how long they are kept.]

There are no analytics, advertising, tracking cookies or crash reporting.

## Keys

The cloud AI needs no account or key. A Gemini API key, if you add one in a development version, is stored encrypted using your operating system's keychain and used only to reach Google.

## Children and students

What the software does today:
- Inkling does not ask for or check anyone's age.
- Clicking *Allow* is the user's own permission. **It does not verify that a parent or guardian has consented.** The permission notice says so, and asks anyone under 18 to ask a parent or guardian before allowing.
- Every notebook feature works without the AI, and the Ollama tutor sends nothing off the computer.
- Google Gemini, whose terms exclude users under 18, is not in the published installers.

[OPERATOR DECISION REQUIRED: the audience for the cloud AI (for example: everyone with parent guidance, 13 and older, or 18 and older); whether and how a parent or guardian gives verifiable consent for children under 13 (US) or under the age of digital consent in the EU/UK; whether schools may use Inkling, and on what agreement. To be decided with counsel; the app does not implement any of these yet.]

## Your choices

- Use Inkling without any AI, or with the local Ollama tutor.
- Withdraw AI permission at any time in Settings → AI Tutor.
- Delete your data on this computer by deleting the Inkling folders:
  - Windows: `%APPDATA%\Inkling`
  - macOS: `~/Library/Application Support/Inkling`
- The cloud AI's daily usage counts are replaced every day, and the monthly count per installation at the end of each month; neither can be linked back to you by us.
- Questions or requests about your data: [OPERATOR TO SUPPLY: contact email and how requests are handled, including for parents and guardians.]

## Changes

We'll describe changes in the release notes, and in the app when they affect what is sent where. When what the cloud AI receives changes, the app asks for permission again before sending anything.

Last updated: [OPERATOR TO SUPPLY: publication date]
