/** PhonePad's toolbar button and its pairing / status dialog. */
import { Smartphone } from 'lucide-react'
import { Dialog } from '@/app/Dialog'
import { IconButton, cx } from '@/components/ui/primitives'
import type { PhonePadStatus } from '@shared/phonepad'
import { usePhonePad } from './install'

export function PhonePadButton() {
  const state = usePhonePad((s) => s.status.state)
  const open = usePhonePad((s) => s.openDialog)
  const live = state === 'connected' || state === 'reconnecting'
  return (
    <IconButton
      label={live ? (state === 'connected' ? 'PhonePad — phone connected' : 'PhonePad — reconnecting') : 'Connect phone'}
      hint="write with your phone"
      active={live}
      onClick={open}
      data-testid="phonepad-button"
      data-state={state}
    >
      <Smartphone size={19} strokeWidth={1.8} />
      {live && (
        <span
          aria-hidden
          className={cx('absolute top-[6px] right-[6px] h-[7px] w-[7px] rounded-full ring-2 ring-white', state === 'connected' ? 'bg-[#2f9e8f]' : 'animate-pulse bg-[#f2a516]')}
        />
      )}
    </IconButton>
  )
}

export function PhonePadDialog() {
  const { status, dialogOpen, closeDialog } = usePhonePad()
  if (!dialogOpen) return null
  return (
    <Dialog title="PhonePad" onClose={closeDialog} width={620} testId="phonepad-dialog">
      <p className="-mt-2 mb-5 text-[14px] text-ink-2">Turn your phone into a wireless writing tablet.</p>
      <Body status={status} />
    </Dialog>
  )
}

function Body({ status }: { status: PhonePadStatus }) {
  const { start, disconnect, busy } = usePhonePad()
  if (status.state === 'off' || busy) return <p className="py-10 text-center text-[14px] text-ink-3">Starting…</p>
  if (status.state === 'error') {
    return (
      <div className="space-y-4" data-testid="phonepad-error">
        <p className="rounded-xl bg-[#fdf3f3] px-4 py-3 text-[14px] text-[#9f2d31]">{status.message}</p>
        <button type="button" onClick={() => void start()} className="rounded-[10px] bg-accent px-4 py-2 text-[14px] font-medium text-white hover:bg-accent-strong">
          Try again
        </button>
      </div>
    )
  }
  if (status.state === 'pairing') return <Pairing status={status} />
  const connected = status.state === 'connected'
  return (
    <div data-testid="phonepad-connected" data-state={status.state}>
      <div className="mb-5 flex items-center gap-3 rounded-xl border border-line px-4 py-3">
        <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', connected ? 'bg-[#2f9e8f]' : 'animate-pulse bg-[#f2a516]')} />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium">{connected ? `Connected to ${status.device}` : `Waiting for ${status.device} to reconnect…`}</p>
          <p className="text-[12.5px] text-ink-3">
            {connected ? 'Write on your phone; the ink appears on the open page.' : 'Writing on the phone is kept and sent once it’s back on the network.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void disconnect()}
          data-testid="phonepad-disconnect"
          className="shrink-0 rounded-[10px] border border-line px-3.5 py-1.5 text-[13.5px] font-medium text-ink-2 hover:bg-[#f7f7f9]"
        >
          Disconnect
        </button>
      </div>
      <ul className="space-y-2.5 text-[13.5px] text-ink-2">
        <li>The blue PhonePad frame on the page shows where your phone writes.</li>
        <li>Pinch with two fingers on the phone to zoom in for small writing; drag with two fingers to move the frame.</li>
        <li>Your pen colour and thickness here are used on the phone. Undo works from either device.</li>
        <li>Using a stylus? After its first stroke, fingers move the page instead of writing, so a resting hand doesn’t leave marks.</li>
      </ul>
    </div>
  )
}

function Pairing({ status }: { status: Extract<PhonePadStatus, { state: 'pairing' }> }) {
  const { start } = usePhonePad()
  const pad = 2
  const box = status.qr.size + pad * 2
  return (
    <div className="flex gap-6 max-[600px]:flex-col" data-testid="phonepad-pairing" data-url={status.url}>
      <div className="shrink-0 self-start rounded-2xl border border-line bg-white p-3">
        <svg width={208} height={208} viewBox={`${-pad} ${-pad} ${box} ${box}`} role="img" aria-label="QR code to connect your phone" shapeRendering="crispEdges">
          <rect x={-pad} y={-pad} width={box} height={box} fill="#ffffff" />
          <path d={status.qr.path} fill="#1f2430" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <ol className="space-y-3 text-[14px]">
          <Step n={1}>Connect your phone to the same Wi-Fi as this computer.</Step>
          <Step n={2}>Point your phone’s camera at the code and open the link.</Step>
          <Step n={3}>Write. Your handwriting appears on this page.</Step>
        </ol>
        <div className="mt-5 rounded-xl bg-[#f6f6f7] px-4 py-3 text-[13px] text-ink-2">
          Can’t scan? Open <span className="font-medium text-ink select-all">{status.manualUrl}</span> on your phone and enter{' '}
          <span className="font-semibold tracking-wider text-ink select-all" data-testid="phonepad-code">
            {status.code}
          </span>
        </div>
        {status.addresses.length > 1 && (
          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-3">
            Network
            <select
              value={status.host}
              onChange={(e) => void start(e.target.value)}
              className="rounded-lg border border-line bg-white px-2 py-1 text-[12.5px] text-ink-2"
            >
              {status.addresses.map((a) => (
                <option key={a.host} value={a.host}>
                  {a.label} · {a.host}
                </option>
              ))}
            </select>
          </label>
        )}
        <details className="mt-3 text-[12.5px] text-ink-3">
          <summary className="cursor-pointer select-none hover:text-ink-2">Phone can’t connect?</summary>
          <ul className="mt-2 list-disc space-y-1.5 pl-4">
            <li>Check both devices are on the same Wi-Fi. Guest networks and some school or office networks keep devices from seeing each other.</li>
            <li>If your computer asks whether Inkling may accept connections, allow it on private networks.</li>
            <li>If this computer is on several networks, pick the one your phone uses above.</li>
            <li>The phone connects straight to this computer: nothing goes through the internet.</li>
          </ul>
        </details>
      </div>
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{n}</span>
      <span className="text-ink">{children}</span>
    </li>
  )
}
