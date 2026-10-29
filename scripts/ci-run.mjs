#!/usr/bin/env node
/**
 * Runs one CI command and, if it fails, turns the end of its output into
 * GitHub annotations, so failures can be read from the commit's check runs
 * (the checks API) without opening the log.
 *
 *   node scripts/ci-run.mjs "<label>" <command…>
 */
import { spawn } from 'node:child_process'

const [label, ...cmd] = process.argv.slice(2)
if (!label || !cmd.length) {
  console.error('usage: ci-run.mjs <label> <command…>')
  process.exit(2)
}
const tail = []
const keep = (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/)) {
    tail.push(line)
    if (tail.length > 400) tail.shift()
  }
}
const child = spawn(cmd.join(' '), { shell: true, stdio: ['inherit', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => (process.stdout.write(d), keep(d)))
child.stderr.on('data', (d) => (process.stderr.write(d), keep(d)))
child.on('close', (code) => {
  if (code === 0) return process.exit(0)
  const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  // eslint-disable-next-line no-control-regex
  const clean = tail.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim() && !/dbus|NODE_OPTION|DevTools listening/.test(l))
  // The most telling lines first (assertions, errors), then the last lines in order.
  const key = clean.filter((l) => /FAIL|Error|✗|×|assert|expected|Timeout|ENOENT|EPERM|cannot|⨯/i.test(l)).slice(-25)
  console.log(`::error title=${label} failed (exit ${code})::${esc(key.join('\n') || '(no error lines)')}`)
  console.log(`::error title=${label}: last output::${esc(clean.slice(-60).join('\n'))}`)
  process.exit(code ?? 1)
})
