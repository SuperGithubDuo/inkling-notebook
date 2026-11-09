/**
 * wisp-motion research CLI (local only; no network, no video).
 *
 *   npm run motion -- validate traces/*.json            check traces for research use
 *   npm run motion -- manifest data/ --name pilot-1     versioned manifest (dataset id = hash of contents)
 *   npm run motion -- split data/manifest.json --by participant
 *   npm run motion -- features trace.json --csv out.csv [--labels trace.annotations.json]
 *   npm run motion -- baseline --manifest data/manifest.json   Task A baselines on labelled real data
 *   npm run motion -- baseline --synthetic                     the same on SYNTHETIC labelled traces
 *   npm run motion -- synth out/                               write the synthetic set (+ annotations, manifest)
 *
 * See src/wisp-motion/README.md for the protocol and what each step means.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseTrace, type LandmarkTrace } from '../src/replay/trace'
import { buildManifest, checkLeakage, groupSplit, validateTrace, type Manifest, type ManifestEntry } from '../src/wisp-motion/dataset'
import { extractFeatures, featuresToCsv } from '../src/wisp-motion/features'
import { ANNOTATION_FORMAT, frameLabels, marksToAnnotations, validateAnnotations, type Annotation, type AnnotationFile } from '../src/wisp-motion/labels'
import { DETECTORS, scoreDetection } from '../src/wisp-motion/baselines'
import { faultAnnotations, syntheticDataset } from '../src/wisp-motion/synthetic'

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const args = process.argv.slice(2)
const cmd = args[0]
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.json') && !name.endsWith('.annotations.json') && name !== 'manifest.json') out.push(p)
  }
  return out.sort()
}

function load(file: string): { raw: unknown; trace: LandmarkTrace; bytes: Buffer } {
  const bytes = readFileSync(file)
  const raw = JSON.parse(bytes.toString('utf8'))
  return { raw, trace: parseTrace(raw), bytes }
}

const sidecar = (file: string) => file.replace(/\.json$/, '.annotations.json')

function annotationsFor(file: string, trace: LandmarkTrace): { spans: Annotation[]; file?: string; sha?: string } {
  try {
    const b = readFileSync(sidecar(file))
    const a = JSON.parse(b.toString('utf8')) as AnnotationFile
    const errs = validateAnnotations(a, trace)
    if (errs.length) throw new Error(`${sidecar(file)}: ${errs.join('; ')}`)
    return { spans: a.annotations, file: sidecar(file), sha: sha256(b) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { spans: marksToAnnotations(trace) }
    throw e
  }
}

const pct = (v: number) => `${(100 * v).toFixed(1)} %`

switch (cmd) {
  case 'validate': {
    let bad = 0
    for (const f of positional) {
      try {
        const { raw, trace } = load(f)
        const v = validateTrace(raw, trace)
        const s = v.stats
        console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${f}  v${trace.version}  ${s.frames} frames  ${(s.durationMs / 1000).toFixed(1)} s  tracked ${pct(s.tracked)}  dt ${s.medianDtMs.toFixed(1)}/${s.p95DtMs.toFixed(1)} ms (median/p95)  marks ${s.marks}`)
        for (const e of v.errors) console.log(`     error: ${e}`)
        for (const w of v.warnings) console.log(`     warning: ${w}`)
        if (!v.ok) bad++
      } catch (e) {
        bad++
        console.log(`FAIL ${f}: ${(e as Error).message}`)
      }
    }
    process.exitCode = bad ? 1 : 0
    break
  }
  case 'manifest': {
    const root = positional[0] ?? '.'
    const entries: ManifestEntry[] = []
    let sources = new Set<string>()
    for (const f of walk(root)) {
      const { raw, trace, bytes } = load(f)
      const v = validateTrace(raw, trace)
      if (!v.ok) {
        console.error(`skipped ${f}: ${v.errors.join('; ')}`)
        continue
      }
      sources.add(trace.meta?.device === 'synthetic' ? 'synthetic' : 'real')
      const ann = annotationsFor(f, trace)
      entries.push({
        file: relative(root, f),
        sha256: sha256(bytes),
        participant: trace.meta?.participant ?? null,
        session: trace.meta?.session ?? null,
        task: trace.meta?.task ?? null,
        frames: v.stats.frames,
        durationMs: v.stats.durationMs,
        marks: v.stats.marks,
        ...(ann.file ? { annotations: { file: relative(root, ann.file), sha256: ann.sha!, spans: ann.spans.length } } : {})
      })
    }
    const source = sources.size > 1 ? 'mixed' : ([...sources][0] as 'real' | 'synthetic') ?? 'real'
    const m = buildManifest(opt('--name') ?? 'wisp-motion', source, entries, sha256)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(m, null, 2))
    console.log(`manifest: ${entries.length} recordings, ${new Set(entries.map((e) => e.participant)).size} participants, source ${source}, id ${m.id.slice(0, 16)}…`)
    break
  }
  case 'split': {
    const m = JSON.parse(readFileSync(positional[0]!, 'utf8')) as Manifest
    const split = groupSplit(m.entries, { by: (opt('--by') as 'participant' | 'session') ?? 'participant', seed: opt('--seed') ?? m.id })
    const leaks = checkLeakage(m.entries, split)
    console.log(JSON.stringify({ dataset: m.id, ...split, leakage: leaks }, null, 2))
    if (leaks.length) process.exitCode = 1
    break
  }
  case 'features': {
    const f = positional[0]!
    const { trace } = load(f)
    const table = extractFeatures(trace)
    const ann = annotationsFor(f, trace)
    const csv = featuresToCsv(table, frameLabels(trace, ann.spans))
    const out = opt('--csv')
    if (out) writeFileSync(out, csv)
    else console.log(csv.split('\n').slice(0, 5).join('\n') + `\n… ${table.rows.length} rows, ${table.names.length} features`)
    break
  }
  case 'baseline': {
    let items: Array<{ trace: LandmarkTrace; labels: ReadonlyArray<0 | 1 | null>; participant: string }>
    let what: string
    if (args.includes('--synthetic')) {
      items = syntheticDataset().map((s) => ({ trace: s.trace, labels: frameLabels(s.trace, faultAnnotations(s.faults)), participant: s.participant }))
      what = 'SYNTHETIC traces (modelled hand, modelled noise, injected faults) — a sanity check, not a webcam result'
    } else {
      const mf = opt('--manifest')
      if (!mf) throw new Error('baseline needs --manifest <file> or --synthetic')
      const m = JSON.parse(readFileSync(mf, 'utf8')) as Manifest
      const root = dirname(mf)
      items = m.entries.map((e) => {
        const { trace } = load(join(root, e.file))
        return { trace, labels: frameLabels(trace, annotationsFor(join(root, e.file), trace).spans), participant: e.participant ?? 'unknown' }
      })
      what = `dataset ${m.id.slice(0, 16)}… (${m.source}); labels: annotation sidecars, else "Mark glitch" presses (weak)`
    }
    console.log(`Task A baselines on ${items.length} traces — ${what}`)
    console.log('detector        frames  errors  precision  recall   F1     events  event-recall  false alarms/min')
    for (const [name, det] of Object.entries(DETECTORS)) {
      const s = scoreDetection(items, det)
      console.log(`${name.padEnd(14)} ${String(s.framesLabelled).padStart(7)} ${String(s.errorFrames).padStart(7)}   ${s.precision.toFixed(3)}    ${s.recall.toFixed(3)}  ${s.f1.toFixed(3)}  ${String(s.events).padStart(6)}     ${pct(s.eventRecall).padStart(7)}       ${s.falseAlarmsPerMin.toFixed(2)}`)
    }
    // Per held-out participant (what a participant-independent evaluation reports).
    if (args.includes('--per-participant')) {
      for (const p of [...new Set(items.map((i) => i.participant))]) {
        const s = scoreDetection(items.filter((i) => i.participant === p), DETECTORS['guard-v0.1.5']!)
        console.log(`  ${p}: guard F1 ${s.f1.toFixed(3)}, event recall ${pct(s.eventRecall)}, false alarms/min ${s.falseAlarmsPerMin.toFixed(2)}`)
      }
    }
    break
  }
  case 'synth': {
    const root = positional[0] ?? 'wisp-motion-synthetic'
    const items = syntheticDataset()
    for (const it of items) {
      const p = join(root, it.file)
      mkdirSync(dirname(p), { recursive: true })
      const body = JSON.stringify(it.trace)
      writeFileSync(p, body)
      const ann: AnnotationFile = { format: ANNOTATION_FORMAT, version: 1, trace: sha256(body), annotations: faultAnnotations(it.faults) }
      writeFileSync(sidecar(p), JSON.stringify(ann))
    }
    console.log(`wrote ${items.length} SYNTHETIC traces with annotation sidecars to ${root}/ — now run: npm run motion -- manifest ${root} --name synthetic`)
    break
  }
  default:
    console.log(readFileSync(new URL(import.meta.url)).toString('utf8').split('*/')[0])
}
