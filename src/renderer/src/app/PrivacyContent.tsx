/** What Inkling does with your notebooks, in plain words. Used in the Privacy dialog and in Settings. */
export function PrivacyContent() {
  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-2 select-text" data-testid="privacy-content">
      <Point title="Your notebooks stay on this computer.">
        Pages, notes, images and PDFs are saved as files in Inkling’s library folder (Settings → Storage). Inkling has no account and no cloud sync, and doesn’t upload your notebooks anywhere.
      </Point>
      <Point title="The AI Tutor sends only what you ask about, and only after you allow it.">
        When you ask a question, Inkling sends it together with an image of your selection, or the current page’s typed text, to the AI service you chose in Settings → AI Tutor:
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-ink">Inkling AI (cloud, the default):</strong> answered by Cloudflare Workers AI through Inkling’s AI server. Cloudflare says it does not train on this content and does not keep it after answering; Inkling’s server never stores or logs it. To share out the free daily allowance, the server counts answers per installation (a random ID this app made, not linked to you) and per internet connection, in scrambled form deleted every day.
          </li>
          <li>
            <strong className="text-ink">Ollama:</strong> answered on this computer; nothing leaves it.
          </li>
          <li>
            <strong className="text-ink">Google Gemini (18+):</strong> with your own key. On Gemini’s free tier Google may use what you send to improve its products, and people may review it.
          </li>
        </ul>
      </Point>
      <Point title="No tracking.">Inkling has no analytics or advertising. It connects to the internet only to answer AI questions you send and, in installed versions, to check for updates.</Point>
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
