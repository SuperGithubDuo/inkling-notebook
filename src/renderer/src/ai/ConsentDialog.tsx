/**
 * Asked once before any notebook content is sent to Gemini. Explains what is
 * sent, that Google may use free-tier content (including human review), the
 * age requirement, and how to stay on the free tier.
 */
import { useEffect, useRef } from 'react'
import { ShieldCheck } from 'lucide-react'
import { GEMINI_TERMS_URL, useAi } from './aiStore'
import { GEMINI_ELIGIBILITY } from '@shared/ai'

export function ConsentDialog() {
  const open = useAi((s) => s.consentOpen)
  const answer = useAi((s) => s.answerConsent)
  const allow = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    allow.current?.focus()
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#1f2430]/30">
      <div role="dialog" aria-modal aria-labelledby="consent-title" data-testid="ai-consent" className="animate-pop w-[540px] max-w-[calc(100vw-32px)] rounded-2xl bg-white p-6 shadow-pop">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-lav-soft text-lav">
            <ShieldCheck size={18} />
          </span>
          <h2 id="consent-title" className="text-[17px] font-semibold">
            Send notebook content to Google Gemini?
          </h2>
        </div>
        <div className="space-y-2.5 text-[13.5px] leading-relaxed text-ink-2 select-text">
          <p>
            The AI Tutor runs on Google's Gemini API. When you ask it something, Inkling sends your question and the
            context you include — an image of your lasso selection, or text from the current page — to Google. Nothing
            is sent until you ask.
          </p>
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
