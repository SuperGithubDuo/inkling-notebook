/**
 * AI section of Settings: which provider answers (local Ollama by default, or
 * Google Gemini for adults), then that provider's setup. Ollama: whether it
 * runs, which vision models are installed and how to install one, model
 * choice and a connection test. Gemini: key, model choice (free models only,
 * checked against the models the key can use), connection test and consent.
 * Nothing is installed or downloaded from here.
 */
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, Cpu, KeyRound, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { GEMINI_ELIGIBILITY, GEMINI_MODELS, OLLAMA_MODELS, PROVIDERS, type AiError, type AiModelId, type AiProviderId, type AiStatus, type ModelAvailability } from '@shared/ai'
import { cx } from '@/components/ui/primitives'
import { GET_KEY_URL, GEMINI_TERMS_URL, OLLAMA_DOWNLOAD_URL, useAi } from './aiStore'

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; latencyMs: number } | { kind: 'error'; error: AiError }

export function AiSettings() {
  const status = useAi((s) => s.status)
  const { load, setStatus } = useAi.getState()
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return <LoaderCircle size={16} className="animate-spin text-ink-3" />

  const chooseProvider = async (provider: AiProviderId): Promise<void> => {
    if (provider === status.provider) return
    setSwitching(true)
    setStatus(await window.inkling.ai.setProvider(provider))
    setSwitching(false)
  }

  return (
    <div className="space-y-4" data-testid="ai-settings" data-provider={status.provider}>
      <div role="radiogroup" aria-label="AI provider" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {(['ollama', 'gemini'] as const).map((id) => {
          const selected = status.provider === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={switching}
              data-testid={`ai-provider-${id}`}
              onClick={() => void chooseProvider(id)}
              className={cx('flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left', selected ? 'border-accent bg-accent-softer' : 'border-line hover:bg-[#fafafb]')}
            >
              <span className={cx('mt-0.5 h-4 w-4 shrink-0 rounded-full border-2', selected ? 'border-accent bg-[radial-gradient(circle,var(--color-accent)_40%,transparent_45%)]' : 'border-[#c7cad3]')} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                  {PROVIDERS[id].label}
                  {id === 'ollama' ? (
                    <span className="rounded-full bg-[#e9f6ee] px-1.5 py-px text-[10.5px] font-semibold text-[#1f7a46]">DEFAULT</span>
                  ) : (
                    <span className="rounded-full bg-[#fff1dc] px-1.5 py-px text-[10.5px] font-semibold text-[#9a6200]">18+</span>
                  )}
                </span>
                <span className="block text-[12.5px] text-ink-3">{PROVIDERS[id].description}</span>
              </span>
            </button>
          )
        })}
      </div>
      {status.provider === 'ollama' ? <OllamaSettings status={status} /> : <GeminiSettings status={status} />}
    </div>
  )
}

// ------------------------------------------------------------------ Ollama

const fmtSize = (bytes?: number): string | null => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : null)

function OllamaSettings({ status }: { status: AiStatus }) {
  const { setStatus } = useAi.getState()
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)
  const selected = status.models.find((m) => m.id === status.model)
  const running = status.ollama.running

  const refresh = async (): Promise<void> => {
    setChecking(true)
    await window.inkling.ai.refreshModels()
    setStatus(await window.inkling.ai.status())
    setChecking(false)
  }
  const runTest = async (): Promise<void> => {
    setTest({ kind: 'running' })
    const result = await window.inkling.ai.test()
    setStatus(await window.inkling.ai.status())
    setTest(result.ok ? { kind: 'ok', latencyMs: result.latencyMs } : { kind: 'error', error: result.error })
  }
  const choose = async (model: AiModelId): Promise<void> => {
    setStatus(await window.inkling.ai.setModel(model))
    setTest({ kind: 'idle' })
  }

  return (
    <div className="space-y-4" data-testid="ai-ollama">
      <div className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2.5" data-testid="ai-ollama-status" data-running={String(running)}>
        <Cpu size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1 text-[13px]">
          {running === true && (
            <span className="font-medium text-[#1f7a46]">Ollama {status.ollama.version} is running on this computer.</span>
          )}
          {running === false && (
            <>
              <span className="font-medium text-[#c03a3e]">Ollama isn't running.</span>
              <span className="mt-1 block text-ink-2">
                Install it from{' '}
                <a href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  ollama.com/download
                </a>{' '}
                (free), open it, then check again. Inkling looks for it at <code>{status.ollama.url}</code>.
              </span>
            </>
          )}
          {running === null && <span className="text-ink-2">Not checked yet.</span>}
        </div>
        <button type="button" data-testid="ai-ollama-refresh" disabled={checking} onClick={() => void refresh()} className="flex shrink-0 items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink disabled:opacity-50">
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} /> Check again
        </button>
      </div>

      <div>
        <span className="mb-1.5 block text-[13.5px] font-medium">Vision model</span>
        <div role="radiogroup" aria-label="Ollama model" className="space-y-1.5">
          {status.models.map((m) => (
            <OllamaModelRow key={m.id} m={m} selected={status.model === m.id} running={running} onChoose={() => void choose(m.id)} />
          ))}
        </div>
        {selected?.status === 'missing' && running && (
          <div className="mt-2 rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-3 py-2 text-[12.5px] text-ink" data-testid="ai-ollama-install">
            <p>
              <strong>{selected.id}</strong> isn't installed. It's a one-time download
              {OLLAMA_MODELS.find((r) => r.id === selected.id)?.size ? ` of ${OLLAMA_MODELS.find((r) => r.id === selected.id)!.size}` : ''}. Run this in a terminal, then check again:
            </p>
            <CopyCommand command={`ollama pull ${selected.id}`} />
          </div>
        )}
        {selected?.vision === false && (
          <p className="mt-2 text-[12.5px] text-[#c03a3e]">{selected.id} can't read images, so the tutor couldn't see your handwriting. Choose a vision model.</p>
        )}
      </div>

      <TestRow test={test} disabled={running === false} onTest={() => void runTest()} okText={(ms) => `Model answered in ${(ms / 1000).toFixed(1)} s (it stays loaded for a few minutes). Nothing left this computer.`} />

      <p className="rounded-xl bg-[#f6f7f9] px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2" data-testid="ai-local-note">
        <strong className="text-ink">Everything stays on this computer.</strong> Your question and an image of your selection go only to Ollama at{' '}
        <code>{status.ollama.url}</code>. No account, no key, no usage limits and no internet connection needed once a model is installed. Answers take
        longer than cloud models, especially the first one while the model loads, and depend on your computer's speed.
      </p>
    </div>
  )
}

