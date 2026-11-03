/**
 * Asked before anything at all is sent to a cloud provider (a question, a
 * status or a connection check), and again when its notice changes.
 * Both list what is sent, item by item, from CLOUD_SENT / GEMINI_SENT.
 * Gemini: that Google may use free-tier content (including human review), the
 * age requirement, and how to stay on the free tier.
 * Cloud AI: where it goes, what Cloudflare and Inkling keep, who the permission
 * covers (everyone on this computer account; it is not verified parental
 * consent), and that the free allowance is limited.
 */
import { useEffect, useRef } from 'react'
import { ShieldCheck } from 'lucide-react'
import { GEMINI_TERMS_URL, useAi } from './aiStore'
import { CLOUD_DATA_NOTE, CLOUD_PERMISSION_SCOPE, CLOUD_SENT, CLOUD_TERMS_URL, CLOUD_WHEN_SENT, GEMINI_ELIGIBILITY, GEMINI_SENT, type SentItem } from '@shared/ai'

/** What the provider receives, item by item (the same list everywhere permission is asked). */
export function SentList({ items, testId }: { items: readonly SentItem[]; testId: string }) {
  return (
    <ul className="list-disc space-y-1 pl-5" data-testid={testId}>
      {items.map((item) => (
        <li key={item.id} data-item={item.id}>
          {item.text}
        </li>
      ))}
    </ul>
  )
}

export function ConsentDialog() {
  const open = useAi((s) => s.consentOpen)
  const answer = useAi((s) => s.answerConsent)
  const cloud = useAi((s) => s.status?.provider === 'cloud')
  const allow = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    // Focus the button without scrolling, so a long notice opens at its beginning.
    allow.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        void answer(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, answer])
  if (!open) return null
  if (cloud) return <CloudConsent answer={answer} allow={allow} />

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#1f2430]/30">
      <div role="dialog" aria-modal aria-labelledby="consent-title" data-testid="ai-consent" className="animate-pop max-h-[calc(100vh-32px)] w-[540px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl bg-white p-6 shadow-pop">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-lav-soft text-lav">
            <ShieldCheck size={18} />
          </span>
          <h2 id="consent-title" className="text-[17px] font-semibold">
            Send notebook content to Google Gemini?
          </h2>
        </div>
        <div className="space-y-2.5 text-[13.5px] leading-relaxed text-ink-2 select-text">
          <p>The AI Tutor runs on Google's Gemini API. When you ask it something, Inkling sends Google:</p>
          <SentList items={GEMINI_SENT} testId="ai-consent-sent" />
          <p>Nothing is sent to Google — not even a check of your key — until you allow it.</p>
          <p className="rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-3 py-2 text-ink">
            <strong>On the free tier, Google may use what you send, and its answers, to improve its products, and human
            reviewers may read them.</strong> Don't include sensitive, confidential or personal information.
          </p>
          <p className="rounded-xl border border-line px-3 py-2 text-ink" data-testid="ai-consent-age">
            <strong>Adults only.</strong> {GEMINI_ELIGIBILITY} By allowing, you confirm you are 18 or older.
          </p>
          <p>
            Inkling only offers free-tier models and never switches to a paid one. It can't see whether billing is turned
            on for your key's Google Cloud project — to stay free, use a key from a project without billing.
          </p>
          <p>
            Read Google's{' '}
            <a href={GEMINI_TERMS_URL} target="_blank" rel="noreferrer" className="text-accent underline">
              Gemini API terms
            </a>
            . You can withdraw this permission any time in Settings.
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => void answer(false)} className="rounded-xl px-4 py-2 text-[13.5px] font-medium text-ink-2 hover:bg-[#f1f2f4]">
            Not now
          </button>
          <button
            ref={allow}
            type="button"
            data-testid="ai-consent-allow"
            onClick={() => void answer(true)}
            className="rounded-xl bg-accent px-4 py-2 text-[13.5px] font-medium text-white hover:bg-accent-strong"
          >
            I'm 18 or older — allow
          </button>
        </div>
      </div>
    </div>
  )
}

function CloudConsent({ answer, allow }: { answer: (ok: boolean) => Promise<void>; allow: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#1f2430]/30">
      <div role="dialog" aria-modal aria-labelledby="consent-title" data-testid="ai-consent" data-provider="cloud" className="animate-pop max-h-[calc(100vh-32px)] w-[540px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl bg-white p-6 shadow-pop">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-lav-soft text-lav">
            <ShieldCheck size={18} />
          </span>
          <h2 id="consent-title" className="text-[17px] font-semibold">
            Send what you ask about to Inkling’s AI?
          </h2>
        </div>
        <div className="space-y-2.5 text-[13.5px] leading-relaxed text-ink-2 select-text">
          <p>When you ask the tutor something, Inkling sends its AI server, over an encrypted connection:</p>
          <SentList items={CLOUD_SENT} testId="ai-consent-sent" />
          <p data-testid="ai-consent-when">{CLOUD_WHEN_SENT}</p>
          <p className="rounded-xl border border-line px-3 py-2 text-ink">{CLOUD_DATA_NOTE}</p>
          <p className="rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-3 py-2 text-ink" data-testid="ai-consent-scope">
            {CLOUD_PERMISSION_SCOPE}
          </p>
          <p>
            The AI is free, with a limited number of answers per day. It never costs anything: when the day’s free answers are used up, the tutor pauses
            until midnight UTC and your notebooks work as usual. Don’t include sensitive personal information.
          </p>
          <p>
            Read{' '}
            <a href={CLOUD_TERMS_URL} target="_blank" rel="noreferrer" className="text-accent underline">
              Cloudflare’s Workers AI data policy
            </a>
            . You can withdraw this permission any time in Settings.
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => void answer(false)} className="rounded-xl px-4 py-2 text-[13.5px] font-medium text-ink-2 hover:bg-[#f1f2f4]">
            Not now
          </button>
          <button ref={allow} type="button" data-testid="ai-consent-allow" onClick={() => void answer(true)} className="rounded-xl bg-accent px-4 py-2 text-[13.5px] font-medium text-white hover:bg-accent-strong">
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
