/**
 * Replay harness CLI.
 *
 *   npm run replay                       synthetic scenarios A–F, current defaults
 *   npm run replay -- my-trace.json      a recorded landmark trace (from Diagnostics → Record)
 *   npm run replay -- my-trace.json --compare smoothing=0.3,0.5,0.8
 *
 * For recorded traces there is no ground truth, so it reports stroke count,
 * wobble (shake) and points. For synthetic scenarios it also reports shape
 * error, tails and start hooks against the intended strokes.
 */
import { readFileSync } from 'node:fs'
import { replay, score, truthStrokes, wobble, type ReplayConfig } from '../src/replay/replay'
import { SCENARIOS, setNoiseScale } from '../src/replay/scenarios'
import { parseTrace } from '../src/replay/trace'
import { DEFAULT_SETTINGS } from '../src/core/settings'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'))
const cmpIdx = args.indexOf('--compare')
const compare = cmpIdx >= 0 ? args[cmpIdx + 1] : undefined
const seeds = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) || 5 : 5
const noise = args.includes('--noise') ? Number(args[args.indexOf('--noise') + 1]) : 1
setNoiseScale(noise)

const PAGE_PX = 1600 // report page units as px on the default 1600-px page
const px = (v: number) => (v * PAGE_PX).toFixed(1).padStart(6)

function configsFor(): Array<{ label: string; cfg: ReplayConfig }> {
  const base: ReplayConfig = {
    processor: { penPoint: DEFAULT_SETTINGS.penPoint, pinchSensitivity: DEFAULT_SETTINGS.pinchSensitivity, releaseSensitivity: DEFAULT_SETTINGS.releaseSensitivity },
    engine: { smoothing: DEFAULT_SETTINGS.smoothing, stabilizer: DEFAULT_SETTINGS.stabilizer }
  }
  if (!compare) return [{ label: 'defaults', cfg: base }]
  const [key, values] = compare.split('=') as [string, string]
  return values.split(',').map((v) => {
    const val = Number.isNaN(Number(v)) ? v : Number(v)
    const cfg: ReplayConfig = { processor: { ...base.processor }, engine: { ...base.engine } }
    if (key === 'smoothing' || key === 'stabilizer') (cfg.engine as Record<string, unknown>)[key] = val
    else (cfg.processor as Record<string, unknown>)[key] = val
    return { label: `${key}=${v}`, cfg }
  })
}

if (file) {
  const trace = parseTrace(JSON.parse(readFileSync(file, 'utf8')))
  const frames = trace.frames.length
  const dur = frames ? (trace.frames[frames - 1]!.t - trace.frames[0]!.t) / 1000 : 0
  console.log(`${file}: ${frames} frames, ${dur.toFixed(1)} s, ${(frames / Math.max(dur, 1e-3)).toFixed(1)} fps${trace.note ? ` — ${trace.note}` : ''}\n`)
  console.log('config'.padEnd(24), 'strokes', 'wobble px', 'points')
  for (const { label, cfg } of configsFor()) {
    const r = replay(trace, cfg)
    const w = r.strokes.length ? r.strokes.reduce((s, k) => s + wobble(k.points), 0) / r.strokes.length : 0
    console.log(label.padEnd(24), String(r.strokes.length).padStart(7), px(w).padStart(9), String(r.strokes.reduce((s, k) => s + k.points.length, 0)).padStart(6))
  }
} else {
  console.log(`Synthetic scenarios (modelled noise ×${noise}, ${seeds} seeds each). Distances in px on a 1600-px page.\n`)
  console.log('scenario'.padEnd(30), 'config'.padEnd(20), 'strokes', ' shape', 'wobble', '  hook', '  tail', 'excess', 'missing', 'points')
  for (const sc of SCENARIOS) {
    for (const { label, cfg } of configsFor()) {
      const acc = { strokes: 0, expected: 0, shape: 0, wobble: 0, tail: 0, hook: 0, excess: 0, missing: 0, points: 0 }
      for (let seed = 1; seed <= seeds; seed++) {
        const { trace, truth } = sc.build(seed)
        const r = replay(trace, cfg)
        const s = score(r, truthStrokes(truth, r.config, trace.videoAspect))
        acc.strokes += s.strokes
        acc.expected += s.expected
        acc.shape += s.shapeError
        acc.wobble += s.wobble
        acc.tail += s.tail
        acc.hook += s.hook
        acc.excess += s.excess
        acc.missing += s.missing
        acc.points += s.points
      }
      const k = 1 / seeds
      console.log(
        sc.title.slice(0, 30).padEnd(30),
        label.padEnd(20),
        `${(acc.strokes * k).toFixed(1)}/${acc.expected * k}`.padStart(7),
        px(acc.shape * k),
        px(acc.wobble * k),
        px(acc.hook * k),
        px(acc.tail * k),
        px(acc.excess * k),
        px(acc.missing * k).padStart(7),
        String(Math.round(acc.points * k)).padStart(6)
      )
    }
  }
}
