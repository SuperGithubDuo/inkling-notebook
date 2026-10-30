#!/usr/bin/env node
/**
 * Operator commands for Inkling's free AI server. There are no user accounts
 * or codes; this is only the emergency switch and today's totals.
 *
 *   export INKLING_BETA_URL=https://inkling-ai-beta.<you>.workers.dev
 *   export INKLING_ADMIN_TOKEN=…          # the value set with `wrangler secret put ADMIN_TOKEN`
 *
 *   npm run admin -- summary     → today's use (no identities)
 *   npm run admin -- pause       → stop all AI answers now (the app says the AI is paused)
 *   npm run admin -- resume
 *
 * The same switch is available without a terminal: push the branch
 * ops/pause or ops/resume (.github/workflows/beta-server-ops.yml).
 */
const base = (process.env.INKLING_BETA_URL ?? '').replace(/\/+$/, '')
const token = (process.env.INKLING_ADMIN_TOKEN ?? '').trim()
if (!base || !token) {
  console.error('Set INKLING_BETA_URL and INKLING_ADMIN_TOKEN first (see the comment at the top of this file).')
  process.exit(2)
}

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`${res.status}: ${text}`)
    process.exit(1)
  }
  return JSON.parse(text)
}

const [cmd] = process.argv.slice(2)
switch (cmd) {
  case 'summary':
    console.log(await call('GET', '/admin/summary'))
    break
  case 'pause':
  case 'resume':
    console.log(await call('POST', '/admin/pause', { paused: cmd === 'pause' }))
    break
  default:
    console.error('Commands: summary, pause, resume')
    process.exit(2)
}
