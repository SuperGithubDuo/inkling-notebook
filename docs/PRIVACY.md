# Inkling privacy policy: DRAFT for legal review

*This is a plain-language draft that describes what the software actually does (checked against the code on 29 Oct 2026). It is not legal advice and must be reviewed by counsel before publication. It needs particular care for users under 18, or under 13 in the US (COPPA), schools (FERPA and local equivalents) and the EU/UK (GDPR, age of digital consent).*

**Who we are.** [Company name, address, contact email]: to be filled in.

## What stays on your device

Your notebooks are saved on your computer:
- handwritten pages, typed notes, images and PDFs
- daily backups
- settings

We have no account system and no cloud storage, and we can't see your notebooks.

## What leaves your device, and when

1. **AI Tutor questions, only when you ask and only after you agree.** We send your question and the context you chose: an image of your selection, or the page's typed or PDF text. Where it goes depends on the provider you selected:
   - **Inkling beta (cloud).** It goes to our server on Cloudflare, which forwards it to Cloudflare Workers AI for an answer.
     - We don't store the question, the image or the answer.
     - Our server records only an access-code identifier, the date and the amount of AI usage, to enforce daily limits.
     - Cloudflare processes the content to produce the answer. It states that it doesn't use it to train models and doesn't keep it afterwards ([Cloudflare's Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)).
     - Cloudflare also keeps operational metadata (times, sizes, token counts), not content.
   - **Ollama.** It goes to a program on your own computer, and nothing leaves it.
   - **Google Gemini (your own key, adults only).** It goes to Google under Google's terms. On Google's free tier, Google may use it to improve its products, and human reviewers may read it.
2. **Update checks (installed versions).** The app asks GitHub whether a newer version exists. GitHub sees your IP address and app version, as with any download.
3. **Feedback, only if you choose to send it.** *Send feedback* opens a form or email with the app version and operating system filled in. You see and edit everything, and nothing from your notebooks is attached.

There are no analytics, advertising, tracking cookies or crash reporting.

## Keys and access codes

API keys and beta access codes are stored encrypted using your operating system's keychain, and are used only to reach the provider you chose.

## Children and students

[To be decided with counsel. For example: whether the beta is limited to ages 13+, or 18+; whether students under 13 may use the cloud tutor with parental or school consent; the school agreement template.] The Google Gemini option is limited to adults by Google's terms, and the app says so.

## Your choices

- Use Inkling without any AI, or with the local Ollama tutor.
- Withdraw AI consent at any time in Settings.
- Delete your data by deleting the Inkling folder:
  - Windows: `%APPDATA%\Inkling`
  - macOS: `~/Library/Application Support/Inkling`
- For the cloud beta, ask us to delete your access code's usage record: [contact].

## Changes

We'll describe changes in the release notes, and in the app when they affect what is sent where.

Last updated: [date]