function OllamaModelRow({ m, selected, running, onChoose }: { m: ModelAvailability; selected: boolean; running: boolean | null; onChoose: () => void }) {
  const info = OLLAMA_MODELS.find((r) => r.id === m.id)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`ai-model-${m.id}`}
      data-availability={m.status}
      onClick={onChoose}
      className={cx('flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left', selected ? 'border-accent bg-accent-softer' : 'border-line hover:bg-[#fafafb]')}
    >
      <span className={cx('mt-0.5 h-4 w-4 shrink-0 rounded-full border-2', selected ? 'border-accent bg-[radial-gradient(circle,var(--color-accent)_40%,transparent_45%)]' : 'border-[#c7cad3]')} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-medium">
          {info?.label ?? m.label ?? m.id}
          <code className="text-[11.5px] font-normal text-ink-3">{m.id}</code>
          {m.status === 'available' && <span className="text-[11.5px] font-normal text-[#1f7a46]">installed{fmtSize(m.sizeBytes) ? ` · ${fmtSize(m.sizeBytes)}` : ''}</span>}
          {m.status === 'missing' && running && <span className="text-[11.5px] font-normal text-ink-3">not installed{info?.size ? ` · ${info.size} download` : ''}</span>}
        </span>
        <span className="block text-[12.5px] text-ink-3">{info?.description ?? 'Another vision model installed in Ollama. Untested with Inkling.'}</span>
      </span>
    </button>
  )
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="mt-1.5 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-2 py-1 text-[12.5px] shadow-[0_0_0_1px_#eadbb8] select-text">{command}</code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(command).catch(() => undefined)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-white"
      >
        <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

function TestRow({ test, disabled, onTest, okText }: { test: TestState; disabled: boolean; onTest: () => void; okText: (ms: number) => string }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        data-testid="ai-test"
        disabled={disabled || test.kind === 'running'}
        onClick={onTest}
        className="shrink-0 rounded-xl border border-line px-3.5 py-1.5 text-[13px] font-medium hover:bg-[#fafafb] disabled:opacity-40"
      >
        {test.kind === 'running' ? 'Testing…' : 'Test connection'}
      </button>
      <span data-testid="ai-test-result" className="min-w-0 flex-1 text-[12.5px]">
        {test.kind === 'ok' && (
          <span className="flex items-center gap-1.5 text-[#1f7a46]">
            <CircleCheck size={14} className="shrink-0" /> {okText(test.latencyMs)}
          </span>
        )}
        {test.kind === 'error' && (
          <span className="flex items-start gap-1.5 text-[#c03a3e]">
            <CircleAlert size={14} className="mt-px shrink-0" /> {test.error.message}
          </span>
        )}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ Gemini

function GeminiSettings({ status }: { status: AiStatus }) {
  const { setStatus } = useAi.getState()
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

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
    <div className="space-y-4" data-testid="ai-gemini">
      <p className="flex items-start gap-1.5 rounded-xl border border-[#f3d39a] bg-[#fff8e8] px-3 py-2 text-[12.5px] text-ink" data-testid="ai-gemini-eligibility">
        <ShieldAlert size={14} className="mt-px shrink-0 text-[#9a6200]" />
        <span>{GEMINI_ELIGIBILITY}</span>
      </p>
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

      <TestRow test={test} disabled={!status.hasKey} onTest={() => void runTest()} okText={(ms) => `Connected (${ms} ms). No notebook content was sent.`} />

      <div className="rounded-xl border border-line px-3 py-2.5">
        <label className="flex items-start gap-2.5 text-[13px]">
          <input
            type="checkbox"
            data-testid="ai-consent-toggle"
            checked={status.geminiConsented}
            onChange={async (e) => {
              const checked = e.target.checked
              setStatus({ ...status, consented: checked, geminiConsented: checked })
              setStatus(await window.inkling.ai.setConsent(checked))
            }}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span className="text-ink-2">
            <span className="font-medium text-ink">I'm 18 or older, and allow sending notebook content to Google Gemini.</span> On the free tier Google may
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
