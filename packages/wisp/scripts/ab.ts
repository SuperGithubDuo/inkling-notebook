/**
 * A/B: WISP v0.1.4 vs v0.1.5 (Smart Ink) on IDENTICAL input traces.
 *
 *   npm run ab                          the 12 required scenarios + adversarial traces (SYNTHETIC), 4 seeds
 *   npm run ab -- --seeds 8 --json      more seeds, machine-readable
 *   npm run ab -- --html ab.html        draw both pipelines' strokes per scenario
 *   npm run ab -- my-trace.json …       REAL recorded traces: truth-free comparison
 *
 * v0.1.4 = `smartInk: false`, which replays bit-identically to the v0.1.4
 * commit (tests/v015.test.ts). Synthetic results are a model, not a webcam
 * measurement; real traces are reported separately and say so.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { AB_CASES, PIPELINES, inkDifference, runAb, PAGE_H, PAGE_W, type AbMetrics } from '../src/replay/ab'
import { parseTrace } from '../src/replay/trace'
import { replay, truthStrokes, REPLAY_PROCESSOR, type ReplayResult, type StrokeTruth } from '../src/replay/replay'

const args = process.argv.slice(2)
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const seeds = Number(opt('--seeds') ?? 4)
const asJson = args.includes('--json')
const htmlOut = opt('--html')
const files = args.filter((a, i) => a.endsWith('.json') && args[i - 1] !== '--html' && !a.startsWith('--'))
const P = ['v0.1.4', 'v0.1.5'] as const

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
  const pt = (q: { x: number; y: number }) => `${((q.x - x0) * 1.6 * k).toFixed(1)},${((q.y - y0) * k).toFixed(1)}`
  const truth = (p.truth ?? []).map((t) => `<polyline points="${t.path.map(pt).join(' ')}" class="truth"/>`).join('')
  const ink = p.result.strokes.map((s, i) => `<polyline points="${s.points.map(pt).join(' ')}" class="ink" style="stroke:hsl(${(i * 67) % 360} 70% 35%)"/>`).join('')
  return `<figure><svg viewBox="0 0 ${(w * 1.6 * k).toFixed(0)} ${(h * k).toFixed(0)}">${truth}${ink}</svg><figcaption>${p.title} · ${p.result.strokes.length} stroke(s)</figcaption></figure>`
}
function writeHtml(path: string, heading: string, rows: Array<{ heading: string; panels: Panel[] }>): void {
  const body = rows.map((r) => `<h2>${r.heading}</h2><div class="row">${r.panels.map(svg).join('')}</div>`).join('\n')
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>WISP A/B</title><style>
body{font:14px system-ui;margin:20px;color:#1f2430} h2{font-size:15px;margin:24px 0 8px}
.row{display:flex;gap:16px;flex-wrap:wrap} figure{margin:0;border:1px solid #e7e7ea;border-radius:8px;padding:8px;background:#fff}
svg{width:460px;height:280px;display:block;background:#fff} figcaption{font-size:12px;color:#4b5160;margin-top:4px}
.truth{fill:none;stroke:#2f6be4;stroke-opacity:.22;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}
.ink{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
</style><h1>WISP v0.1.4 vs v0.1.5</h1><p>${heading}</p>${body}`
  )
  console.log(`\nWrote ${path}`)
}

const f1 = (v: number | undefined, d = 1) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))

// ── Real recorded traces ───────────────────────────────────────────────────
if (files.length) {
  console.log('REAL webcam traces — truth-free comparison (no intended paths are known)\n')
  const rows: Array<{ heading: string; panels: Panel[] }> = []
  for (const file of files) {
    const trace = parseTrace(JSON.parse(readFileSync(file, 'utf8')))
    const res = Object.fromEntries(P.map((p) => [p, replay(trace, PIPELINES[p])])) as Record<(typeof P)[number], ReplayResult>
    const diff = inkDifference(res['v0.1.4'], res['v0.1.5'])
    const longest = (r: ReplayResult) => Math.max(0, ...r.strokes.flatMap((s) => s.points.slice(1).map((q, i) => Math.hypot((q.x - s.points[i]!.x) * PAGE_W, (q.y - s.points[i]!.y) * PAGE_H))))
    const delay = (r: ReplayResult) => {
      const d = r.cursor.filter((q) => q.down)
      return d.length ? d.reduce((a, q) => a + ((q.at ?? q.t) - q.t), 0) / d.length : 0
    }
    const marks = (trace.events ?? []).filter((e) => e.type === 'mark').length
    console.log(`${file} (${trace.frames.length} frames${marks ? `, ${marks} "Mark glitch" presses` : ''})`)
    console.log('  pipeline  strokes  longest segment px  added delay ms  ms/frame')
    for (const p of P) console.log(`  ${p}    ${String(res[p].strokes.length).padStart(7)}  ${longest(res[p]).toFixed(0).padStart(18)}  ${delay(res[p]).toFixed(2).padStart(14)}  ${res[p].msPerFrame.toFixed(3)}`)
    console.log(`  ink only in v0.1.4 (removed by Smart Ink): ${diff.onlyA.toFixed(0)} px · ink only in v0.1.5: ${diff.onlyB.toFixed(0)} px`)
    console.log('  → Open the HTML (--html) and check that every removed piece was a stray line, not your writing.\n')
    rows.push({ heading: file, panels: P.map((p) => ({ title: p, result: res[p] })) })
  }
  if (htmlOut) writeHtml(htmlOut, 'REAL recorded trace(s). Thin coloured lines: strokes, one colour per stroke.', rows)
  process.exit(0)
}

// ── Synthetic scenarios ────────────────────────────────────────────────────
type Acc = Record<string, number>
const out: Array<{ id: string; title: string; required: number | null; adversarial: boolean; v014: Acc; v015: Acc }> = []
const html: Array<{ heading: string; panels: Panel[] }> = []
for (const c of AB_CASES) {
  const acc: Record<string, Acc> = { 'v0.1.4': {}, 'v0.1.5': {} }
  for (let seed = 1; seed <= seeds; seed++) {
    for (const p of P) {
      // Pipeline time: best of 3 runs (timer noise); metrics from the first.
      const runs = [runAb(c, seed, p), runAb(c, seed, p), runAb(c, seed, p)]
      const m: AbMetrics = { ...runs[0]!.metrics, msPerFrame: Math.min(...runs.map((r) => r.result.msPerFrame)) }
      for (const [k, v] of Object.entries(m)) if (typeof v === 'number') acc[p]![k] = (acc[p]![k] ?? 0) + v / seeds
      if (seed === 1 && htmlOut) {
        const truth = runs[0]!.built.truth ? truthStrokes(runs[0]!.built.truth!, { ...REPLAY_PROCESSOR, ...c.processor }, runs[0]!.built.trace.videoAspect) : undefined
        if (p === 'v0.1.4') html.push({ heading: `${c.required ? `${c.required}. ` : ''}${c.title}${c.adversarial ? ' (adversarial)' : ''}`, panels: [] })
        html.at(-1)!.panels.push({ title: p, truth, result: runs[0]!.result })
      }
    }
  }
  out.push({ id: c.id, title: c.title, required: c.required, adversarial: c.adversarial, v014: acc['v0.1.4']!, v015: acc['v0.1.5']! })
}

if (asJson) {
  console.log(JSON.stringify({ synthetic: true, seeds, cases: out }))
} else {
  console.log(`SYNTHETIC A/B (modelled hand + modelled MediaPipe noise; adversarial = deliberately corrupted landmarks). ${seeds} seeds per scenario; mean per run. Format: v0.1.4 → v0.1.5\n`)
  const col = (a: Acc, b: Acc, k: string, d = 1) => `${f1(a[k], d)}→${f1(b[k], d)}`.padStart(13)
  console.log('scenario                    strokes/exp   stray px  stray lines  lost strokes  missing px  short lost  start err  end err   broken  live lag px  delay ms  ms/frame')
  for (const r of out) {
    const { v014: a, v015: b } = r
    console.log(
      r.id.padEnd(26),
      `${f1(a.strokes)}→${f1(b.strokes)}/${f1(a.expected, 0)}`.padStart(13),
      col(a, b, 'strayPx', 0),
      col(a, b, 'strayLines', 2),
      col(a, b, 'lostStrokes', 2),
      col(a, b, 'missingPx', 0),
      `${f1(a.shortLost, 2)}→${f1(b.shortLost, 2)}/${f1(a.shortStrokes, 0)}`.padStart(13),
      col(a, b, 'startErrPx', 1),
      col(a, b, 'endErrPx', 1),
      col(a, b, 'broken', 2),
      col(a, b, 'liveLagPx', 1),
      col(a, b, 'addedDelayMs', 2),
      col(a, b, 'msPerFrame', 3)
    )
  }
  console.log('\nLayout (size and alignment): sizeCV %, size range ×, baseline spread px, line tilt °, inked %')
  for (const r of out.filter((x) => x.v014.sizeCV !== undefined)) {
    const { v014: a, v015: b } = r
    console.log(r.id.padEnd(26), col(a, b, 'sizeCV'), col(a, b, 'sizeRange', 2), col(a, b, 'baselineRMS'), col(a, b, 'lineTiltDeg', 2), col(a, b, 'inkedPct'))
  }
  console.log('\nShape (height ÷ width of a circle; 1.00 = round)')
  for (const r of out.filter((x) => x.v014.aspect !== undefined)) console.log(r.id.padEnd(26), col(r.v014, r.v015, 'aspect', 2))
  console.log('\nAdversarial: injected faults that produced a stray line ≥ 40 px (mean per run)')
  for (const r of out.filter((x) => x.adversarial)) console.log(r.id.padEnd(26), `${f1(r.v014.faultsWithStrayLine, 2)} → ${f1(r.v015.faultsWithStrayLine, 2)} of ${f1(r.v014.faults, 2)}`)
  const sum = (k: string, p: 'v014' | 'v015', adv: boolean) => out.filter((x) => x.adversarial === adv).reduce((a, x) => a + (x[p][k] ?? 0), 0)
  console.log('\nTotals (sum of per-run means):')
  for (const adv of [false, true]) {
    console.log(`  ${adv ? 'adversarial' : 'normal     '}  stray px ${sum('strayPx', 'v014', adv).toFixed(0)} → ${sum('strayPx', 'v015', adv).toFixed(0)} · stray lines ${sum('strayLines', 'v014', adv).toFixed(2)} → ${sum('strayLines', 'v015', adv).toFixed(2)} · missing px ${sum('missingPx', 'v014', adv).toFixed(0)} → ${sum('missingPx', 'v015', adv).toFixed(0)} · lost strokes ${sum('lostStrokes', 'v014', adv).toFixed(2)} → ${sum('lostStrokes', 'v015', adv).toFixed(2)}`)
  }
}
if (htmlOut) writeHtml(htmlOut, 'SYNTHETIC traces (seed 1). Wide pale blue: intended path. Thin coloured lines: strokes, one colour per stroke.', html)
