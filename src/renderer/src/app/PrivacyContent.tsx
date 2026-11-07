import { CLOUD_DATA_NOTE, CLOUD_PERMISSION_SCOPE, CLOUD_SENT } from '@shared/ai'
import { SentList } from '@/ai/ConsentDialog'

/** What Inkling does with your notebooks, in plain words. Used in the Privacy dialog and in Settings. */
export function PrivacyContent() {
  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-2 select-text" data-testid="privacy-content">
      <Point title="Your notebooks stay on this computer.">
        Pages, notes, images and PDFs are saved as files in Inkling’s library folder (Settings → Storage). Inkling has no account and no cloud sync, and doesn’t upload your notebooks anywhere.
      </Point>
      <Point title="The AI Tutor sends only what you ask about, and only after you allow it.">
        With Ollama, everything stays on this computer. With Inkling AI (cloud, the default), nothing is sent — not even a check of today’s free answers — until you click Allow. After that, each question sends Inkling’s AI server:
        <SentList items={CLOUD_SENT} testId="privacy-cloud-sent" />
        <p className="mt-1.5">
          {CLOUD_DATA_NOTE} {CLOUD_PERMISSION_SCOPE}
        </p>
        <p className="mt-1.5">
          Google Gemini, with your own key, is only in development versions of Inkling, not in the published installers; it is for adults only.
        </p>
      </Point>
      <Point title="No tracking.">Inkling has no analytics or advertising. It connects to the internet only for AI questions you send (and, once you have allowed the cloud AI, to check how many free answers are left) and, in installed versions, to check for updates.</Point>
      <Point title="Feedback is opt-in.">“Send feedback” opens a form with Inkling’s version and your operating system filled in. You see and edit everything before you send it, and no notebook content is attached.</Point>
      <Point title="No account.">Inkling’s AI needs no sign-in. A Gemini key, if you add one, is stored encrypted with your system’s keychain, never in your notebooks.</Point>
    </div>
  )
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium text-ink">{title}</p>
      <div>{children}</div>
    </div>
  )
}
