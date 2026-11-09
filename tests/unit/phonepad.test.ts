import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StrokeSequencer, isPrivateAddress, normalizePairingCode, phoneMessageSchema, type InkMessage, type PhonePadOutgoing } from '@shared/phonepad'
import { fitAspect, followCamera, growthFor, phoneArea, toPage, visiblePageRect } from '@/phonepad/region'
import { fitWidth, type Camera } from '@/canvas/viewport'
import { Outbox } from '../../src/phonepad/client/outbox'
import { deviceLabel, normalize, secondFingerCancels } from '../../src/phonepad/client/gestures'
import { MAX_VIEW_WIDTH, MIN_VIEW_WIDTH, REACH, fromRect, panBy, paperLines, pinch, toPage as camToPage, toScreen, viewRect } from '../../src/phonepad/client/camera'
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
    const ok = phoneMessageSchema.safeParse(ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0, 0.7]], { tool: 'pen', pointer: 'pen', view: [-200, 50, 800, 370], epoch: 0 }))
    expect(ok.success).toBe(true)
    const bad = [
      ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0]]), // down without tool/pointer/view/epoch
      ink('stroke-0001', 0, 'move', [[0.5, 0.5, 5]]), // only down has seq 0
      ink('stroke-0001', 0, 'down', [[1.5, 0.5, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 800, 400], epoch: 0 }),
      ink('stroke-0001', 0, 'down', [[0.5, Number.NaN, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 800, 400], epoch: 0 }),
      ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0]], { tool: 'eraser', pointer: 'touch', view: [0, 0, 800, 400], epoch: 0 }), // eraser needs radius
      ink('stroke-0001', 0, 'down', [[0.5, 0.5, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 0, 400], epoch: 0 }), // empty view
      { type: 'viewport', rect: [0, 0, 800, 400], epoch: -1 },
      { type: 'pen', color: 'red', size: 4 },
      { type: 'pen', color: '#ff0000', size: 40 }, // beyond the pen range
      ink('../../etc', 1, 'move', [[0.5, 0.5, 0]]),
      ink('stroke-0001', 1, 'move', Array.from({ length: 513 }, () => [0.5, 0.5, 0] as [number, number, number])),
      { type: 'command', id: 'cmd-00000001', action: 'delete-everything' },
      { type: 'eval', code: 'alert(1)' }
    ]
    for (const m of bad) expect(phoneMessageSchema.safeParse(m).success).toBe(false)
    expect(phoneMessageSchema.safeParse({ type: 'viewport', rect: [-30000, -5, 24000, 11000], epoch: 2 }).success).toBe(true)
    expect(phoneMessageSchema.safeParse({ type: 'pen', color: '#16a34a', size: 6.5 }).success).toBe(true)
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
    const d = ink('s1aaaaaa', 0, 'down', [[0, 0, 0]], { tool: 'pen', pointer: 'touch', view: [0, 0, 100, 100], epoch: 0 })
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


