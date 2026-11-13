import { CLOUD_DATA_NOTE, CLOUD_PERMISSION_SCOPE, CLOUD_SENT } from '@shared/ai'
import { SentList } from '@/ai/ConsentDialog'

/** What Inkling does with your notebooks, in plain words. Used in the Privacy dialog and in Settings. */
export function PrivacyContent() {
  const web = window.inkling.platform === 'web'
  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-2 select-text" data-testid="privacy-content">
      <Point title={web ? 'Your notebooks stay in this browser.' : 'Your notebooks stay on this computer.'}>
        {web
          ? 'Pages, notes, images and PDFs are saved in this browser’s storage for this site, and work offline.'
          : 'Pages, notes, images and PDFs are saved as files in Inkling’s library folder (Settings → Storage).'}{' '}
        Unless you sign in, Inkling doesn’t upload your notebooks anywhere.
      </Point>
      <Point title="Sync is optional, and only with your own account.">
        If you sign in (Settings → Account and sync), your notebooks, images and PDFs are also stored in Inkling’s sync service (Supabase), so they appear on your other devices, and it keeps earlier versions of each page so they can be restored. Only your account can read them. Notebooks from before you signed in are added only if you say so. Sign out to stop syncing.
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
      <Point title="No tracking.">Inkling has no analytics or advertising. It connects to the internet only for AI questions you send (and, once you have allowed the cloud AI, to check how many free answers are left), to sync if you have signed in, and, in installed versions, to check for updates.</Point>
      <Point title="Feedback is opt-in.">“Send feedback” opens a form with Inkling’s version and your operating system filled in. You see and edit everything before you send it, and no notebook content is attached.</Point>
      <Point title="No account needed.">Inkling and its AI work without signing in. If you do sign in, Inkling stores your email address (with Google sign-in, as provided by Google) to identify your account. A Gemini key, if you add one, is stored encrypted with your system’s keychain, never in your notebooks.</Point>
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
