/**
 * The interactive page. Rendering uses Konva (MIT); pointer input is handled
 * natively so in-progress strokes never trigger React renders: the live stroke
 * is drawn imperatively on its own layer, and only committed edits go through
 * the store (one undoable transaction each).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Layer, Shape, Stage, Text } from 'react-konva'
import type Konva from 'konva'
import { newId } from '@shared/factory'
import type { CanvasObject, Point, StrokeObject, TextObject } from '@shared/schema'
import { useStore } from '@/store/store'
import { addOp, removeOp } from './history'
import { eraserHits, pointInRect, textBounds, TEXT_LINE_HEIGHT } from './geometry'
import { outlinePath, strokePath2D } from './ink'
import { paperStyle } from './paper'
import { activeStage } from './stageRef'
import { FONT_FAMILY, TEXT_DEFAULT_SIZE, TEXT_DEFAULT_WIDTH } from './text'

const EMPTY: ReadonlySet<string> = new Set()
const HIGHLIGHTER_OPACITY = 0.45

type Live = { path: Path2D; color: string; opacity: number; highlighter: boolean }
type Draft = { object: TextObject; isNew: boolean }

const StrokeNode = memo(function StrokeNode({ stroke }: { stroke: StrokeObject }) {
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const c = ctx._context
        c.save()
        c.globalAlpha = stroke.opacity
        // Multiply keeps ink beneath a highlight fully legible.
        if (stroke.tool === 'highlighter') c.globalCompositeOperation = 'multiply'
        c.fillStyle = stroke.color
        c.fill(strokePath2D(stroke))
        c.restore()
      }}
    />
  )
})

const TextNode = memo(function TextNode({ text }: { text: TextObject }) {
  return (
    <Text
      listening={false}
      x={text.x}
      y={text.y}
      width={text.width}
      text={text.text}
      fill={text.color}
      fontSize={text.fontSize}
      fontFamily={FONT_FAMILY[text.font]}
      lineHeight={TEXT_LINE_HEIGHT}
      wrap="word"
    />
  )
})

export function PageCanvas({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId])!
  const tool = useStore((s) => s.tool)
  const commit = useStore((s) => s.commit)
  const eraserSize = useStore((s) => s.eraserSize)

  const scroller = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const liveShape = useRef<Konva.Shape>(null)
  const eraserCursor = useRef<HTMLDivElement>(null)
  const textArea = useRef<HTMLTextAreaElement>(null)

  const [scale, setScale] = useState(0)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(EMPTY)
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft

  const live = useRef<Live | null>(null)
  const drawing = useRef<{ pointerId: number; points: Point[]; stroke: Omit<StrokeObject, 'points' | 'id' | 'createdAt'> } | null>(null)
  const erasing = useRef<{ pointerId: number; last: Point; hits: Set<string> } | null>(null)
  const frame = useRef(0)
  const penSeenAt = useRef(0)

  // Fit the page width to the available space.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = (): void => setScale(Math.max(0.2, el.clientWidth / page.width))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [page.width])

  useEffect(() => {
    activeStage.stage = stageRef.current
    activeStage.scale = scale
    return () => {
      if (activeStage.stage === stageRef.current) activeStage.stage = null
    }
  }, [scale])

  const toPage = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }): Point => {
    const r = surface.current!.getBoundingClientRect()
    const x = (e.clientX - r.left) / scale
    const y = (e.clientY - r.top) / scale
    return e.pointerType === 'pen' ? [x, y, Math.min(1, Math.max(0, e.pressure))] : [x, y]
  }

  const redrawLive = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const d = drawing.current
      live.current = d
        ? {
            path: new Path2D(outlinePath(d.points, d.stroke, false)),
            color: d.stroke.color,
            opacity: d.stroke.opacity,
            highlighter: d.stroke.tool === 'highlighter'
          }
        : null
      liveShape.current?.getLayer()?.batchDraw()
    })
  }, [])

  // ---- Text editing --------------------------------------------------------

  const commitDraft = useCallback(() => {
    const d = draftRef.current
    if (!d) return
    draftRef.current = null
    setDraft(null)
    const value = (textArea.current?.value ?? d.object.text).replace(/\s+$/, '')
    const objects = useStore.getState().pages[pageId]?.objects ?? []
    if (d.isNew) {
      if (value.trim()) commit(pageId, { label: 'Add text', ops: [addOp(objects, [{ ...d.object, text: value }])] })
      return
    }
    const original = objects.find((o) => o.id === d.object.id)
    if (!original || original.type !== 'text') return
    if (!value.trim()) commit(pageId, { label: 'Delete text', ops: [removeOp(objects, new Set([original.id]))] })
    else if (value !== original.text)
      commit(pageId, { label: 'Edit text', ops: [{ kind: 'update', before: [original], after: [{ ...original, text: value }] }] })
  }, [commit, pageId])

  // Commit any open text box when the page unmounts or the tool changes.
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
  }, [draft, scale])

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

  // ---- Pointer input -------------------------------------------------------

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.pointerType === 'pen') penSeenAt.current = Date.now()
    // Palm rejection: while a stylus is in use, ignore touch contacts.
    if (e.pointerType === 'touch' && Date.now() - penSeenAt.current < 4000) return
    if (drawing.current || erasing.current) return

    const s = useStore.getState()
    const p = toPage(e)

    if (draftRef.current) {
      commitDraft()
      if (s.tool === 'text') {
        e.preventDefault()
        return
      }
    }

    if (s.tool === 'text') {
      e.preventDefault()
      startText(p)
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    if (s.tool === 'eraser') {
      erasing.current = { pointerId: e.pointerId, last: p, hits: new Set() }
      eraseAlong(p, p, s.eraserSize)
      return
    }

    const highlighter = s.tool === 'highlighter'
    drawing.current = {
      pointerId: e.pointerId,
      points: [p],
      stroke: {
        type: 'stroke',
        author: 'user',
        tool: highlighter ? 'highlighter' : 'pen',
        color: highlighter ? s.highlightColor : s.penColor,
        size: highlighter ? s.highlightSize : s.penSize,
        opacity: highlighter ? HIGHLIGHTER_OPACITY : 1,
        hasPressure: e.pointerType === 'pen' && e.pressure > 0
      }
    }
    redrawLive()
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (eraserCursor.current) {
      const r = surface.current!.getBoundingClientRect()
      eraserCursor.current.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`
    }
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
    const d = drawing.current
    if (d && e.pointerId === d.pointerId) {
      for (const ev of events.length ? events : [e.nativeEvent]) d.points.push(toPage(ev))
      redrawLive()
      return
    }
    const er = erasing.current
    if (er && e.pointerId === er.pointerId) {
      const size = useStore.getState().eraserSize
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const p = toPage(ev)
        eraseAlong(er.last, p, size)
        er.last = p
      }
    }
  }

  function eraseAlong(a: Point, b: Point, radius: number): void {
    const er = erasing.current!
    let changed = false
    for (const o of page.objects) {
      if (!er.hits.has(o.id) && eraserHits(o, a, b, radius)) {
        er.hits.add(o.id)
        changed = true
      }
    }
    if (changed) setHidden(new Set(er.hits))
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drawing.current
    if (d && e.pointerId === d.pointerId) {
      drawing.current = null
      const objects = useStore.getState().pages[pageId]?.objects ?? []
      const stroke = { ...d.stroke, id: newId(), createdAt: Date.now(), points: simplify(d.points) } as StrokeObject
      commit(pageId, { label: stroke.tool === 'pen' ? 'Draw' : 'Highlight', ops: [addOp(objects, [stroke])] })
      redrawLive()
      return
    }
    const er = erasing.current
    if (er && e.pointerId === er.pointerId) {
      erasing.current = null
      if (er.hits.size) {
        const objects = useStore.getState().pages[pageId]?.objects ?? []
        commit(pageId, { label: 'Erase', ops: [removeOp(objects, er.hits)] })
      }
      setHidden(EMPTY)
    }
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    if (drawing.current?.pointerId === e.pointerId) {
      drawing.current = null
      redrawLive()
    }
    if (erasing.current?.pointerId === e.pointerId) {
      erasing.current = null
      setHidden(EMPTY)
    }
  }

  const width = page.width * scale
  const height = page.height * scale
  const visible = page.objects.filter((o) => !hidden.has(o.id) && o.id !== draft?.object.id)

  return (
    <div ref={scroller} className="thin-scroll h-full w-full overflow-x-hidden overflow-y-auto" data-testid="canvas-scroller">
      {scale > 0 && (
      <div
        ref={surface}
        data-testid="page-surface"
        className="relative select-none"
        style={{
          width,
          height,
          touchAction: 'none',
          cursor: tool === 'text' ? 'text' : tool === 'eraser' ? 'none' : 'crosshair',
          ...paperStyle(page.paper, scale)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      >
        <Stage ref={stageRef} width={width} height={height} scaleX={scale} scaleY={scale} listening={false}>
          <Layer listening={false}>
            {visible.map((o: CanvasObject) =>
              o.type === 'stroke' ? <StrokeNode key={o.id} stroke={o} /> : <TextNode key={o.id} text={o} />
            )}
          </Layer>
          <Layer listening={false}>
            <Shape
              ref={liveShape}
              listening={false}
              perfectDrawEnabled={false}
              sceneFunc={(ctx) => {
                const l = live.current
                if (!l) return
                const c = ctx._context
                c.save()
                c.globalAlpha = l.opacity
                if (l.highlighter) c.globalCompositeOperation = 'multiply'
                c.fillStyle = l.color
                c.fill(l.path)
                c.restore()
              }}
            />
          </Layer>
        </Stage>

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
              left: draft.object.x * scale,
              top: draft.object.y * scale,
              width: draft.object.width * scale,
              fontSize: draft.object.fontSize * scale,
              lineHeight: TEXT_LINE_HEIGHT,
              fontFamily: FONT_FAMILY[draft.object.font],
              color: draft.object.color,
              caretColor: draft.object.color
            }}
          />
        )}

        {tool === 'eraser' && (
          <div
            ref={eraserCursor}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 rounded-full border border-ink-2/60 bg-white/40"
            style={{
              width: eraserSize * 2 * scale,
              height: eraserSize * 2 * scale,
              marginLeft: -eraserSize * scale,
              marginTop: -eraserSize * scale,
              transform: 'translate(-100px, -100px)'
            }}
          />
        )}
      </div>
      )}
    </div>
  )
}

/** Drops points closer than 0.4 page units apart: smaller files, same look. */
function simplify(points: Point[]): Point[] {
  if (points.length < 3) return points
  const out: Point[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!
    const q = out[out.length - 1]!
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.4) out.push(p)
  }
  out.push(points[points.length - 1]!)
  return out.map((p) => (p.length === 3 ? [round(p[0]), round(p[1]), round(p[2])] : [round(p[0]), round(p[1])]) as Point)
}
const round = (v: number): number => Math.round(v * 100) / 100
