/** An AI error with the actions that can fix it: retry, switch to a suggested model, or open settings. */
import type { ReactNode } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { modelLabel, type AiError } from '@shared/ai'
import { cx } from '@/components/ui/primitives'
import { useAi } from './aiStore'
import { useTutor } from './tutorStore'

const SETTINGS_CODES = new Set(['no_key', 'invalid_key', 'consent_required', 'not_free', 'model_unavailable', 'offline'])
const NO_RETRY = new Set(['no_key', 'consent_required', 'duplicate', 'invalid_key'])

export function ErrorCard({ error, messageId, onOpenSettings, onRetry }: { error: AiError; messageId?: string; onOpenSettings: () => void; onRetry?: () => void }) {
  const running = useTutor((s) => !!s.running)
  const retry = onRetry ?? (messageId ? () => void useTutor.getState().retry(messageId) : undefined)
  const quota = error.code === 'daily_quota' || error.code === 'rate_limited'
  return (
    <div data-testid="tutor-error" data-code={error.code} className={cx('rounded-[12px] border px-3 py-2.5 text-[13px]', quota ? 'border-[#f3d39a] bg-[#fff8e8]' : 'border-[#f2c9ca] bg-[#fdf3f3]')}>
      <div className="flex items-start gap-2">
        <CircleAlert size={15} className={cx('mt-0.5 shrink-0', quota ? 'text-[#c27c0e]' : 'text-[#c03a3e]')} />
        <span className="leading-relaxed text-ink">{error.message}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
        {error.suggestModel && (
          <Action
            testId="tutor-switch-model"
            onClick={async () => {
              useAi.getState().setStatus(await window.inkling.ai.setModel(error.suggestModel!))
              retry?.()
            }}
          >
            Use {modelLabel(error.suggestModel)}
            {error.suggestModel.startsWith('gemini') ? ' (free)' : ''}
          </Action>
        )}
        {retry && !NO_RETRY.has(error.code) && (
          <Action testId="tutor-retry" disabled={running} onClick={retry}>
            <RotateCcw size={12} /> Try again
          </Action>
        )}
        {SETTINGS_CODES.has(error.code) && <Action onClick={onOpenSettings}>Open AI settings</Action>}
      </div>
    </div>
  )
}

function Action({ children, onClick, testId, disabled }: { children: ReactNode; onClick: () => void; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[12.5px] font-medium text-accent shadow-[0_0_0_1px_#e3e5ea] hover:bg-accent-softer disabled:opacity-50">
      {children}
    </button>
  )
}

