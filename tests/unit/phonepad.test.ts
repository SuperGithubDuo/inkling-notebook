import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StrokeSequencer, isPrivateAddress, normalizePairingCode, phoneMessageSchema, type InkMessage, type PhonePadOutgoing } from '@shared/phonepad'
import { fitAspect, panToScreen, phoneArea, toArea, toPage, visiblePageRect, zoomOrigin } from '@/phonepad/region'
import { fitWidth, zoomAt, type Camera } from '@/canvas/viewport'
import { Outbox } from '../../src/phonepad/client/outbox'
import { deviceLabel, normalize, secondFingerCancels, twoFingerDelta } from '../../src/phonepad/client/gestures'
import type { PageDoc, StrokeObject } from '@shared/schema'
import type { CanvasCommand } from '@/canvas/commands'

// The controller builds Path2D previews; Node has none.
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).Path2D ??= class {
    constructor(public d?: string) {}
  }
  ;(globalThis as Record<string, unknown>).requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0)
})

const ink = (stroke: string, seq: number, phase: InkMessage['phase'], points: InkMessage['points'], extra: Partial<InkMessage> = {}): InkMessage => ({
  type: 'ink',
  stroke,
  seq,
  phase,
  points,
  ...extra
})

describe('PhonePad protocol', () => {
  it('accepts well-formed ink and rejects malformed or out-of-range messages', () => {
    const ok = phoneMessageSchema.safeParse(ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0, 0.7]], { tool: 'pen', pointer: 'pen', aspect: 2.1 }))
    expect(ok.success).toBe(true)
    const bad = [
      ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0]]), // down without tool/pointer/aspect
      ink('stroke-0001', 0, 'move', [[0.5, 0.5, 5]]), // only down has seq 0
      ink('stroke-0001', 0, 'down', [[1.5, 0.5, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }),
      ink('stroke-0001', 0, 'down', [[0.5, Number.NaN, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }),
      ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0]], { tool: 'eraser', pointer: 'touch', aspect: 2 }), // eraser needs radius
      ink('../../etc', 1, 'move', [[0.5, 0.5, 0]]),
      ink('stroke-0001', 1, 'move', Array.from({ length: 513 }, () => [0.5, 0.5, 0] as [number, number, number])),
      { type: 'command', id: 'cmd-00000001', action: 'delete-everything' },
      { type: 'eval', code: 'alert(1)' }
    ]
    for (const m of bad) expect(phoneMessageSchema.safeParse(m).success).toBe(false)
  })

  it('normalizes typed pairing codes and rejects look-alike characters', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizePairingCode(' AB CD EF GH ')).toBe('ABCDEFGH')
    expect(normalizePairingCode('ABCD-EFG0')).toBeNull() // 0 isn't in the alphabet
    expect(normalizePairingCode('ABC')).toBeNull()
  })

  it('knows private network addresses', () => {
    for (const a of ['192.168.1.5', '10.0.0.1', '172.16.0.1', '172.31.255.255', '::ffff:192.168.0.2', 'fe80::1', 'fd12::1', '127.0.0.1']) expect(isPrivateAddress(a)).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '']) expect(isPrivateAddress(a)).toBe(false)
  })
})

describe('StrokeSequencer', () => {
  it('delivers each message once, in order, holding early arrivals', () => {
    const s = new StrokeSequencer()
    const d = ink('s1aaaaaa', 0, 'down', [[0, 0, 0]], { tool: 'pen', pointer: 'touch', aspect: 1 })
    const m1 = ink('s1aaaaaa', 1, 'move', [[0.1, 0.1, 1]])
    const m2 = ink('s1aaaaaa', 2, 'move', [[0.2, 0.2, 2]])
    const up = ink('s1aaaaaa', 3, 'up', [])
    expect(s.accept(d)).toEqual([d])
    expect(s.accept(m2)).toEqual([])
    expect(s.accept(m1)).toEqual([m1, m2])
    expect(s.accept(m1)).toEqual([])
    expect(s.acked('s1aaaaaa')).toBe(2)
    expect(s.open()).toEqual(['s1aaaaaa'])
    expect(s.accept(up)).toEqual([up])
    expect(s.isFinished('s1aaaaaa')).toBe(true)
    // A full resend after a reconnect changes nothing.
    for (const m of [d, m1, m2, up]) expect(s.accept(m)).toEqual([])
  })

  it('forgets old finished strokes beyond its memory', () => {
    const s = new StrokeSequencer(2)
    for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) s.finish(id)
    expect(s.isFinished('aaaaaaaa')).toBe(false)
    expect(s.isFinished('cccccccc')).toBe(true)
  })
})

