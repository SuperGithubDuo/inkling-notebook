/**
 * AI section of Settings: Gemini key, model choice (free models only, checked
 * against the models the key can use), connection test and data-use consent.
 */
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, KeyRound, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { GEMINI_MODELS, type AiError, type AiModelId, type AiStatus } from '@shared/ai'
import { cx } from '@/components/ui/primitives'
import { GET_KEY_URL, GEMINI_TERMS_URL, useAi } from './aiStore'

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; latencyMs: number } | { kind: 'error'; error: AiError }

export function AiSettings() {
  const status = useAi((s) => s.status)
  const { load, setStatus } = useAi.getState()
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return <LoaderCircle size={16} className="animate-spin text-ink-3" />

  const runTest = async (): Promise<void> => {
    setTest({ kind: 'running' })
    const result = await window.inkling.ai.test()
    setStatus(await window.inkling.ai.status())
    setTest(result.ok ? { kind: 'ok', latencyMs: result.latencyMs } : { kind: 'error', error: result.error })
  }

  const saveKey = async (): Promise<void> => {
    setBusy(true)
    setKeyError(null)
    const result = await window.inkling.ai.setKey(key)
    setBusy(false)
    if ('error' in result) return setKeyError(result.error)
    setStatus(result)
    setKey('')
    await runTest()
  }

  const chooseModel = async (model: AiModelId): Promise<void> => {
    setStatus(await window.inkling.ai.setModel(model))
    setTest({ kind: 'idle' })
  }

  return (
    <div className="space-y-4" data-testid="ai-settings">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[13.5px] font-medium">Google Gemini API key</span>
          <a href={GET_KEY_URL} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
            Get a free key
          </a>
        </div>
        {status.hasKey ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-[#fafafb] px-3 py-2">
            <KeyRound size={14} className="text-ink-3" />
            <span className="flex-1 text-[13px] text-ink-2" data-testid="ai-key-saved">
              Key ending in <code>…{status.keyHint}</code>
            </span>
            <button type="button" data-testid="ai-key-remove" onClick={async () => setStatus(await window.inkling.ai.clearKey())} className="rounded-lg px-2 py-1 text-[12.5px] text-[#c03a3e] hover:bg-[#fdf0f0]">
              Remove
            </button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) void saveKey()
            }}
          >
            <input
              type="password"
              value={key}
              data-testid="ai-key-input"
              aria-label="Gemini API key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your key (starts with AIza…)"
              onChange={(e) => setKey(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-[13px] outline-none select-text focus:border-accent"
            />
            <button type="submit" data-testid="ai-key-save" disabled={!key.trim() || busy} className="rounded-xl bg-accent px-3.5 text-[13px] font-medium text-white disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}
        {keyError && <p className="mt-1.5 text-[12.5px] text-[#c03a3e]">{keyError}</p>}
        <KeyProtectionNote status={status} />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[13.5px] font-medium">Model</span>
          {status.hasKey && (
            <button type="button" onClick={async () => { await window.inkling.ai.refreshModels(); setStatus(await window.inkling.ai.status()) }} className="flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
              <RefreshCw size={12} /> Check availability
            </button>
          )}
        </div>
        <div role="radiogroup" aria-label="Gemini model" className="space-y-1.5">
          {GEMINI_MODELS.map((m) => {
            const avail = status.models.find((x) => x.id === m.id)?.status ?? 'unknown'
            const selected = status.model === m.id
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`ai-model-${m.id}`}
                onClick={() => void chooseModel(m.id as AiModelId)}
                className={cx('flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left', selected ? 'border-accent bg-accent-softer' : 'border-line hover:bg-[#fafafb]')}
              >
                <span className={cx('mt-0.5 h-4 w-4 shrink-0 rounded-full border-2', selected ? 'border-accent bg-[radial-gradient(circle,var(--color-accent)_40%,transparent_45%)]' : 'border-[#c7cad3]')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    {m.label}
                    <span className="rounded-full bg-[#e9f6ee] px-1.5 py-px text-[10.5px] font-semibold text-[#1f7a46]">FREE TIER</span>
                    {avail === 'available' && <span className="text-[11.5px] font-normal text-[#1f7a46]">available</span>}
                    {avail === 'missing' && <span className="text-[11.5px] font-normal text-[#c03a3e]">not offered to this key</span>}
                  </span>
                  <span className="block text-[12.5px] text-ink-3">{m.description}</span>
                </span>
              </button>
            )
          })}
        </div>
        {status.cooldown && (
          <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-[#9a6200]">
            <CircleAlert size={14} className="mt-px shrink-0" />
            {status.cooldown.reason === 'daily_quota' ? "Today's free requests for this model are used up" : 'Waiting out a rate limit'} until{' '}
            {new Date(status.cooldown.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="ai-test"
          disabled={!status.hasKey || test.kind === 'running'}
          onClick={() => void runTest()}
          className="rounded-xl border border-line px-3.5 py-1.5 text-[13px] font-medium hover:bg-[#fafafb] disabled:opacity-40"
        >
          {test.kind === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        <span data-testid="ai-test-result" className="min-w-0 flex-1 text-[12.5px]">
          {test.kind === 'ok' && (
            <span className="flex items-center gap-1.5 text-[#1f7a46]">
              <CircleCheck size={14} /> Connected ({test.latencyMs} ms). No notebook content was sent.
            </span>
          )}
          {test.kind === 'error' && (
            <span className="flex items-start gap-1.5 text-[#c03a3e]">
              <CircleAlert size={14} className="mt-px shrink-0" /> {test.error.message}
            </span>
          )}
        </span>
      </div>

      <div className="rounded-xl border border-line px-3 py-2.5">
        <label className="flex items-start gap-2.5 text-[13px]">
          <input
            type="checkbox"
            data-testid="ai-consent-toggle"
            checked={status.consented}
            onChange={async (e) => setStatus(await window.inkling.ai.setConsent(e.target.checked))}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span className="text-ink-2">
            <span className="font-medium text-ink">Allow sending notebook content to Google Gemini.</span> On the free tier Google may
            use it to improve its products and human reviewers may read it — don't include sensitive information.{' '}
            <a href={GEMINI_TERMS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Terms
            </a>
          </span>
        </label>
      </div>
    </div>
  )
}

function KeyProtectionNote({ status }: { status: AiStatus }) {
  if (!status.hasKey) return <p className="mt-1.5 text-[12px] text-ink-3">Free from Google AI Studio — no billing needed. Stored encrypted on this computer, never in your notebooks.</p>
  if (status.keyProtection === 'encrypted') return <p className="mt-1.5 text-[12px] text-ink-3">Encrypted with your system keychain. Only Inkling's background process can use it.</p>
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-[#9a6200]" data-testid="ai-key-warning">
      <ShieldAlert size={13} className="mt-px shrink-0" />
      {status.keyProtection === 'weak'
        ? 'No system keyring was found, so the key is saved with weak protection. Install a keyring (e.g. GNOME Keyring or KWallet) for stronger encryption.'
        : 'This system cannot encrypt secrets, so the key is kept only until Inkling closes.'}
    </p>
  )
}