describe('PhonePad mapping on the computer', () => {
  const page = { width: 1240, height: 1754 }
  const view = { width: 1200, height: 800 }

  it('starts the phone on what the computer shows, in the phone’s shape', () => {
    for (const aspect of [2.16, 0.46, 1]) {
      const area = phoneArea(fitWidth(page, view), view, page, aspect)!
      expect(area.width / area.height).toBeCloseTo(aspect, 6)
      const vis = visiblePageRect(fitWidth(page, view), view, page)!
      expect(area.x).toBeGreaterThanOrEqual(vis.x - 1e-9)
      expect(area.y + area.height).toBeLessThanOrEqual(vis.y + vis.height + 1e-9)
    }
    expect(fitAspect({ x: 0, y: 0, width: 1000, height: 500 }, 0.5)).toEqual({ x: 375, y: 0, width: 250, height: 500 })
    expect(toPage({ x: 100, y: 350, width: 600, height: 300 }, 0.5, 0.5)).toEqual([400, 500])
  })

  it('grows the page just enough, in whole paper squares, only past an edge', () => {
    // Inside: nothing.
    expect(growthFor({ x: 10, y: 10, width: 100, height: 100 }, page, 31, 160, 20000)).toBeNull()
    // Past the right and bottom edges by 20 and 5.
    const g = growthFor({ x: 1200, y: 1700, width: 60, height: 59 }, page, 31, 160, 20000)!
    expect(g).toEqual({ left: 0, top: 0, right: 186, bottom: 186 }) // ceil((20+160)/31)·31, ceil((5+160)/31)·31
    // Past the left and top edges: multiples of the spacing keep the grid aligned.
    const l = growthFor({ x: -40, y: -1, width: 10, height: 10 }, page, 40, 160, 20000)!
    expect(l.left % 40).toBe(0)
    expect(l.top % 40).toBe(0)
    expect(l.left).toBeGreaterThanOrEqual(200)
  })

  it('never grows past the largest page', () => {
    const big = { width: 19900, height: 1000 }
    const g = growthFor({ x: 19950, y: 10, width: 400, height: 10 }, big, 31, 160, 20000)!
    expect(big.width + g.left + g.right).toBeLessThanOrEqual(20000)
    expect(growthFor({ x: 20500, y: 10, width: 10, height: 10 }, { width: 20000, height: 1000 }, 31, 160, 20000)).toBeNull()
  })

  it('the computer follows the phone’s frame only once it leaves the view', () => {
    const cam: Camera = { scale: 1, x: 0, y: 0 }
    expect(followCamera(cam, view, { x: 100, y: 100, width: 400, height: 200 })).toBeNull()
    const next = followCamera(cam, view, { x: 2000, y: 1500, width: 400, height: 200 })!
    // Re-centred on the frame, at the same zoom.
    expect(next.scale).toBe(1)
    const cx = (2000 + 200) * next.scale + next.x
    expect(cx).toBeCloseTo(12 + (1200 - 24) / 2, 6)
    // A frame bigger than the view: zooms out so it fits.
    const zoomedOut = followCamera(cam, view, { x: 0, y: 0, width: 4000, height: 2000 })!
    expect(zoomedOut.scale).toBeLessThan(0.3)
  })
})

describe('PhonePad phone camera (infinite paper)', () => {
  const W = 844
  const H = 390

  it('shows a page rectangle across the surface and reports exactly what it shows', () => {
    const cam = fromRect([100, 200, 844, 390], W, H)
    expect(cam.scale).toBeCloseTo(1)
    expect(viewRect(cam, W, H)).toEqual([100, 200, 844, 390])
    const [x, y] = toScreen(cam, 522, 395)
    expect([x, y]).toEqual([422, 195])
    expect(camToPage(cam, 422, 195)).toEqual([522, 395])
  })

  it('pans in every direction, past the page’s edges', () => {
    let cam = fromRect([0, 0, 844, 390], W, H)
    cam = panBy(cam, 500, 300, W, H) // drag right/down: see what is left of and above the page
    expect(cam.x).toBeCloseTo(-500)
    expect(cam.y).toBeCloseTo(-300)
    cam = panBy(cam, -5000, -8000, W, H)
    expect(cam.x).toBeCloseTo(4500)
    expect(cam.y).toBeCloseTo(7700)
  })

  it('stays within reach of the page even when flung far away', () => {
    const cam = panBy(fromRect([0, 0, 844, 390], W, H), 1e7, 1e7, W, H, { width: 1240, height: 1754 })
    const [cx] = camToPage(cam, W / 2, H / 2)
    expect(cx).toBeCloseTo(-REACH, 3)
  })

  it('pinch keeps the page point under the fingers, and zoom has sensible limits', () => {
    const cam = fromRect([0, 0, 844, 390], W, H)
    const before = camToPage(cam, 300, 200)
    const zoomed = pinch(cam, [300, 200], [300, 200], 100, 200, W, H)
    expect(zoomed.scale).toBeCloseTo(cam.scale * 2)
    const after = camToPage(zoomed, 300, 200)
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
    // Pinch and move at once: the point follows the fingers' midpoint.
    const moved = pinch(cam, [300, 200], [350, 180], 100, 150, W, H)
    const follow = camToPage(moved, 350, 180)
    expect(follow[0]).toBeCloseTo(before[0], 6)
    // Limits.
    expect(viewRect(pinch(cam, [0, 0], [0, 0], 1, 1e6, W, H), W, H)[2]).toBeCloseTo(MIN_VIEW_WIDTH)
    expect(viewRect(pinch(cam, [0, 0], [0, 0], 1e6, 1, W, H), W, H)[2]).toBeCloseTo(MAX_VIEW_WIDTH)
  })

  it('draws paper lines exactly where Inkling’s paper has them, past the page too', () => {
    const grid = { type: 'grid' as const, spacing: 31, color: '#e8eaee' }
    expect(paperLines(grid, -70, 70, 'x')).toEqual([-62, -31, 0, 31, 62])
    expect(paperLines({ ...grid, type: 'lined' }, 0, 100, 'y')).toEqual([30, 61, 92]) // rows at s − 1
    expect(paperLines({ ...grid, type: 'lined' }, 0, 100, 'x')).toEqual([])
    expect(paperLines({ ...grid, type: 'dotted' }, -40, 40, 'x')).toEqual([-15.5, 15.5])
    expect(paperLines({ ...grid, type: 'blank' }, 0, 100, 'x')).toEqual([])
  })

  it('normalizes against the surface rect and clamps strays outside it', () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 }
    expect(normalize(rect, 110, 70)).toEqual([0.5, 0.5])
    expect(normalize(rect, -50, 500)).toEqual([0, 1])
    expect(normalize(rect, 10.0003, 20)).toEqual([0, 0])
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

  it('paces a resend: a few unsent messages at a time, oldest first, new ones queued behind', () => {
    const o = new Outbox()
    const sent = new WeakSet<object>()
    const msgs = Array.from({ length: 12 }, (_, i) => ({ i }))
    msgs.forEach((m, i) => o.push('s', i, m))
    const seen: number[] = []
    for (let frame = 0; frame < 4; frame++) {
      const batch = o.unsent(sent, 5) as { i: number }[]
      batch.forEach((m) => (sent.add(m), seen.push(m.i)))
      if (frame === 1) o.push('s', 12, { i: 12 }) // written while catching up
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(o.unsent(sent, 5)).toEqual([])
  })

  it('describes the device without identifying it', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36')).toBe('Android · Chrome')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe('iPad · Safari')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/26.0 Chrome/122 Mobile Safari/537.36')).toBe('Android · Samsung Internet')
  })
})