describe('PhonePad writing area (coordinate mapping)', () => {
  const page = { width: 1000, height: 1414 } // A4 portrait at Inkling's page scale
  const view = { width: 1200, height: 800 }

  it('has the phone’s aspect ratio, so ink keeps its shape', () => {
    for (const aspect of [2.16, 1.78, 0.46, 1]) {
      const cam = fitWidth(page, view)
      const area = phoneArea(cam, view, page, aspect)!
      expect(area.width / area.height).toBeCloseTo(aspect, 6)
      // A circle drawn on the phone: same page distance per unit along both axes.
      const [x0, y0] = toPage(area, 0.5, 0.5)
      const [x1] = toPage(area, 0.5 + 0.1, 0.5)
      const [, y1] = toPage(area, 0.5, 0.5 + 0.1 * aspect)
      expect(x1 - x0).toBeCloseTo(y1 - y0, 6)
    }
  })

  it('lies inside the visible part of the page, clear of the bottom dock', () => {
    const cam = fitWidth(page, view)
    const vis = visiblePageRect(cam, view, page)!
    const area = phoneArea(cam, view, page, 2)!
    expect(area.x).toBeGreaterThanOrEqual(vis.x - 1e-9)
    expect(area.y).toBeGreaterThanOrEqual(vis.y - 1e-9)
    expect(area.x + area.width).toBeLessThanOrEqual(vis.x + vis.width + 1e-9)
    expect(area.y + area.height).toBeLessThanOrEqual(vis.y + vis.height + 1e-9)
    // The dock's 88 px at the bottom of the view are left out.
    expect((vis.y + vis.height) * cam.scale + cam.y).toBeCloseTo(view.height - 88, 6)
  })

  it('is clipped to the page when the page is smaller than the view', () => {
    const cam: Camera = { scale: 0.3, x: 400, y: 100 }
    const vis = visiblePageRect(cam, view, page)!
    expect(vis).toEqual({ x: 0, y: 0, width: 1000, height: 1414 })
    expect(visiblePageRect({ scale: 1, x: -5000, y: 0 }, view, page)).toBeNull()
  })

  it('shrinks when the computer zooms in: zoomed writing', () => {
    const cam = fitWidth(page, view)
    const a = phoneArea(cam, view, page, 2)!
    const zoomed = zoomAt(cam, 3, 600, 300, page, view)
    const b = phoneArea(zoomed, view, page, 2)!
    expect(b.width).toBeCloseTo(a.width / 3, 1)
  })

  it('maps the corners and centre exactly, and round-trips page rects', () => {
    const area = fitAspect({ x: 100, y: 200, width: 600, height: 600 }, 2)
    expect(area).toEqual({ x: 100, y: 350, width: 600, height: 300 })
    expect(toPage(area, 0, 0)).toEqual([100, 350])
    expect(toPage(area, 1, 1)).toEqual([700, 650])
    expect(toPage(area, 0.5, 0.5)).toEqual([400, 500])
    expect(toArea(area, { x: 100, y: 350, width: 600, height: 300 })).toEqual([0, 0, 1, 1])
    // Portrait phone in a wide bounds: full height, centred.
    expect(fitAspect({ x: 0, y: 0, width: 1000, height: 500 }, 0.5)).toEqual({ x: 375, y: 0, width: 250, height: 500 })
  })

  it('turns phone gestures into camera moves that follow the fingers', () => {
    const cam: Camera = { scale: 2, x: -100, y: -50 }
    const area = { x: 100, y: 100, width: 200, height: 100 }
    // Fingers move right by 10 % of the area: the area moves left, so the page moves right on screen.
    expect(panToScreen(area, cam, -0.1, 0)).toEqual([40, -0])
    // Pinch centred on the area's centre zooms around that point on screen.
    expect(zoomOrigin(area, cam, 0.5, 0.5)).toEqual([200 * 2 - 100, 150 * 2 - 50])
  })
})

