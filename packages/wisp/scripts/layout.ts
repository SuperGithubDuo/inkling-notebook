/**
 * Layout comparison (v0.1.4): letter size, baseline and reachability on
 * physical-writing scenes, for each mapping, on identical synthetic traces.
 *
 *   npm run layout                 webcam-like noise, 4 seeds
 *   npm run layout -- --seeds 8 --profile model --json
 *
 * Synthetic (modelled hand and noise) — not a webcam measurement.
 */
import { LAYOUT_CONFIGS, buildScene, fittedRegion, layoutMetrics, notationError, placeScene, replayLayout, DEFAULT_NOISE, WEBCAM_NOISE } from '../src/replay/layout'
import { LAYOUT_SCENES } from '../src/replay/layoutScenes'
import { boundaryReport } from '../src/replay/boundary'
import { tidyLines } from '../src/strokes/layout'

const args = process.argv.slice(2)
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const seeds = Number(opt('--seeds') ?? 4)
const noise = (opt('--profile') ?? 'webcam') === 'model' ? DEFAULT_NOISE : WEBCAM_NOISE
const asJson = args.includes('--json')
const page = { width: 1600, height: 1000, background: '#ffffff' }

const configs = [...Object.entries(LAYOUT_CONFIGS), ['Writing Assist + Tidy lines', LAYOUT_CONFIGS['Writing Assist']!, true] as const].map((c) => ({ label: c[0] as string, cfg: c[1], tidy: c.length > 2 }))
const rows: Array<Record<string, number | string>> = []
for (const def of LAYOUT_SCENES) {
  for (const c of configs) {
    const acc: Record<string, number> = {}
    for (let seed = 1; seed <= seeds; seed++) {
      // Same writing and noise for every mapping, placed on the page that mapping shows the user.
      const { trace, tags } = buildScene(placeScene(def.scene, fittedRegion(c.cfg, seed, noise)), seed, noise)
      const r = replayLayout(trace, c.cfg)
      const strokes = c.tidy ? tidyLines(r.strokes, page).strokes : r.strokes
      const m: Record<string, number> = { ...layoutMetrics(r, strokes, tags, def.lineOf) }
      if (def.notation) {
        const ne = notationError(strokes, tags)
        m.notationSize = ne.sizeErr
        m.notationOffset = ne.offsetErr
      }
      m.strokes = r.strokes.length
      for (const [k, v] of Object.entries(m)) acc[k] = (acc[k] ?? 0) + (Number.isFinite(v) ? v : 0) / seeds
    }
    rows.push({ scene: def.scene.id, config: c.label, ...acc })
  }
}
const boundary = boundaryReport(seeds, noise)
if (asJson) console.log(JSON.stringify({ rows, boundary }))
else {
  const f = (v: unknown, d = 1) => (typeof v === 'number' ? v.toFixed(d) : String(v ?? '')).padStart(7)
  console.log('scene        config                         sizeCV% range  xh px  base± tilt° wTilt° shape  inked% cur-ink notation(size,off)')
  for (const r of rows)
    console.log(String(r.scene).padEnd(12), String(r.config).padEnd(30), f(r.sizeCV), f(r.sizeRange, 2), f(r.xHeight), f(r.baselineRMS), f(r.lineTiltDeg, 2), f(r.wordTiltDeg, 2), f(r.shapeResidual), f(r.inked), f(r.cursorInk), r.notationSize !== undefined ? `${f(r.notationSize, 3)} ${f(r.notationOffset, 3)}` : '')
  console.log('\nBoundary reach (px from each page edge the ink got to; corners reached of 4):')
  for (const b of boundary) console.log(String(b.config).padEnd(30), `top ${f(b.top)} bottom ${f(b.bottom)} left ${f(b.left)} right ${f(b.right)}  corners ${f(b.corners)}  lost frames ${f(b.lostFrames, 0)}`)
}