// ---- Controller (with fake notebook, canvas and phone) -----------------------

async function makeController(over: Partial<PageDoc> = {}) {
  const { PhonePadController } = await import('@/phonepad/controller')
  const { buildTransaction } = await import('@/canvas/commands')
  const { applyTransaction, contentShift, invertTransaction } = await import('@/canvas/history')
  const { phoneLive } = await import('@/phonepad/live')
  let page: PageDoc = {
    schemaVersion: 3,
    id: 'page-000001',
    notebookId: 'notebook-01',
    width: 1240,
    height: 1754,
    paper: { type: 'grid', spacing: 31, color: '#e8eaee' },
    objects: [],
    background: null,
    updatedAt: 0,
    ...over
  }
  // A small but real notebook: commands go through the real command layer and history.
  const undo: ReturnType<typeof buildTransaction>['transaction'][] = []
  let shift: { dx: number; dy: number; rev: number } | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((fn) => fn())
  const apply = (tx: (typeof undo)[number]) => {
    page = applyTransaction(page, tx)
    if (tx.ops.some((o) => o.kind === 'size')) {
      const [dx, dy] = contentShift(tx)
      shift = { dx, dy, rev: (shift?.rev ?? 0) + 1 }
    }
    notify()
  }
  const runs: { commands: CanvasCommand[]; label: string }[] = []
  const sent: PhonePadOutgoing[] = []
  const cameras: Camera[] = []
  const pen = { color: '#1f2430', size: 4, precise: false }
  const cam: Camera = { scale: 1, x: 0, y: 0 }
  const view = { width: 1100, height: 788 }
  const c = new PhonePadController({
    notebook: {
      target: () => ({ pageId: page.id, title: 'Calculus' }),
      page: () => page,
      pen: () => pen,
      setPen: (color, size) => {
        Object.assign(pen, { color, size })
        notify()
      },
      run: (commands, o) => {
        runs.push({ commands, label: o.label })
        const { transaction } = buildTransaction(page, commands, { author: 'user' }, o.label)
        undo.push(transaction)
        apply(transaction)
        return { ok: true, created: [] }
      },
      undo: () => {
        const tx = undo.pop()
        if (tx) apply(invertTransaction(tx))
      },
      redo: () => undefined,
      shift: () => shift,
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn))
    },
    canvas: { camera: () => ({ pageId: page.id, cam, view, page }), setCamera: (next) => cameras.push(next) },
    send: (m) => sent.push(m),
    render: async () => 'data:image/jpeg;base64,AAAA',
    viewDelayMs: 0
  })
  c.start()
  c.handle({ type: 'surface', aspect: 844 / 390, width: 844, height: 390, dpr: 2 })
  c.handle({ type: 'status', status: { state: 'connected', device: 'Phone', host: 'x', since: 0 } })
  const lastStatus = () => sent.findLast((m) => m.type === 'status') as Extract<PhonePadOutgoing, { type: 'status' }>
  const strokes = () => page.objects.filter((o): o is StrokeObject => o.type === 'stroke')
  return { c, runs, sent, cameras, pen, phoneLive, lastStatus, strokes, page: () => page }
}