describe('PhonePad phone client', () => {
  it('normalizes against the surface rect and clamps strays outside it', () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 }
    expect(normalize(rect, 110, 70)).toEqual([0.5, 0.5])
    expect(normalize(rect, -50, 500)).toEqual([0, 1])
    expect(normalize(rect, 10.0003, 20)).toEqual([0, 0])
  })

  it('reads two-finger moves as pan and pinch', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 }
    const pan = twoFingerDelta(rect, [[50, 50], [100, 50]], [[70, 50], [120, 50]])
    expect(pan.du).toBeCloseTo(-0.1)
    expect(pan.factor).toBeCloseTo(1)
    const pinch = twoFingerDelta(rect, [[90, 50], [110, 50]], [[80, 50], [120, 50]])
    expect(pinch.factor).toBeCloseTo(2)
    expect([pinch.u, pinch.v]).toEqual([0.5, 0.5])
  })

  it('a second finger only cancels a stroke that has barely started', () => {
    expect(secondFingerCancels(80, 3)).toBe(true)
    expect(secondFingerCancels(400, 3)).toBe(false)
    expect(secondFingerCancels(80, 40)).toBe(false)
  })

  it('keeps unacknowledged messages for resending, in order', () => {
    const o = new Outbox(5)
    o.push('a', 0, { n: 1 })
    o.push('a', 1, { n: 2 })
    o.push('b', 0, { n: 3 })
    o.push('a', 2, { n: 4 })
    o.ack('a', 1)
    expect(o.pending()).toEqual([{ n: 3 }, { n: 4 }])
    expect(o.has('a')).toBe(true)
    o.ack('a', 1_000_000)
    expect(o.has('a')).toBe(false)
    for (let i = 0; i < 10; i++) o.push('c', i, { i })
    expect(o.size).toBe(5) // newest kept
  })

  it('describes the device without identifying it', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36')).toBe('Android · Chrome')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe('iPad · Safari')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/26.0 Chrome/122 Mobile Safari/537.36')).toBe('Android · Samsung Internet')
  })
})

// ---- Controller (with fake notebook, canvas and phone) -----------------------

async function makeController() {
  const { PhonePadController } = await import('@/phonepad/controller')
  const { phoneLive } = await import('@/phonepad/live')
  const page: PageDoc = {
    schemaVersion: 3,
    id: 'page-000001',
    notebookId: 'notebook-01',
    width: 1000,
    height: 1414,
    paper: { type: 'grid', spacing: 32, color: '#e5e7eb' },
    objects: [],
    background: null,
    updatedAt: 0
  }
  const runs: { commands: CanvasCommand[]; label: string; pageId: string }[] = []
  const sent: PhonePadOutgoing[] = []
  const nav: unknown[] = []
  const calls = { undo: 0, redo: 0 }
  const cam: Camera = { scale: 1, x: 0, y: 0 }
  const view = { width: 1100, height: 788 } // visible page rect: 12..1000 × 12..700
  const c = new PhonePadController({
    notebook: {
      target: () => ({ pageId: page.id, title: 'Calculus' }),
      page: () => page,
      style: () => ({ color: '#2563eb', size: 4, highlighter: false, highlightColor: '#fde047', highlightSize: 18, precise: false }),
      run: (commands, o) => {
        runs.push({ commands, ...o })
        return { ok: true, created: [] }
      },
      undo: () => calls.undo++,
      redo: () => calls.redo++,
      subscribe: () => () => undefined
    },
    canvas: { camera: () => ({ pageId: page.id, cam, view, page }), navigate: (op) => nav.push(op) },
    send: (m) => sent.push(m),
    render: async () => 'data:image/jpeg;base64,AAAA',
    viewDelayMs: 0
  })
  c.start()
  c.handle({ type: 'status', status: { state: 'connected', device: 'Phone', host: 'x', since: 0 } })
  c.handle({ type: 'surface', aspect: 2, width: 800, height: 400, dpr: 2 })
  return { c, page, runs, sent, nav, calls, phoneLive }
}

