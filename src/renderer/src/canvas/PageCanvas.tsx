/**
 * The interactive page.
 *
 * - Rendering: Konva (MIT). A camera (scale + offset) maps page coordinates to
 *   the screen; everything stored is in page coordinates.
 * - Input: native pointer events. In-progress strokes, lassos and shape drags
 *   are drawn imperatively on a separate layer, so pointer moves never cause
 *   React renders of the page content.
 * - Edits: every change is a typed command run through the store (see
 *   commands.ts), so it validates, saves and undoes like any other edit.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Group, Layer, Rect, Shape, Stage, Transformer } from 'react-konva'
import type Konva from 'konva'
import { newId } from '@shared/factory'
import type { CanvasObject, Point, ShapeKind, StrokeObject, TextObject } from '@shared/schema'
import { useStore, type ShapeTool } from '@/store/store'
import type { CanvasCommand } from './commands'
import { selectionBounds } from './commands'
import { eraserHits, lassoSelects, objectAt, pointInRect, textBounds, TEXT_LINE_HEIGHT, type Vec } from './geometry'
import { outlinePath } from './ink'
import { paperStyle } from './paper'
import { activeCanvas } from './stageRef'
import { FONT_FAMILY, TEXT_DEFAULT_SIZE, TEXT_DEFAULT_WIDTH } from './text'
import { ImageNode, ObjectNode, ShapeNode, StrokeNode } from './nodes'
import { isLineLike, paintShape, shapePathData } from './shapes'
import { cutRuns, densify } from './eraser'
import { assetSize } from './assets'
import { clamp, fitPage, fitWidth, panBy, screenToPage, zoomAt, type Camera, type Size } from './viewport'
import { SelectionToolbar } from './SelectionToolbar'
import { ZoomControls } from './ZoomControls'

const EMPTY: ReadonlySet<string> = new Set()
const HIGHLIGHTER_OPACITY = 0.45
const ACCENT = '#2f6be4'

type Draft = { object: TextObject; isNew: boolean }
type Live =
  | { kind: 'ink'; path: Path2D; color: string; opacity: number; highlighter: boolean }
  | { kind: 'lasso'; points: Vec[] }
  | { kind: 'shape'; shape: ShapeKind; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fill: string | null }
  | null

type StrokeStyle = Omit<StrokeObject, 'points' | 'id' | 'createdAt' | 'author' | 'type'>
type Gesture =
  | { kind: 'draw'; pointerId: number; touch: boolean; points: Point[]; style: StrokeStyle }
  | { kind: 'erase'; pointerId: number; touch: boolean; last: Point; hits: Set<string>; pieces: Map<string, Point[][]>; precise: boolean }
  | { kind: 'lasso'; pointerId: number; touch: boolean; points: Vec[]; additive: boolean }
  | { kind: 'shape'; pointerId: number; touch: boolean; start: Vec; end: Vec }
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { kind: 'pinch'; startDist: number; startMid: Vec; startCam: Camera }
  | { kind: 'blocked' }

export function PageCanvas({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId])!
  const tool = useStore((s) => s.tool)
  const eraserSize = useStore((s) => s.eraserSize)
  const selection = useStore((s) => s.selection)
  const run = useStore((s) => s.run)
  const setSelection = useStore((s) => s.setSelection)

  const container = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const worldRef = useRef<Konva.Group>(null)
  const liveShape = useRef<Konva.Shape>(null)
  const selGroup = useRef<Konva.Group>(null)
  const singleNode = useRef<Konva.Shape | Konva.Image>(null)
  const transformer = useRef<Konva.Transformer>(null)
  const eraserCursor = useRef<HTMLDivElement>(null)
  const textArea = useRef<HTMLTextAreaElement>(null)

  const [view, setView] = useState<Size>({ width: 0, height: 0 })
  const [cam, setCamState] = useState<Camera | null>(null)
  const camRef = useRef<Camera | null>(null)
  const fitMode = useRef<'width' | 'page' | null>('width')
  const pendingCam = useRef<Camera | null>(null)
  const camFrame = useRef(0)

  const [erasePreview, setErasePreview] = useState<{ hidden: ReadonlySet<string>; extra: StrokeObject[] }>({ hidden: EMPTY, extra: [] })
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft
  const [interacting, setInteracting] = useState(false)
  const [panning, setPanning] = useState(false)

  const live = useRef<Live>(null)
  const gesture = useRef<Gesture | null>(null)
  const touches = useRef(new Map<number, Vec>())
  const frame = useRef(0)
  const penSeenAt = useRef(0)
  const spaceDown = useRef(false)
  /** Shift held during a shape drag: squares, circles, 45° lines. */
  const constrain = useRef(false)

  const pageSize = useMemo(() => ({ width: page.width, height: page.height }), [page.width, page.height])
  const selSet = useMemo(() => new Set(selection), [selection])

  // ---- Camera --------------------------------------------------------------

  const setCam = useCallback((next: Camera, mode: 'width' | 'page' | null = null) => {
    fitMode.current = mode
    camRef.current = next
    pendingCam.current = next
    if (camFrame.current) return
    camFrame.current = requestAnimationFrame(() => {
      camFrame.current = 0
      if (pendingCam.current) setCamState(pendingCam.current)
    })
  }, [])

  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const update = (): void => setView({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit on first layout and on page-size changes; keep fit modes on resize.
  useLayoutEffect(() => {
    if (!view.width || !view.height) return
    const prev = camRef.current
    let next: Camera
    if (!prev || fitMode.current === 'width') next = fitWidth(pageSize, view)
    else if (fitMode.current === 'page') next = fitPage(pageSize, view)
    else next = clamp(prev, pageSize, view)
    camRef.current = next
    setCamState(next)
  }, [view, pageSize])

  const zoomBy = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      const c = camRef.current
      if (!c) return
      setCam(zoomAt(c, factor, sx ?? view.width / 2, sy ?? view.height / 2, pageSize, view))
    },
    [pageSize, view, setCam]
  )

  const zoomAction = useCallback(
    (action: 'in' | 'out' | 'fit-width' | 'fit-page') => {
      if (action === 'in') zoomBy(1.25)
      else if (action === 'out') zoomBy(0.8)
      else if (action === 'fit-width') setCam(fitWidth(pageSize, view), 'width')
      else setCam(fitPage(pageSize, view), 'page')
    },
    [zoomBy, setCam, pageSize, view]
  )

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms at the pointer; plain wheel pans.
  useEffect(() => {
    const el = container.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const c = camRef.current
      if (!c) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * unit * 0.0025), e.clientX - r.left, e.clientY - r.top)
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        setCam(panBy(c, -dx * unit, -dy * unit, pageSize, view))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy, setCam, pageSize, view])

  // ---- Coordinates ---------------------------------------------------------

  const local = (e: { clientX: number; clientY: number }): Vec => {
    const r = container.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const toPage = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }): Point => {
    const [sx, sy] = local(e)
    const [x, y] = screenToPage(camRef.current!, sx, sy)
    return e.pointerType === 'pen' ? [x, y, Math.min(1, Math.max(0, e.pressure))] : [x, y]
  }

  // ---- Live layer ----------------------------------------------------------

  const redrawLive = useCallback((extra: Point[] = []) => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const g = gesture.current
      if (g?.kind === 'draw') {
        live.current = {
          kind: 'ink',
          path: new Path2D(outlinePath([...g.points, ...extra], g.style, false)),
          color: g.style.color,
          opacity: g.style.opacity,
          highlighter: g.style.tool === 'highlighter'
        }
      } else if (g?.kind === 'lasso') {
        live.current = { kind: 'lasso', points: g.points }
      } else if (g?.kind === 'shape') {
        const s = useStore.getState()
        const box = shapeBox(s.shapeTool, g.start, g.end, constrain.current)
        live.current = {
          kind: 'shape',
          shape: box.kind,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          color: s.penColor,
          strokeWidth: s.penSize,
          fill: s.shapeFill && !isLineLike(box) ? s.penColor : null
        }
      } else live.current = null
      liveShape.current?.getLayer()?.batchDraw()
    })
  }, [])

  // ---- Commands ------------------------------------------------------------

  const exec = useCallback(
    (commands: CanvasCommand[], label: string) => {
      const result = run(commands, { label, pageId })
      if (!result.ok) console.error(result.error)
      return result
    },
    [run, pageId]
  )

  // ---- Text editing --------------------------------------------------------

  const commitDraft = useCallback(() => {
    const d = draftRef.current
    if (!d) return
    draftRef.current = null
    setDraft(null)
    const value = (textArea.current?.value ?? d.object.text).replace(/\s+$/, '')
    if (d.isNew) {
      if (value.trim()) {
        const { x, y, width, color, fontSize, font } = d.object
        exec([{ type: 'createText', id: d.object.id, text: { x, y, width, color, fontSize, font, text: value } }], 'Add text')
      }
      return
    }
    const original = useStore.getState().pages[pageId]?.objects.find((o) => o.id === d.object.id)
    if (!original || original.type !== 'text') return
    if (!value.trim()) exec([{ type: 'deleteObjects', ids: [original.id] }], 'Delete text')
    else if (value !== original.text) exec([{ type: 'updateObject', id: original.id, patch: { text: value } }], 'Edit text')
  }, [exec, pageId])

  useEffect(() => commitDraft, [commitDraft])
  useEffect(() => {
    if (tool !== 'text') commitDraft()
  }, [tool, commitDraft])

  useLayoutEffect(() => {
    const ta = textArea.current
    if (!draft || !ta) return
    ta.style.height = '0px'
    ta.style.height = `${ta.scrollHeight}px`
    ta.focus({ preventScroll: true })
  }, [draft, cam])

  function startText(at: Point): void {
    const s = useStore.getState()
    const hit = [...page.objects]
      .reverse()
      .find((o): o is TextObject => o.type === 'text' && pointInRect(at[0], at[1], { ...textBounds(o), x: o.x - 6, y: o.y - 6 }))
    if (hit) {
      setDraft({ object: hit, isNew: false })
      return
    }
    const fontSize = TEXT_DEFAULT_SIZE
    const x = Math.max(8, Math.min(at[0], page.width - 60))
    setDraft({
      isNew: true,
      object: {
        id: newId(),
        type: 'text',
        author: 'user',
        createdAt: Date.now(),
        x,
        y: Math.max(4, at[1] - fontSize * 0.65),
        width: Math.max(80, Math.min(TEXT_DEFAULT_WIDTH, page.width - x - 24)),
        text: '',
        color: s.penColor,
        fontSize,
        font: 'sans'
      }
    })
  }

  // ---- Selection transforms -----------------------------------------------

  const selected = useMemo(() => page.objects.filter((o) => selSet.has(o.id)), [page.objects, selSet])
  const singleMode =
    selected.length === 1 && (selected[0]!.type === 'image' || (selected[0]!.type === 'shape' && !isLineLike(selected[0]!)))

  useEffect(() => {
    const tr = transformer.current
    if (!tr) return
    const node = singleMode ? singleNode.current : selected.length ? selGroup.current : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selected, singleMode, cam])

  const commitGroupTransform = useCallback(() => {
    const g = selGroup.current
    setInteracting(false)
    if (!g) return
    const a = { sx: g.scaleX(), sy: g.scaleY(), tx: g.x(), ty: g.y() }
    const ids = useStore.getState().selection
    if (ids.length && (a.sx !== 1 || a.sy !== 1 || a.tx !== 0 || a.ty !== 0)) {
      flushSync(() => {
        exec([{ type: 'transformObjects', ids, ...a }], a.sx === 1 && a.sy === 1 ? 'Move' : 'Resize')
      })
    }
    g.position({ x: 0, y: 0 })
    g.scale({ x: 1, y: 1 })
    transformer.current?.forceUpdate()
  }, [exec])

  const commitSingleTransform = useCallback(() => {
    const n = singleNode.current
    setInteracting(false)
    const id = useStore.getState().selection[0]
    if (!n || !id) return
    const patch = {
      x: n.x(),
      y: n.y(),
      width: Math.max(1, n.width() * n.scaleX()),
      height: Math.max(1, n.height() * n.scaleY()),
      rotation: Math.round(n.rotation() * 100) / 100
    }
    flushSync(() => {
      exec([{ type: 'updateObject', id, patch }], 'Transform')
    })
    n.scale({ x: 1, y: 1 })
    transformer.current?.forceUpdate()
  }, [exec])

  // ---- Images --------------------------------------------------------------

  const placeImage = useCallback(
    async (asset: string, at?: Vec) => {
      const c = camRef.current
      if (!c) return
      const natural = await assetSize(page.notebookId, asset)
      const [vx0, vy0] = screenToPage(c, 0, 0)
      const [vx1, vy1] = screenToPage(c, view.width, view.height)
      const maxW = Math.min(page.width * 0.6, (vx1 - vx0) * 0.6)
      const k = Math.min(1, maxW / natural.width, (page.height * 0.6) / natural.height)
      const width = Math.max(8, natural.width * k)
      const height = Math.max(8, natural.height * k)
      const cx = at?.[0] ?? (Math.max(vx0, 0) + Math.min(vx1, page.width)) / 2
      const cy = at?.[1] ?? (Math.max(vy0, 0) + Math.min(vy1, page.height)) / 2
      const x = Math.max(0, Math.min(page.width - width, cx - width / 2))
      const y = Math.max(0, Math.min(page.height - height, cy - height / 2))
      const result = exec(
        [{ type: 'createImage', image: { asset, x, y, width, height, naturalWidth: natural.width, naturalHeight: natural.height } }],
        'Insert image'
      )
      if (result.ok) {
        useStore.setState({ tool: 'lasso' })
        setSelection(result.created)
      }
    },
    [exec, page.notebookId, page.width, page.height, view, setSelection]
  )

  useEffect(() => {
    activeCanvas.handle = { world: () => worldRef.current, placeImage, zoom: zoomAction }
    return () => {
      activeCanvas.handle = null
    }
  }, [placeImage, zoomAction])

  async function insertImageBytes(file: File, at?: Vec): Promise<void> {
    const result = await window.inkling.saveImageBytes(page.notebookId, new Uint8Array(await file.arrayBuffer()))
    if ('asset' in result) await placeImage(result.asset, at)
    else if ('error' in result) window.alert(result.error)
  }

  // Paste: images from the system clipboard, otherwise Inkling's own clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      e.preventDefault()
      if (file) void insertImageBytes(file)
      else useStore.getState().paste()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  // Space held = temporary hand tool.
  useEffect(() => {
    const editable = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !editable(e.target) && !e.repeat) {
        spaceDown.current = true
        setPanning(true)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceDown.current = false
        setPanning(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ---- Pointer input -------------------------------------------------------

  function cancelGesture(): void {
    const g = gesture.current
    gesture.current = null
    if (g?.kind === 'erase') setErasePreview({ hidden: EMPTY, extra: [] })
    redrawLive()
  }

  function startPinch(): void {
    const [a, b] = [...touches.current.values()]
    if (!a || !b || !camRef.current) return
    gesture.current = {
      kind: 'pinch',
      startDist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])),
      startMid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      startCam: camRef.current
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const c = camRef.current
    if (!c) return
    const s = useStore.getState()
    const isTouch = e.pointerType === 'touch'
    if (e.pointerType === 'pen') penSeenAt.current = Date.now()

    if (isTouch) {
      touches.current.set(e.pointerId, local(e))
      if (touches.current.size === 2) {
        // A second finger means navigation: drop whatever the first finger started.
        const g = gesture.current
        if (!g || ('touch' in g && g.touch) || g.kind === 'pan') {
          cancelGesture()
          startPinch()
        }
        return
      }
      if (touches.current.size > 2 || gesture.current?.kind === 'blocked') return
    }
    if (gesture.current) return
    if (e.pointerType === 'mouse' && e.button === 2) return

    const penRecently = Date.now() - penSeenAt.current < 4000
    const wantsPan =
      (e.pointerType === 'mouse' && e.button === 1) || spaceDown.current || s.tool === 'hand' || (isTouch && penRecently)

    if (!wantsPan) {
      // Let Konva handle drags of the current selection and its handles.
      const stage = stageRef.current
      const [sx, sy] = local(e)
      if (stage && s.selection.length && stage.getIntersection({ x: sx, y: sy })) return
    }

    if (draftRef.current) {
      commitDraft()
      if (s.tool === 'text' && !wantsPan) {
        e.preventDefault()
        return
      }
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    if (wantsPan) {
      gesture.current = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      setPanning(true)
      return
    }

    const p = toPage(e)
    // The stylus's eraser end (or barrel button) erases whatever tool is active.
    const stylusEraser = e.pointerType === 'pen' && (e.buttons & 32) !== 0
    const toolNow = stylusEraser ? 'eraser' : s.tool

    switch (toolNow) {
      case 'text':
        e.preventDefault()
        startText(p)
        return
      case 'eraser':
        gesture.current = {
          kind: 'erase',
          pointerId: e.pointerId,
          touch: isTouch,
          last: p,
          hits: new Set(),
          pieces: new Map(),
          precise: s.eraserMode === 'precise'
        }
        eraseAlong(p, p)
        return
      case 'lasso':
        gesture.current = { kind: 'lasso', pointerId: e.pointerId, touch: isTouch, points: [[p[0], p[1]]], additive: e.shiftKey }
        redrawLive()
        return
      case 'shape':
        gesture.current = { kind: 'shape', pointerId: e.pointerId, touch: isTouch, start: [p[0], p[1]], end: [p[0], p[1]] }
        redrawLive()
        return
      case 'pen':
      case 'highlighter': {
        const hl = toolNow === 'highlighter'
        gesture.current = {
          kind: 'draw',
          pointerId: e.pointerId,
          touch: isTouch,
          points: [p],
          style: {
            tool: hl ? 'highlighter' : 'pen',
            color: hl ? s.highlightColor : s.penColor,
            size: hl ? s.highlightSize : s.penSize,
            opacity: hl ? HIGHLIGHTER_OPACITY : 1,
            hasPressure: e.pointerType === 'pen' && e.pressure > 0
          }
        }
        redrawLive()
        return
      }
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (eraserCursor.current) {
      const [sx, sy] = local(e)
      eraserCursor.current.style.transform = `translate(${sx}px, ${sy}px)`
    }
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, local(e))
    const g = gesture.current
    if (!g) return
    const c = camRef.current!

    if (g.kind === 'pinch') {
      const [a, b] = [...touches.current.values()]
      if (!a || !b) return
      const dist = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]))
      const mid: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const scale = g.startCam.scale * (dist / g.startDist)
      const [px, py] = screenToPage(g.startCam, g.startMid[0], g.startMid[1])
      const next = zoomAt({ scale, x: mid[0] - px * scale, y: mid[1] - py * scale }, 1, mid[0], mid[1], pageSize, view)
      setCam(next)
      return
    }
    if (g.kind === 'blocked' || !('pointerId' in g) || g.pointerId !== e.pointerId) return

    if (g.kind === 'pan') {
      setCam(panBy(c, e.clientX - g.lastX, e.clientY - g.lastY, pageSize, view))
      g.lastX = e.clientX
      g.lastY = e.clientY
      return
    }

    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    const samples = events.length ? events : [e.nativeEvent]
    if (g.kind === 'draw') {
      if (e.shiftKey) {
        // Shift draws a straight line from the starting point.
        const end = toPage(e)
        g.points = densify([g.points[0]!, end], 3)
        redrawLive()
        return
      }
      for (const ev of samples) g.points.push(toPage(ev))
      // Predicted points shorten perceived latency; they are never saved.
      const predicted = (e.nativeEvent.getPredictedEvents?.() ?? []).map(toPage)
      redrawLive(predicted)
    } else if (g.kind === 'erase') {
      for (const ev of samples) {
        const p = toPage(ev)
        eraseAlong(g.last, p)
        g.last = p
      }
    } else if (g.kind === 'lasso') {
      for (const ev of samples) {
        const p = toPage(ev)
        const last = g.points[g.points.length - 1]!
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * c.scale > 2) g.points.push([p[0], p[1]])
      }
      redrawLive()
    } else if (g.kind === 'shape') {
      const p = toPage(e)
      g.end = [p[0], p[1]]
      constrain.current = e.shiftKey
      redrawLive()
    }
  }

  function eraseAlong(a: Point, b: Point): void {
    const g = gesture.current
    if (g?.kind !== 'erase') return
    const c = camRef.current!
    // Eraser size is in screen pixels so it feels the same at every zoom.
    const radius = useStore.getState().eraserSize / c.scale
    let changed = false
    for (const o of useStore.getState().pages[pageId]!.objects) {
      if (g.hits.has(o.id) && !g.pieces.has(o.id)) continue
      if (g.precise && o.type === 'stroke') {
        const runs = g.pieces.get(o.id) ?? [densify(o.points, Math.max(0.75, radius / 3))]
        const cut = cutRuns(runs, a, b, radius + o.size * 0.35)
        if (cut) {
          g.pieces.set(o.id, cut)
          g.hits.add(o.id)
          changed = true
        }
      } else if (!g.hits.has(o.id) && eraserHits(o, a, b, radius)) {
        g.hits.add(o.id)
        changed = true
      }
    }
    if (changed) {
      const objects = useStore.getState().pages[pageId]!.objects
      const extra: StrokeObject[] = []
      for (const [id, runs] of g.pieces) {
        const src = objects.find((o) => o.id === id) as StrokeObject | undefined
        if (src) runs.forEach((points, i) => extra.push({ ...src, id: `${id}-p${i}`, points }))
      }
      setErasePreview({ hidden: new Set(g.hits), extra })
    }
  }

  function finishErase(g: Extract<Gesture, { kind: 'erase' }>): void {
    setErasePreview({ hidden: EMPTY, extra: [] })
    if (!g.hits.size) return
    const objects = useStore.getState().pages[pageId]!.objects
    const commands: CanvasCommand[] = []
    // Work from the top layer down so earlier indices stay valid.
    const hit = objects.map((o, index) => ({ o, index })).filter(({ o }) => g.hits.has(o.id))
    for (const { o, index } of hit.reverse()) {
      commands.push({ type: 'deleteObjects', ids: [o.id] })
      const runs = g.pieces.get(o.id)
      if (runs && o.type === 'stroke') {
        runs.forEach((points, i) => {
          const { color, size, opacity, tool, hasPressure } = o
          commands.push({ type: 'createStroke', index: index + i, stroke: { color, size, opacity, tool, hasPressure, points: simplify(points) } })
        })
      }
    }
    exec(commands, 'Erase')
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const isTouch = e.pointerType === 'touch'
    if (isTouch) touches.current.delete(e.pointerId)
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch' || g.kind === 'blocked') {
      // Stay inert until every finger has lifted, so no stray marks.
      gesture.current = touches.current.size ? { kind: 'blocked' } : null
      return
    }
    if (g.pointerId !== e.pointerId) return
    gesture.current = null
    const s = useStore.getState()

    switch (g.kind) {
      case 'pan':
        setPanning(spaceDown.current)
        return
      case 'draw': {
        const { tool: t, color, size, opacity, hasPressure } = g.style
        exec([{ type: 'createStroke', stroke: { tool: t, color, size, opacity, hasPressure, points: simplify(g.points) } }], t === 'pen' ? 'Draw' : 'Highlight')
        redrawLive()
        return
      }
      case 'erase':
        finishErase(g)
        return
      case 'lasso': {
        redrawLive()
        const objects = s.pages[pageId]!.objects
        const c = camRef.current!
        const span = g.points.reduce((m, p) => Math.max(m, Math.hypot(p[0] - g.points[0]![0], p[1] - g.points[0]![1])), 0) * c.scale
        let ids: string[]
        if (span < 6) {
          // A tap selects the object under it (or clears the selection).
          const hit = objectAt(objects, g.points[0]!, 6 / c.scale)
          ids = hit ? [hit.id] : []
        } else ids = objects.filter((o) => lassoSelects(o, g.points)).map((o) => o.id)
        setSelection(g.additive ? [...new Set([...s.selection, ...ids])] : ids)
        return
      }
      case 'shape': {
        redrawLive()
        const box = shapeBox(s.shapeTool, g.start, g.end, e.shiftKey)
        if (Math.hypot(box.w, box.h) * camRef.current!.scale < 6) return
        exec(
          [
            {
              type: 'createShape',
              shape: {
                kind: box.kind,
                x: box.x,
                y: box.y,
                width: box.w,
                height: box.h,
                color: s.penColor,
                strokeWidth: s.penSize,
                fill: s.shapeFill && !isLineLike(box) ? s.penColor : null
              }
            }
          ],
          'Shape'
        )
        return
      }
    }
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.pointerType === 'touch') touches.current.delete(e.pointerId)
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch' || g.kind === 'blocked' || g.pointerId === e.pointerId) {
      if (g.kind === 'pan') setPanning(spaceDown.current)
      cancelGesture()
    }
  }

  // ---- Render --------------------------------------------------------------

  const groupMode = selected.length > 0 && !singleMode
  const visible = page.objects.filter(
    (o) => !erasePreview.hidden.has(o.id) && o.id !== draft?.object.id && !(groupMode && selSet.has(o.id))
  )
  const selBox = groupMode ? selectionBounds(page.objects, selSet) : null
  const showEraser = tool === 'eraser' && !panning
  const cursor =
    panning || tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'eraser' ? 'none' : tool === 'lasso' ? 'default' : 'crosshair'

  return (
    <div
      ref={container}
      data-testid="canvas-viewport"
      className="relative h-full w-full overflow-hidden bg-[#f1f1f3]"
      style={{ touchAction: 'none', cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(e) => {
        const g = gesture.current
        if (g && 'pointerId' in g && g.pointerId === e.pointerId) onPointerUp(e)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
        if (!files.length || !camRef.current) return
        e.preventDefault()
        const [sx, sy] = local(e)
        const at = screenToPage(camRef.current, sx, sy)
        files.forEach((f, i) => void insertImageBytes(f, [at[0] + i * 24, at[1] + i * 24]))
      }}
    >
      {cam && (
        <>
          <div
            data-testid="page-surface"
            className="pointer-events-none absolute top-0 left-0 shadow-[0_1px_3px_rgb(30_36_60/0.08),0_8px_24px_-12px_rgb(30_36_60/0.18)]"
            style={{
              transform: `translate(${cam.x}px, ${cam.y}px)`,
              width: page.width * cam.scale,
              height: page.height * cam.scale,
              ...paperStyle(page.paper, cam.scale)
            }}
          />
          <Stage ref={stageRef} width={view.width} height={view.height} className="absolute inset-0">
            <Layer>
              <Group ref={worldRef} x={cam.x} y={cam.y} scaleX={cam.scale} scaleY={cam.scale}>
                {visible.map((o: CanvasObject) =>
                  singleMode && o.id === selected[0]!.id ? (
                    o.type === 'image' ? (
                      <ImageNode
                        key={o.id}
                        image={o}
                        notebookId={page.notebookId}
                        nodeRef={singleNode}
                        editable
                        onDragEnd={commitSingleTransform}
                      />
                    ) : (
                      o.type === 'shape' && <ShapeNode key={o.id} shape={o} nodeRef={singleNode} editable onDragEnd={commitSingleTransform} />
                    )
                  ) : (
                    <ObjectNode key={o.id} object={o} notebookId={page.notebookId} />
                  )
                )}
                {erasePreview.extra.map((s) => (
                  <StrokeNode key={s.id} stroke={s} />
                ))}
                {groupMode && selBox && (
                  <Group
                    ref={selGroup}
                    draggable
                    onDragStart={() => setInteracting(true)}
                    onDragEnd={commitGroupTransform}
                  >
                    <Rect x={selBox.x} y={selBox.y} width={selBox.width} height={selBox.height} fill="rgba(47,107,228,0.04)" />
                    {selected.map((o) => (
                      <ObjectNode key={o.id} object={o} notebookId={page.notebookId} />
                    ))}
                  </Group>
                )}
              </Group>
            </Layer>
            <Layer listening={false}>
              <Group x={cam.x} y={cam.y} scaleX={cam.scale} scaleY={cam.scale}>
                <Shape
                  ref={liveShape}
                  listening={false}
                  perfectDrawEnabled={false}
                  sceneFunc={(ctx) => drawLive(ctx._context, live.current, cam.scale)}
                />
              </Group>
            </Layer>
            <Layer>
              <Transformer
                ref={transformer}
                rotateEnabled={singleMode}
                keepRatio={!singleMode}
                enabledAnchors={
                  singleMode
                    ? ['top-left', 'top-center', 'top-right', 'middle-right', 'bottom-right', 'bottom-center', 'bottom-left', 'middle-left']
                    : ['top-left', 'top-right', 'bottom-right', 'bottom-left']
                }
                flipEnabled={false}
                rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
                rotationSnapTolerance={4}
                anchorSize={10}
                anchorCornerRadius={5}
                anchorStroke={ACCENT}
                anchorFill="#ffffff"
                anchorStrokeWidth={1.5}
                borderStroke={ACCENT}
                borderDash={[4, 3]}
                padding={6}
                ignoreStroke
                boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 8 || Math.abs(newBox.height) < 8 ? oldBox : newBox)}
                onTransformStart={() => setInteracting(true)}
                onTransformEnd={singleMode ? commitSingleTransform : commitGroupTransform}
              />
            </Layer>
          </Stage>

          {selected.length > 0 && !interacting && (
            <SelectionToolbar box={selectionBounds(page.objects, selSet)!} cam={cam} view={view} below={singleMode} />
          )}

          {draft && (
            <textarea
              ref={textArea}
              data-testid="text-editor"
              aria-label="Text box"
              defaultValue={draft.object.text}
              spellCheck
              onPointerDown={(e) => e.stopPropagation()}
              onInput={(e) => {
                const ta = e.currentTarget
                ta.style.height = '0px'
                ta.style.height = `${ta.scrollHeight}px`
              }}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  commitDraft()
                }
              }}
              className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline-dashed outline-1 outline-offset-[5px] outline-accent/60"
              style={{
                left: cam.x + draft.object.x * cam.scale,
                top: cam.y + draft.object.y * cam.scale,
                width: draft.object.width * cam.scale,
                fontSize: draft.object.fontSize * cam.scale,
                lineHeight: TEXT_LINE_HEIGHT,
                fontFamily: FONT_FAMILY[draft.object.font],
                color: draft.object.color,
                caretColor: draft.object.color
              }}
            />
          )}

          {showEraser && (
            <div
              ref={eraserCursor}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 rounded-full border border-ink-2/60 bg-white/40"
              style={{
                width: eraserSize * 2,
                height: eraserSize * 2,
                marginLeft: -eraserSize,
                marginTop: -eraserSize,
                transform: 'translate(-100px, -100px)'
              }}
            />
          )}

          <ZoomControls cam={cam} page={pageSize} view={view} onAction={zoomAction} />
        </>
      )}
    </div>
  )
}

