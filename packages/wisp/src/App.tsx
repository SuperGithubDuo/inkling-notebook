import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WispController } from './core/wispController'
import { loadSettings, saveSettings, type WispSettings } from './core/settings'
import type { GestureState } from './gestures/gestureState'
import type { WebcamStatus } from './input/webcamInput'
import type { PenStyle } from './strokes/types'
import { Toolbar } from './components/Toolbar'
import { CameraPanel } from './components/CameraPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Onboarding, hasSeenOnboarding, markOnboardingSeen } from './components/Onboarding'
import { StatusPill } from './components/StatusPill'
import { Toast, type ToastMsg } from './components/Toast'

const INITIAL_PEN: PenStyle = { color: '#1f2430', width: 4 }
const OFF_STATUS: WebcamStatus = { camera: 'off', tracker: 'idle', error: null, delegate: null, modelSource: null }

export function App() {
  const [settings, setSettings] = useState<WispSettings>(loadSettings)
  const [pen, setPen] = useState<PenStyle>(INITIAL_PEN)
  const [ctl] = useState(() => new WispController(loadSettings(), INITIAL_PEN))
  const [mode, setMode] = useState(ctl.mode)
  const [status, setStatus] = useState<WebcamStatus>(OFF_STATUS)
  const [gesture, setGesture] = useState<GestureState>('no-hand')
  const [writing, setWriting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding())
  const [toast, setToast] = useState<ToastMsg | null>(null)
  // Bumped after mount so children re-read ctl.webcamInput (recreated on each mount).
  const [, setMounted] = useState(0)
  const canvasHost = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const { doc, history } = useSyncExternalStore(ctl.store.subscribe, ctl.store.getSnapshot)

  // Mount the controller once; tear everything down on unmount (camera, loops, listeners).
  useEffect(() => {
    ctl.mount(canvasHost.current!, video.current!)
    const cam = ctl.webcamInput!
    const offs = [
      cam.events.on('status', setStatus),
      ctl.engine.onGestureChange((e) => setGesture(e.to)),
      ctl.engine.onStrokeStart(() => setWriting(true)),
      ctl.engine.onStrokeEnd(() => setWriting(false))
    ]
    setMounted((n) => n + 1)
    return () => {
      offs.forEach((o) => o())
      ctl.unmount()
      setStatus(OFF_STATUS)
      setGesture('no-hand')
    }
  }, [ctl])

  const updateSettings = useCallback(
    (patch: Partial<WispSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        saveSettings(next)
        ctl.applySettings(next)
        return next
      })
    },
    [ctl]
  )

  const updatePen = (patch: Partial<PenStyle>) => {
    const next = { ...pen, ...patch }
    setPen(next)
    ctl.setPen(next)
  }

  const switchMode = (m: 'webcam' | 'mouse') => {
    ctl.setMode(m)
    setMode(m)
    if (m === 'mouse') setGesture('no-hand')
  }

  const startWebcam = () => {
    setMode('webcam')
    void ctl.startWebcam()
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) ctl.redo()
        else ctl.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        ctl.redo()
      } else if (e.key === 'Escape') {
        setShowSettings(false)
        ctl.webcamInput?.cancelCalibration()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctl])

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

  const exportJson = () => {
    download(new Blob([ctl.exportJson()], { type: 'application/json' }), `wisp-${stamp()}.json`)
    setToast({ kind: 'ok', text: 'Exported strokes as JSON.' })
  }
  const exportPng = async () => {
    try {
      download(await ctl.exportPng(), `wisp-${stamp()}.png`)
      setToast({ kind: 'ok', text: 'Exported a PNG image.' })
    } catch {
      setToast({ kind: 'error', text: 'PNG export failed.' })
    }
  }
  const importJson = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      setToast({ kind: 'error', text: 'That file is too large to be a WISP drawing.' })
      return
    }
    const res = ctl.importJson(await file.text())
    if (res.ok) {
      const n = res.doc.strokes.length
      setToast({ kind: 'ok', text: `Imported ${n} stroke${n === 1 ? '' : 's'}${res.warnings.length ? ` (${res.warnings.length} fixed)` : ''}. Undo restores the previous page.` })
    } else {
      setToast({ kind: 'error', text: `Couldn't import: ${res.error}` })
    }
  }

  const pointCount = doc.strokes.reduce((n, s) => n + s.points.length, 0)

  return (
    <div className="app">
      <Toolbar
        mode={mode}
        onMode={switchMode}
        pen={pen}
        onPen={updatePen}
        canUndo={history.canUndo && !writing}
        canRedo={history.canRedo && !writing}
        canClear={doc.strokes.length > 0}
        onUndo={() => ctl.undo()}
        onRedo={() => ctl.redo()}
        onClear={() => ctl.clear()}
        onExportJson={exportJson}
        onExportPng={exportPng}
        onImport={importJson}
        onSettings={() => setShowSettings((v) => !v)}
        onHelp={() => setShowOnboarding(true)}
        settingsOpen={showSettings}
        assist={settings.writingMode === 'assist'}
        canTidy={doc.strokes.length >= 3 && !writing}
        canRestore={doc.strokes.some((s) => s.assist) && !writing}
        onTidy={() => {
          const r = ctl.tidyLines()
          const moved = r.straightened + r.aligned
          setToast({ kind: 'ok', text: moved > 0 ? `Tidied ${moved} of ${r.lines} line${r.lines === 1 ? '' : 's'} (undo or Restore original to go back).` : `Nothing to tidy: ${r.lines} line${r.lines === 1 ? '' : 's'} already level, or too short to judge.` })
        }}
        onRestore={() => {
          const n = ctl.restoreOriginal()
          setToast({ kind: 'ok', text: `Restored ${n} stroke${n === 1 ? '' : 's'} to exactly where you wrote them.` })
        }}
      />
      <div className="workspace">
        <main className="stage">
          <div ref={canvasHost} className={`canvas-host ${mode === 'mouse' ? 'is-mouse' : ''}`} />
          <StatusPill mode={mode} status={status} gesture={gesture} writing={writing} />
          {showSettings && <SettingsPanel settings={settings} onChange={updateSettings} onClose={() => setShowSettings(false)} />}
        </main>
        <CameraPanel
          videoRef={video}
          ctl={ctl}
          mode={mode}
          status={status}
          settings={settings}
          strokeCount={doc.strokes.length}
          pointCount={pointCount}
          onStart={startWebcam}
          onStop={() => ctl.stopWebcam()}
          onUseMouse={() => switchMode('mouse')}
          onSettings={updateSettings}
        />
      </div>
      {showOnboarding && (
        <Onboarding
          onWebcam={() => {
            markOnboardingSeen()
            setShowOnboarding(false)
            startWebcam()
          }}
          onMouse={() => {
            markOnboardingSeen()
            setShowOnboarding(false)
            switchMode('mouse')
          }}
          onClose={() => {
            markOnboardingSeen()
            setShowOnboarding(false)
          }}
        />
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </div>
  )
}
