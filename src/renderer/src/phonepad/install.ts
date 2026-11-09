/**
 * Connects PhonePad to the running app: the main process's events, the
 * notebook store and the mounted page canvas. Also holds the connection
 * status for the toolbar and pairing dialog.
 */
import { create } from 'zustand'
import type { PhonePadStatus } from '@shared/phonepad'
import { selectActiveKind, useStore } from '@/store/store'
import { activeCanvas, renderPageRegionPng } from '@/canvas/stageRef'
import { PhonePadController } from './controller'

interface PhonePadUi {
  status: PhonePadStatus
  dialogOpen: boolean
  busy: boolean
  openDialog(): void
  closeDialog(): void
  /** Starts pairing (or switches network); keeps a connected phone. */
  start(host?: string): Promise<void>
  disconnect(): Promise<void>
}

export const usePhonePad = create<PhonePadUi>()((set, get) => ({
  status: { state: 'off' },
  dialogOpen: false,
  busy: false,
  openDialog() {
    set({ dialogOpen: true })
    const s = get().status.state
    if (s === 'off' || s === 'error') void get().start()
  },
  closeDialog() {
    set({ dialogOpen: false })
    // Closing before a phone connected: nothing should stay listening on the network.
    if (get().status.state === 'pairing' || get().status.state === 'error') void window.inkling.phonepad.stop()
  },
  async start(host) {
    set({ busy: true })
    try {
      set({ status: await window.inkling.phonepad.start(host) })
    } finally {
      set({ busy: false })
    }
  },
  async disconnect() {
    set({ status: await window.inkling.phonepad.stop() })
  }
}))

let controller: PhonePadController | null = null

export function installPhonePad(): () => void {
  if (controller || !window.inkling?.phonepad) return () => undefined
  controller = new PhonePadController({
    notebook: {
      target() {
        const s = useStore.getState()
        const pageId = s.activePageId
        if (!pageId || s.view.kind !== 'notebook' || selectActiveKind(s) !== 'canvas' || !s.pages[pageId] || s.lockedPages[pageId]) return null
        const nb = s.library?.notebooks.find((n) => n.id === s.activeNotebookId)
        return { pageId, title: nb?.pages.find((p) => p.id === pageId)?.title || nb?.name || 'Untitled page' }
      },
      page: (pageId) => useStore.getState().pages[pageId],
      pen() {
        const s = useStore.getState()
        return { color: s.penColor, size: s.penSize, precise: s.eraserMode === 'precise' }
      },
      // The phone's pen choice becomes the computer's pen setting (without touching any selection).
      setPen: (color, size) => useStore.setState({ penColor: color, penSize: size }),
      run: (commands, options) => useStore.getState().run(commands, options),
      undo: () => useStore.getState().undo(),
      redo: () => useStore.getState().redo(),
      shift: (pageId) => useStore.getState().pageShifts[pageId],
      subscribe(fn) {
        // Page content and size, the open page, and the pen: what the phone shows and writes with.
        return useStore.subscribe((s, prev) => {
          const pageId = s.activePageId
          if (
            s.activePageId !== prev.activePageId ||
            s.view !== prev.view ||
            (pageId && s.pages[pageId] !== prev.pages[pageId]) ||
            s.pageShifts !== prev.pageShifts ||
            s.penColor !== prev.penColor ||
            s.penSize !== prev.penSize ||
            s.eraserMode !== prev.eraserMode ||
            s.library !== prev.library
          )
            fn()
        })
      }
    },
    canvas: {
      camera: () => activeCanvas.handle?.camera() ?? null,
      setCamera: (cam) => activeCanvas.handle?.setCamera(cam)
    },
    send: (message) => window.inkling.phonepad.send(message),
    render: (page, rect, pixelRatio) => renderPageRegionPng(page, rect, pixelRatio, 0, { type: 'image/jpeg', quality: 0.82 })
  })
  controller.start()
  const off = window.inkling.phonepad.onEvent((event) => {
    if (event.type === 'status') {
      const was = usePhonePad.getState().status.state
      usePhonePad.setState({ status: event.status })
      // The phone is in: get the dialog out of the way of the page.
      if (event.status.state === 'connected' && was === 'pairing') usePhonePad.setState({ dialogOpen: false })
    }
    controller?.handle(event)
  })
  void window.inkling.phonepad.status().then((status) => {
    usePhonePad.setState({ status })
    controller?.handle({ type: 'status', status })
  })
  return () => {
    off()
    controller?.dispose()
    controller = null
  }
}

/** For acceptance tests (INKLING_TEST_HOOKS) only. */
export const phonePadForTests = (): PhonePadController | null => controller