describe('PhonePad controller', () => {
  it('turns a phone stroke into one ordinary stroke command at the mapped position, in the computer’s pen style', async () => {
    const { c, runs, sent, phoneLive } = await makeController()
    const area = c.area!
    expect(area.width / area.height).toBeCloseTo(2)
    expect(sent.find((m) => m.type === 'status')).toMatchObject({ page: 'ready', color: '#2563eb', highlighter: false })

    c.handle({ type: 'ink', message: ink('stroke-0001', 0, 'down', [[0, 0, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }) })
    c.handle({ type: 'ink', message: ink('stroke-0001', 1, 'move', [[0.5, 0.5, 16]]) })
    expect(phoneLive.ink.has('stroke-0001')).toBe(true) // live preview while writing
    expect(runs).toHaveLength(0) // nothing committed mid-stroke
    c.handle({ type: 'ink', message: ink('stroke-0001', 2, 'up', [[1, 1, 32]]) })

    expect(runs).toHaveLength(1)
    const cmd = runs[0]!.commands[0]!
    expect(runs[0]!.label).toBe('Draw')
    if (cmd.type !== 'createStroke') throw new Error()
    expect(cmd.stroke).toMatchObject({ tool: 'pen', color: '#2563eb', size: 4, hasPressure: false })
    const r = (v: number) => Math.round(v * 100) / 100
    expect(cmd.stroke.points).toEqual([
      [r(area.x), r(area.y)],
      [r(area.x + area.width / 2), r(area.y + area.height / 2)],
      [r(area.x + area.width), r(area.y + area.height)]
    ])
    expect(phoneLive.ink.has('stroke-0001')).toBe(false)
  })

  it('keeps stylus pressure, and only from a stylus', async () => {
    const { c, runs } = await makeController()
    c.handle({ type: 'ink', message: ink('stroke-pen1', 0, 'down', [[0.1, 0.1, 0, 0.3]], { tool: 'pen', pointer: 'pen', aspect: 2 }) })
    c.handle({ type: 'ink', message: ink('stroke-pen1', 1, 'up', [[0.2, 0.2, 10, 0.9]]) })
    c.handle({ type: 'ink', message: ink('stroke-fing', 0, 'down', [[0.1, 0.1, 0, 0.3]], { tool: 'pen', pointer: 'touch', aspect: 2 }) })
    c.handle({ type: 'ink', message: ink('stroke-fing', 1, 'up', [[0.2, 0.2, 10, 0.9]]) })
    const [pen, finger] = runs.map((r) => r.commands[0]!) as Extract<CanvasCommand, { type: 'createStroke' }>[]
    expect(pen!.stroke.hasPressure).toBe(true)
    expect(pen!.stroke.points.map((p) => p[2])).toEqual([0.3, 0.9])
    expect(finger!.stroke.hasPressure).toBe(false)
    expect(finger!.stroke.points.every((p) => p.length === 2)).toBe(true)
  })

  it('keeps the area a stroke started in, even if the phone rotates or the view zooms mid-stroke', async () => {
    const { c, runs } = await makeController()
    const before = { ...c.area! }
    c.handle({ type: 'ink', message: ink('stroke-rot1', 0, 'down', [[1, 1, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }) })
    c.handle({ type: 'surface', aspect: 0.5, width: 400, height: 800, dpr: 2 }) // rotated
    c.handle({ type: 'ink', message: ink('stroke-rot1', 1, 'up', [[1, 1, 10]]) })
    const pts = (runs[0]!.commands[0] as Extract<CanvasCommand, { type: 'createStroke' }>).stroke.points
    expect(pts.at(-1)![0]).toBeCloseTo(before.x + before.width, 1)
    expect(pts.at(-1)![1]).toBeCloseTo(before.y + before.height, 1)
    expect(c.area!.width / c.area!.height).toBeCloseTo(0.5) // later strokes use the new shape
  })

  it('drops a cancelled stroke without editing the page', async () => {
    const { c, runs, phoneLive } = await makeController()
    c.handle({ type: 'ink', message: ink('stroke-cncl', 0, 'down', [[0.1, 0.1, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }) })
    c.handle({ type: 'ink', message: ink('stroke-cncl', 1, 'cancel', []) })
    expect(runs).toHaveLength(0)
    expect(phoneLive.ink.has('stroke-cncl')).toBe(false)
  })

  it('erases with the canvas eraser’s hit testing, as one step', async () => {
    const { c, page, runs } = await makeController()
    const area = c.area!
    const mid = toPage(area, 0.5, 0.5)
    page.objects = [
      { id: 'hit-stroke1', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[mid[0] - 20, mid[1]], [mid[0] + 20, mid[1]]] },
      { id: 'far-stroke1', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[area.x + 5, area.y + 5], [area.x + 6, area.y + 6]] }
    ]
    c.handle({ type: 'ink', message: ink('stroke-ers1', 0, 'down', [[0.5, 0.4, 0]], { tool: 'eraser', pointer: 'touch', aspect: 2, radius: 0.02 }) })
    c.handle({ type: 'ink', message: ink('stroke-ers1', 1, 'up', [[0.5, 0.6, 20]]) })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.label).toBe('Erase')
    expect(runs[0]!.commands).toEqual([{ type: 'deleteObjects', ids: ['hit-stroke1'] }])
  })

  it('undo/redo go to the notebook; clear removes only ink inside the area, as one step', async () => {
    const { c, page, runs, calls } = await makeController()
    c.handle({ type: 'command', action: 'undo' })
    c.handle({ type: 'command', action: 'redo' })
    expect(calls).toEqual({ undo: 1, redo: 1 })
    const a = c.area!
    const s = (id: string, x: number, y: number): StrokeObject => ({
      id,
      type: 'stroke',
      author: 'user',
      createdAt: 0,
      tool: 'pen',
      color: '#000000',
      size: 4,
      opacity: 1,
      hasPressure: false,
      points: [
        [x, y],
        [x + 10, y + 10]
      ]
    })
    page.objects = [
      s('inside-0001', a.x + 50, a.y + 50),
      s('outside-001', a.x - 200, a.y + 50),
      { id: 'text-000001', type: 'text', author: 'user', createdAt: 0, x: a.x + 60, y: a.y + 60, width: 100, text: 'keep', color: '#000000', fontSize: 20, font: 'sans' }
    ]
    c.handle({ type: 'command', action: 'clear' })
    expect(runs.at(-1)).toMatchObject({ label: 'Clear PhonePad area', commands: [{ type: 'deleteObjects', ids: ['inside-0001'] }] })
  })

  it('moves the computer’s view for two-finger gestures', async () => {
    const { c, nav } = await makeController()
    c.handle({ type: 'pan', du: 0.1, dv: 0 })
    c.handle({ type: 'zoom', factor: 1.5, u: 0.5, v: 0.5 })
    expect(nav[0]).toMatchObject({ pan: [expect.any(Number), expect.anything()] })
    expect((nav[0] as { pan: number[] }).pan[0]).toBeLessThan(0)
    expect(nav[1]).toMatchObject({ zoom: { factor: 1.5 } })
  })

  it('sends the phone a picture of exactly its area, listing strokes it now contains', async () => {
    const { c, sent } = await makeController()
    c.handle({ type: 'ink', message: ink('stroke-view', 0, 'down', [[0.1, 0.1, 0]], { tool: 'pen', pointer: 'touch', aspect: 2 }) })
    c.handle({ type: 'ink', message: ink('stroke-view', 1, 'up', [[0.2, 0.2, 10]]) })
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'view' && m.strokes.includes('stroke-view'))).toBe(true))
    const view = sent.findLast((m) => m.type === 'view')!
    if (view.type !== 'view') throw new Error()
    // Integer-pixel crop of the area: within one page unit of [0, 0, 1, 1].
    view.rect.forEach((v, i) => expect(Math.abs(v - [0, 0, 1, 1][i]!)).toBeLessThan(0.01))
  })
})
