#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_NOTICES.txt: every open-source package shipped inside
 * Inkling (the main process's runtime dependencies and everything bundled
 * into the window), with its licence text. Run before packaging
 * (`npm run dist` does). Fails on a licence that needs a decision before
 * shipping (copyleft or unknown), so nothing slips in unnoticed.
 *
 * Electron and Chromium's own notices are added by electron-builder
 * (LICENSE.electron.txt, LICENSES.chromium.html).
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/** Packages bundled into the renderer by Vite (devDependencies at install time, but shipped). */
const BUNDLED = [
  '@fontsource/caveat', '@fontsource/inter', '@pdf-lib/fontkit', '@tiptap/core', '@tiptap/extension-image', '@tiptap/extension-list',
  '@tiptap/extension-mathematics', '@tiptap/extension-table', '@tiptap/extensions', '@tiptap/markdown', '@tiptap/pm', '@tiptap/react',
  '@tiptap/starter-kit', 'd3-force', 'katex', 'konva', 'lucide-react', 'marked', 'pdf-lib', 'perfect-freehand', 'react', 'react-dom',
  'react-konva', 'zustand'
]
const OK = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|OFL-1\.1|Zlib|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Python-2\.0|MIT-0|CC-BY-4\.0)$/

const seen = new Map()
function findPackageDir(name, from) {
  // Packages with an "exports" map may hide package.json from require.resolve: walk node_modules instead.
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    try {
      readFileSync(join(candidate, 'package.json'))
      return candidate
    } catch {
      /* keep looking upwards */
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}
function walk(name, from) {
  const dir = findPackageDir(name, from)
  if (!dir || seen.has(dir)) return
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const license = typeof p.license === 'string' ? p.license : Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(' OR ') : p.license?.type ?? 'UNKNOWN'
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f))
  seen.set(dir, { name: p.name, version: p.version, license, text: file ? readFileSync(join(dir, file), 'utf8').trim() : null, homepage: p.homepage ?? p.repository?.url ?? '' })
  for (const dep of Object.keys(p.dependencies ?? {})) walk(dep, dir)
}
for (const name of [...Object.keys(pkg.dependencies), ...BUNDLED]) walk(name, root)

const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
const permitted = (l) => l.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/).every((part) => OK.test(part.trim())) || l.replace(/[()]/g, '').split(/\s+OR\s+/).some((part) => OK.test(part.trim()))
const flagged = all.filter((p) => !permitted(p.license))

const lines = [
  'Inkling includes the following open-source software. Each is used under its own licence, reproduced below.',
  '',
  ...all.map((p) => `- ${p.name} ${p.version} (${p.license})`),
  ''
]
for (const p of all) {
  lines.push('', '='.repeat(78), `${p.name} ${p.version} — ${p.license}`, p.homepage ? `${p.homepage}` : '', '-'.repeat(78), p.text ?? `Licensed under ${p.license}. (No licence file is included in the package.)`)
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), lines.join('\n') + '\n')

const counts = Object.entries(all.reduce((m, p) => ((m[p.license] = (m[p.license] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])
console.log(`THIRD_PARTY_NOTICES.txt: ${all.length} packages`)
for (const [l, n] of counts) console.log(`  ${l}: ${n}`)
if (flagged.length) {
  console.error(`\nLicences that need a decision before shipping:\n${flagged.map((p) => `  ${p.name} ${p.version}: ${p.license}`).join('\n')}`)
  process.exit(1)
}
