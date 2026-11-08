import { useEffect } from 'react'

export interface ToastMsg {
  kind: 'ok' | 'error'
  text: string
}

export function Toast({ msg, onDone }: { msg: ToastMsg | null; onDone(): void }) {
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(onDone, msg.kind === 'error' ? 7000 : 3500)
    return () => clearTimeout(t)
  }, [msg, onDone])
  if (!msg) return null
  return (
    <div className={`toast ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
      {msg.text}
    </div>
  )
}
