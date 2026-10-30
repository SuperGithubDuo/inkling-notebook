#!/usr/bin/env node
/**
 * Runs one CI command and, if it fails, turns the end of its output into
 * GitHub annotations, so failures can be read from the commit's check runs
 * (the checks API) without opening the log.
 *
 *   node scripts/ci-run.mjs "<label>" <command…>
 *
 * A command that runs longer than CI_RUN_TIMEOUT_MIN minutes (default 20) is
 * stopped and reported the same way, so a hang shows where it hung.
 */
import { spawn, spawnSync } from 'node:child_process'

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
const win = process.platform === 'win32'
// One argument is a shell command line; several are arguments, quoted where needed.
const quote = (a) => (/[\s"'()$`&|<>;]/.test(a) ? `"${a.replace(/(["\\$`])/g, '\\$1')}"` : a)
const line = cmd.length === 1 ? cmd[0] : cmd.map(quote).join(' ')
const child = spawn(line, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], detached: !win })
let timedOut = false
const limitMin = Number(process.env.CI_RUN_TIMEOUT_MIN) || 20
const timer = setTimeout(() => {
  timedOut = true
  console.log(`\n[ci-run] ${label}: no result after ${limitMin} minutes; stopping it.`)
  // The whole tree: Electron and its helpers too.
  if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}, limitMin * 60_000)
child.stdout.on('data', (d) => (process.stdout.write(d), keep(d)))
child.stderr.on('data', (d) => (process.stderr.write(d), keep(d)))
child.on('close', (exitCode) => {
  clearTimeout(timer)
  const code = timedOut ? 124 : exitCode
  if (code === 0) {
    // Evidence of what passed, readable from the checks API.
    const passed = tail.filter((l) => /^\s*✓/.test(l)).map((l) => l.trim())
    if (passed.length) console.log(`::notice title=${label} passed::${passed.join('\n').replace(/%/g, '%25').replace(/\n/g, '%0A').slice(0, 6000)}`)
    return process.exit(0)
  }
  const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  // eslint-disable-next-line no-control-regex
  const clean = tail.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim() && !/dbus|NODE_OPTION|DevTools listening/.test(l))
  // The most telling lines first (assertions, errors), then the last lines in order.
  const key = clean.filter((l) => /FAIL|Error|✗|×|assert|expected|Timeout|ENOENT|EPERM|cannot|⨯/i.test(l)).slice(-25)
  console.log(`::error title=${label} ${timedOut ? `timed out after ${limitMin} min` : `failed (exit ${code})`}::${esc(key.join('\n') || '(no error lines)')}`)
  console.log(`::error title=${label}: last output::${esc(clean.slice(-60).join('\n'))}`)
  process.exit(code ?? 1)
})