/** Box for a shape drag; `constrain` makes squares/circles and 45° lines. */
function shapeBox(tool: ShapeTool, start: Vec, end: Vec, constrain: boolean): { kind: ShapeKind; x: number; y: number; w: number; h: number } {
  let dx = end[0] - start[0]
  let dy = end[1] - start[1]
  const kind: ShapeKind = tool === 'circle' ? 'ellipse' : tool
  if (tool === 'line' || tool === 'arrow') {
    if (constrain) {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
      const len = Math.hypot(dx, dy)
      dx = Math.cos(angle) * len
      dy = Math.sin(angle) * len
    }
    return { kind, x: start[0], y: start[1], w: dx, h: dy }
  }
  if (tool === 'circle' || constrain) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * side
    dy = Math.sign(dy || 1) * side
  }
  return { kind, x: Math.min(start[0], start[0] + dx), y: Math.min(start[1], start[1] + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

function drawLive(c: CanvasRenderingContext2D, l: Live, scale: number): void {
  if (!l) return
  c.save()
  if (l.kind === 'ink') {
    c.globalAlpha = l.opacity
    if (l.highlighter) c.globalCompositeOperation = 'multiply'
    c.fillStyle = l.color
    c.fill(l.path)
  } else if (l.kind === 'lasso') {
    c.beginPath()
    l.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
    c.closePath()
    c.fillStyle = 'rgba(47,107,228,0.06)'
    c.fill()
    c.setLineDash([6 / scale, 4 / scale])
    c.lineWidth = 1.5 / scale
    c.strokeStyle = ACCENT
    c.stroke()
  } else {
    c.translate(l.x, l.y)
    paintShape(c, new Path2D(shapePathData(l.shape, l.w, l.h, l.strokeWidth)), { ...l, fillOpacity: 0.18 })
  }
  c.restore()
}

/** Drops points closer than 0.4 page units apart: smaller files, same look. */
function simplify(points: Point[]): Point[] {
  const round = (v: number): number => Math.round(v * 100) / 100
  const out: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const q = out[out.length - 1]
    if (!q || i === points.length - 1 || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.4) out.push(p)
  }
  return out.map((p) => (p.length === 3 ? [round(p[0]), round(p[1]), round(p[2])] : [round(p[0]), round(p[1])]) as Point)
}
