/**
 * Replay harness CLI.
 *
 *   npm run replay                                   synthetic scenarios, current defaults ("webcam" noise profile)
 *   npm run replay -- --profile model                the gentler v0.1.1 noise model
 *   npm run replay -- --noise 1.5 --fps 20           noisier / slower camera
 *   npm run replay -- --compare smoothing=0.3,0.5,0.8
 *   npm run replay -- --html out.html                draw every scenario's strokes (and intended paths) to look at
 *   npm run replay -- --compare pinchMetric=2d,3d,auto   which pinch measurement drives the pen
 *   npm run replay -- --world-noise 2                 assume world landmarks twice as noisy (sensitivity test)
 *   npm run replay -- --json                         machine-readable results (used to compare versions)
 *   npm run replay -- my-trace.json [--compare …] [--html out.html]   a trace recorded in WISP
 *
 * Recorded traces have no ground truth, so for them it reports stroke count,
 * wobble and points, and --html draws the strokes for each config side by side.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { replay, score, truthStrokes, wobble, type ReplayConfig, type ReplayResult, type Score, type StrokeTruth } from '../src/replay/replay'
import { SCENARIOS, setFps, setNoiseProfile, setNoiseScale, setWorldNoise, type NoiseProfile } from '../src/replay/scenarios'
import { parseTrace } from '../src/replay/trace'
import { DEFAULT_SETTINGS } from '../src/core/settings'

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const file = args.find((a, i) => !a.startsWith('--') && a.endsWith('.json') && !['--html'].includes(args[i - 1] ?? ''))
const compare = opt('--compare')
const seeds = Number(opt('--seeds') ?? 5) || 5
const noise = Number(opt('--noise') ?? 1)
const profile = (opt('--profile') ?? 'webcam') as NoiseProfile
const fps = Number(opt('--fps') ?? 30)
const htmlOut = opt('--html')
const asJson = args.includes('--json')
const only = opt('--only')
setNoiseScale(noise)
setNoiseProfile(profile)
setFps(fps)
setWorldNoise(Number(opt('--world-noise') ?? 1))

const PAGE_PX = 1600
const px = (v: number, w = 6) => (v * PAGE_PX).toFixed(1).padStart(w)

function configsFor(): Array<{ label: string; cfg: ReplayConfig }> {
  const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  const base: ReplayConfig = {
    processor: { penPoint: d.penPoint as never, pinchSensitivity: d.pinchSensitivity as number, releaseSensitivity: d.releaseSensitivity as number },
    engine: { smoothing: d.smoothing as number, stabilizer: d.stabilizer as number, refine: d.refine as boolean }
  }
  if (!compare) return [{ label: 'defaults', cfg: base }]
  const [key, values] = compare.split('=') as [string, string]
  return values.split(',').map((v) => {
    const val = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)
    const cfg: ReplayConfig = { processor: { ...base.processor }, engine: { ...base.engine } }
    if (['smoothing', 'stabilizer', 'refine', 'noiseGate'].includes(key)) (cfg.engine as Record<string, unknown>)[key] = val
    else if (key === 'maxNoiseFactor' || key === 'enter' || key === 'releaseRise') (cfg as Record<string, unknown>).gesture = key === 'maxNoiseFactor' ? { maxNoiseFactor: val } : undefined
    else (cfg.processor as Record<string, unknown>)[key] = val
    return { label: `${key}=${v}`, cfg }
  })
}

// ── HTML drawing ───────────────────────────────────────────────────────────
interface Panel {
  title: string
  truth?: StrokeTruth[]
  result: ReplayResult
}
function svg(p: Panel): string {
  const all = [...p.result.strokes.flatMap((s) => s.points), ...(p.truth ?? []).flatMap((t) => t.path)]
  if (all.length === 0) return `<figure><svg viewBox="0 0 10 10"></svg><figcaption>${p.title} — no ink</figcaption></figure>`
  const xs = all.map((q) => q.x), ys = all.map((q) => q.y)
  const pad = 0.01
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad
  const w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad
  const k = 1000 / Math.max(w * 1.6, h)
  const P = (q: { x: number; y: number }) => `${((q.x - x0) * 1.6 * k).toFixed(1)},${((q.y - y0) * k).toFixed(1)}`
  const truth = (p.truth ?? []).map((t) => `<polyline points="${t.path.map(P).join(' ')}" class="truth"/>`).join('')
  const ink = p.result.strokes
    .map((s, i) => `<polyline points="${s.points.map(P).join(' ')}" class="ink" style="stroke:hsl(${(i * 67) % 360} 70% 35%)"/>${s.points.length === 1 ? `<circle cx="${P(s.points[0]!).split(',')[0]}" cy="${P(s.points[0]!).split(',')[1]}" r="3" fill="black"/>` : ''}`)
    .join('')
  return `<figure><svg viewBox="0 0 ${(w * 1.6 * k).toFixed(0)} ${(h * k).toFixed(0)}">${truth}${ink}</svg><figcaption>${p.title} · ${p.result.strokes.length} stroke(s)</figcaption></figure>`
}
function writeHtml(path: string, rows: Array<{ heading: string; panels: Panel[] }>): void {
  const body = rows.map((r) => `<h2>${r.heading}</h2><div class="row">${r.panels.map(svg).join('')}</div>`).join('\n')
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>WISP replay</title><style>
body{font:14px system-ui;margin:20px;color:#1f2430} h2{font-size:15px;margin:24px 0 8px}
.row{display:flex;gap:16px;flex-wrap:wrap} figure{margin:0;border:1px solid #e7e7ea;border-radius:8px;padding:8px;background:#fff}
svg{width:420px;height:260px;display:block;background:#fff} figcaption{font-size:12px;color:#4b5160;margin-top:4px}
.truth{fill:none;stroke:#2f6be4;stroke-opacity:.25;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}
.ink{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
</style><h1>WISP replay</h1><p>Wide pale blue = intended path (synthetic only). Thin coloured lines = strokes WISP produced, one colour per stroke.</p>${body}`
  )
  console.log(`\nWrote ${path}`)
}

// ── Recorded trace ─────────────────────────────────────────────────────────
if (file) {
  const trace = parseTrace(JSON.parse(readFileSync(file, 'utf8')))
  const frames = trace.frames.length
  const dur = frames ? (trace.frames[frames - 1]!.t - trace.frames[0]!.t) / 1000 : 0
  console.log(`${file}: ${frames} frames, ${dur.toFixed(1)} s, ${(frames / Math.max(dur, 1e-3)).toFixed(1)} fps${trace.note ? ` — ${trace.note}` : ''}\n`)
  console.log('config'.padEnd(26), 'strokes', 'wobble px', 'points', 'ms/frame')
  const panels: Panel[] = []
  for (const { label, cfg } of configsFor()) {
    const r = replay(trace, cfg)
    const w = r.strokes.length ? r.strokes.reduce((s, k) => s + wobble(k.points), 0) / r.strokes.length : 0
    console.log(label.padEnd(26), String(r.strokes.length).padStart(7), px(w, 9), String(r.strokes.reduce((s, k) => s + k.points.length, 0)).padStart(6), r.msPerFrame.toFixed(3).padStart(8))
    panels.push({ title: label, result: r })
  }
  if (htmlOut) writeHtml(htmlOut, [{ heading: file, panels }])
} else {
  // ── Synthetic scenarios ──────────────────────────────────────────────────
  type Agg = Record<keyof Score, number>
  const results: Array<{ scenario: string; title: string; config: string; mean: Agg }> = []
  const rows: Array<{ heading: string; panels: Panel[] }> = []
  for (const sc of SCENARIOS.filter((s) => !only || only.split(',').includes(s.id))) {
    const row: Panel[] = []
    for (const { label, cfg } of configsFor()) {
      const acc = {} as Agg
      for (let seed = 1; seed <= seeds; seed++) {
        const { trace, truth } = sc.build(seed)
        const r = replay(trace, cfg)
        const t = truthStrokes(truth, r.config, trace.videoAspect)
        const s = score(r, t)
        for (const k of Object.keys(s) as Array<keyof Score>) acc[k] = (acc[k] ?? 0) + s[k] / seeds
        if (seed === 1) row.push({ title: `${label}`, truth: t, result: r })
      }
      results.push({ scenario: sc.id, title: sc.title, config: label, mean: acc })
    }
    rows.push({ heading: sc.title, panels: row })
  }
  if (asJson) {
    console.log(JSON.stringify({ profile, noise, fps, seeds, results }))
  } else {
    console.log(`Synthetic scenarios — "${profile}" noise ×${noise}, ${fps} fps, ${seeds} seeds each. Distances in px on the 1600-px page (sums over the scenario's strokes unless noted).\n`)
    console.log(
      'scenario'.padEnd(28),
      'config'.padEnd(16),
      'strokes',
      'unint',
      'brkn',
      'lost',
      ' shape',
      'wobble',
      '  hook',
      '  tail',
      'start±',
      ' end±',
      'excess',
      'missing',
      'lag',
      'jit',
      'ltail',
      'down',
      ' up',
      'ms/f'
    )
    for (const r of results) {
      const m = r.mean
      console.log(
        r.title.slice(0, 28).padEnd(28),
        r.config.slice(0, 16).padEnd(16),
        `${m.strokes.toFixed(1)}/${m.expected.toFixed(0)}`.padStart(7),
        m.unintended.toFixed(1).padStart(5),
        m.broken.toFixed(1).padStart(4),
        m.lost.toFixed(1).padStart(4),
        px(m.shapeError),
        px(m.wobble),
        px(m.hook),
        px(m.tail),
        px(m.startError),
        px(m.endError, 5),
        px(m.excess),
        px(m.missing, 7),
        px(m.liveLag, 4),
        px(m.liveJitter, 4),
        px(m.liveTail, 5),
        m.penDownDelay.toFixed(0).padStart(4),
        m.penUpDelay.toFixed(0).padStart(4),
        m.msPerFrame.toFixed(3)
      )
    }
  }
  if (htmlOut) writeHtml(htmlOut, rows)
}