const down = (id: string, u: number, v: number, view: [number, number, number, number], epoch = 0, extra: Partial<InkMessage> = {}) =>
  ({ type: 'ink', message: ink(id, 0, 'down', [[u, v, 0]], { tool: 'pen', pointer: 'touch', view, epoch, ...extra }) }) as const
const up = (id: string, seq: number, pts: InkMessage['points'] = []) => ({ type: 'ink', message: ink(id, seq, 'up', pts) }) as const

describe('PhonePad controller', () => {
  it('on connect tells the phone the page, its paper and the pen, and where to look', async () => {
    const { sent, lastStatus } = await makeController()
    expect(lastStatus()).toMatchObject({
      ready: true,
      pen: { color: '#1f2430', size: 4 },
      page: { key: 'page-000001', width: 1240, height: 1754, growable: true, epoch: 0, origin: [0, 0], paper: { type: 'grid', spacing: 31 } }
    })
    const goto = sent.find((m) => m.type === 'goto')!
    if (goto.type !== 'goto') throw new Error()
    expect(goto.rect[2] / goto.rect[3]).toBeCloseTo(844 / 390, 6)
  })

  it('maps ink into the page rectangle the phone showed, exactly, in the computer’s pen', async () => {
    const { c, strokes } = await makeController()
    c.handle(down('stroke-0001', 0, 0, [100, 200, 844, 390]))
    c.handle({ type: 'ink', message: ink('stroke-0001', 1, 'move', [[0.5, 0.5, 16]]) })
    c.handle(up('stroke-0001', 2, [[1, 1, 32]]))
    const [s] = strokes()
    expect(s!.points).toEqual([
      [100, 200],
      [522, 395],
      [944, 590]
    ])
    expect(s).toMatchObject({ color: '#1f2430', size: 4, tool: 'pen', hasPressure: false })
  })

  it('infinite paper: ink past the right/bottom edge grows the page in the same undo step', async () => {
    const { c, strokes, page, runs, c: ctl } = await makeController()
    c.handle(down('stroke-edge', 0.5, 0.5, [1100, 1700, 844, 390]))
    c.handle(up('stroke-edge', 1, [[0.9, 0.9, 30]]))
    expect(runs.at(-1)!.commands.map((x) => x.type)).toEqual(['extendPage', 'createStroke'])
    const p = page()
    const b = strokes()[0]!.points
    for (const [x, y] of b) {
      expect(x).toBeLessThanOrEqual(p.width)
      expect(y).toBeLessThanOrEqual(p.height)
    }
    expect((p.width - 1240) % 31).toBe(0)
    expect(p.width).toBeGreaterThan(1240)
    void ctl
  })

  it('infinite paper: ink left of / above the page grows it there; content and the phone keep their place', async () => {
    const { c, strokes, page, lastStatus, sent } = await makeController({
      objects: [{ id: 'existing-01', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[50, 50], [60, 60]] }]
    })
    c.handle(down('stroke-left', 0, 0, [-400, -100, 844, 390]))
    c.handle(up('stroke-left', 1, [[0.1, 0.1, 30]]))
    const p = page()
    const status = lastStatus()
    const [dx, dy] = status.page!.origin
    expect(dx).toBeGreaterThan(400)
    expect(dy).toBeGreaterThan(100)
    expect(dx % 31).toBe(0)
    expect(status.page!.epoch).toBe(1)
    // The old ink moved with the page's corner…
    expect(strokes()[0]!.points[0]).toEqual([50 + dx, 50 + dy])
    // …and the new ink sits where the phone drew it, relative to the old ink (-400 − 50 = −450 left of it).
    const ne = strokes()[1]!.points[0]!
    expect(ne[0] - strokes()[0]!.points[0]![0]).toBeCloseTo(-450, 1)
    expect(ne[1] - strokes()[0]!.points[0]![1]).toBeCloseTo(-150, 1)
    expect(p.width).toBe(1240 + dx)
    void sent
  })

  it('corrects a stroke that was written before the phone heard about a content move (epoch)', async () => {
    const { c, strokes } = await makeController()
    // First stroke grows the page left by some amount.
    c.handle(down('stroke-grow', 0, 0.5, [-300, 300, 844, 390]))
    c.handle(up('stroke-grow', 1, [[0.05, 0.5, 30]]))
    const moved = strokes()[0]!.points[0]![0] - -300
    // A stroke from the phone still at epoch 0 (it hadn't seen the move): same old coordinates for x = 200.
    c.handle(down('stroke-late', 0, 0, [200, 300, 844, 390], 0))
    c.handle(up('stroke-late', 1, [[0.01, 0, 10]]))
    expect(strokes()[1]!.points[0]![0]).toBeCloseTo(200 + moved, 3)
    // The same stroke sent at the new epoch would not be shifted again.
    c.handle(down('stroke-new', 0, 0, [200 + moved, 300, 844, 390], 1))
    c.handle(up('stroke-new', 1, [[0.01, 0, 10]]))
    expect(strokes()[2]!.points[0]![0]).toBeCloseTo(200 + moved, 3)
  })

  it('undoing a growth shrinks the page and tells the phone the content moved back', async () => {
    const { c, page, lastStatus } = await makeController()
    c.handle(down('stroke-left', 0, 0, [-400, 0, 844, 390]))
    c.handle(up('stroke-left', 1, [[0.1, 0.1, 30]]))
    expect(lastStatus().page!.origin[0]).toBeGreaterThan(0)
    c.handle({ type: 'command', action: 'undo' })
    expect(page().width).toBe(1240)
    expect(lastStatus().page!.origin).toEqual([0, 0])
    expect(lastStatus().page!.epoch).toBe(2)
  })

  it('PDF pages keep their size', async () => {
    const { c, page, runs } = await makeController({
      background: { type: 'pdf', asset: 'a'.repeat(32) + '.pdf', page: 0, width: 600, height: 800, text: '' } as PageDoc['background']
    })
    c.handle(down('stroke-pdf1', 0.9, 0.9, [1100, 1700, 844, 390]))
    c.handle(up('stroke-pdf1', 1, [[1, 1, 30]]))
    expect(runs.at(-1)!.commands.map((x) => x.type)).toEqual(['createStroke'])
    expect(page().width).toBe(1240)
  })

  it('keeps stylus pressure, and only from a stylus', async () => {
    const { c, strokes } = await makeController()
    c.handle({ type: 'ink', message: ink('stroke-pen1', 0, 'down', [[0.1, 0.1, 0, 0.3]], { tool: 'pen', pointer: 'pen', view: [0, 0, 844, 390], epoch: 0 }) })
    c.handle(up('stroke-pen1', 1, [[0.2, 0.2, 10, 0.9]]))
    c.handle({ type: 'ink', message: ink('stroke-fing', 0, 'down', [[0.1, 0.1, 0, 0.3]], { tool: 'pen', pointer: 'touch', view: [0, 0, 844, 390], epoch: 0 }) })
    c.handle(up('stroke-fing', 1, [[0.2, 0.2, 10, 0.9]]))
    const [pen, finger] = strokes()
    expect(pen!.hasPressure).toBe(true)
    expect(pen!.points.map((p) => p[2])).toEqual([0.3, 0.9])
    expect(finger!.hasPressure).toBe(false)
  })

  it('drops a cancelled stroke without editing the page', async () => {
    const { c, runs, phoneLive } = await makeController()
    c.handle(down('stroke-cncl', 0.1, 0.1, [0, 0, 844, 390]))
    expect(phoneLive.ink.has('stroke-cncl')).toBe(true)
    c.handle({ type: 'ink', message: ink('stroke-cncl', 1, 'cancel', []) })
    expect(runs).toHaveLength(0)
    expect(phoneLive.ink.has('stroke-cncl')).toBe(false)
  })

  it('erases with the canvas eraser’s hit testing, as one step', async () => {
    const { c, strokes, runs } = await makeController({
      objects: [
        { id: 'hit-stroke1', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[400, 195], [440, 195]] },
        { id: 'far-stroke1', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[5, 5], [6, 6]] }
      ]
    })
    c.handle({ type: 'ink', message: ink('stroke-ers1', 0, 'down', [[0.5, 0.4, 0]], { tool: 'eraser', pointer: 'touch', view: [0, 0, 844, 390], epoch: 0, radius: 0.02 }) })
    c.handle(up('stroke-ers1', 1, [[0.5, 0.6, 20]]))
    expect(runs.at(-1)).toMatchObject({ label: 'Erase', commands: [{ type: 'deleteObjects', ids: ['hit-stroke1'] }] })
    expect(strokes().map((s) => s.id)).toEqual(['far-stroke1'])
  })

  it('the phone’s pen choice becomes the computer’s pen, and the phone hears it back', async () => {
    const { c, pen, lastStatus } = await makeController()
    c.handle({ type: 'pen', color: '#16a34a', size: 6.5 })
    expect(pen).toMatchObject({ color: '#16a34a', size: 6.5 })
    expect(lastStatus().pen).toEqual({ color: '#16a34a', size: 6.5 })
    c.handle(down('stroke-grn1', 0.1, 0.1, [0, 0, 844, 390]))
    c.handle(up('stroke-grn1', 1, [[0.2, 0.2, 10]]))
    // …and a change made on the computer reaches the phone.
    pen.color = '#e5484d'
    c.handle({ type: 'pen', color: '#e5484d', size: 2.5 })
    expect(lastStatus().pen).toEqual({ color: '#e5484d', size: 2.5 })
  })

  it('a stroke carries the pen it was drawn with, so a pen change just before it can’t race it', async () => {
    const { c, strokes } = await makeController()
    c.handle(down('stroke-race', 0.1, 0.1, [0, 0, 844, 390], 0, { color: '#7C3AED', size: 10 }))
    c.handle(up('stroke-race', 1, [[0.2, 0.2, 10]]))
    expect(strokes()[0]).toMatchObject({ color: '#7c3aed', size: 10 })
  })

  it('follows the phone: the frame moves with it, and the computer’s view only when the frame leaves it', async () => {
    const { c, cameras, phoneLive } = await makeController()
    c.handle({ type: 'viewport', rect: [100, 100, 400, 185], epoch: 0 })
    expect(phoneLive.area).toEqual({ x: 100, y: 100, width: 400, height: 185 })
    expect(cameras).toHaveLength(0)
    c.handle({ type: 'viewport', rect: [3000, 3000, 400, 185], epoch: 0 })
    expect(cameras).toHaveLength(1)
  })

  it('clear removes only ink inside what the phone shows, as one step', async () => {
    const { c, runs } = await makeController({
      objects: [
        { id: 'inside-0001', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[150, 150], [160, 160]] },
        { id: 'outside-001', type: 'stroke', author: 'user', createdAt: 0, tool: 'pen', color: '#000000', size: 4, opacity: 1, hasPressure: false, points: [[900, 900], [910, 910]] }
      ]
    })
    c.handle({ type: 'viewport', rect: [100, 100, 400, 185], epoch: 0 })
    c.handle({ type: 'command', action: 'clear' })
    expect(runs.at(-1)).toMatchObject({ label: 'Clear PhonePad area', commands: [{ type: 'deleteObjects', ids: ['inside-0001'] }] })
  })

  it('sends a picture of what the phone sees plus a margin, clipped to the page, listing strokes it contains', async () => {
    const { c, sent } = await makeController()
    c.handle({ type: 'viewport', rect: [-200, -100, 844, 390], epoch: 0 })
    c.handle(down('stroke-view', 0.5, 0.5, [-200, -100, 844, 390]))
    c.handle(up('stroke-view', 1, [[0.6, 0.6, 10]]))
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'view' && m.strokes.includes('stroke-view'))).toBe(true))
    const v = sent.findLast((m) => m.type === 'view')!
    if (v.type !== 'view') throw new Error()
    expect(v.rect[0]).toBeGreaterThanOrEqual(0)
    expect(v.rect[1]).toBeGreaterThanOrEqual(0)
    expect(v.key).toBe('page-000001')
  })
})
