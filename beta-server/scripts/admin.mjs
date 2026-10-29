#!/usr/bin/env node
/**
 * Manage beta testers from your terminal.
 *
 *   export INKLING_BETA_URL=https://inkling-ai-beta.<you>.workers.dev
 *   export INKLING_ADMIN_TOKEN=…          # the value you set with `wrangler secret put ADMIN_TOKEN`
 *
 *   npm run admin -- add "Ada (class 10B)" [--neurons 900]   → prints the tester's access code ONCE
 *   npm run admin -- list                                      → testers and today's use
 *   npm run admin -- summary                                   → the whole beta today
 *   npm run admin -- revoke t_abc123 | restore t_abc123
 *   npm run admin -- limit t_abc123 600                        → daily Neurons for one tester
 *   npm run admin -- pause | resume                            → stop or restart all AI answers
 */
const base = (process.env.INKLING_BETA_URL ?? '').replace(/\/+$/, '')
const token = process.env.INKLING_ADMIN_TOKEN ?? ''
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

const [cmd, ...args] = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}

switch (cmd) {
  case 'add': {
    const neurons = flag('neurons')
    const name = args.join(' ').trim()
    if (!name) throw new Error('Usage: add "<tester name>" [--neurons N]')
    const t = await call('POST', '/admin/testers', { name, ...(neurons ? { dailyNeurons: Number(neurons) } : {}) })
    console.log(`Added ${t.name} (${t.id}), ${t.dailyNeurons} Neurons a day.\n`)
    console.log('Send the tester these two values (they go in Inkling → Settings → AI Tutor → Inkling beta):')
    console.log(`  Server:      ${base}`)
    console.log(`  Access code: ${t.accessCode}`)
    console.log('\nThe code is shown only now. If it is lost, revoke it and add the tester again.')
    break
  }
  case 'list': {
    const { testers } = await call('GET', '/admin/testers')
    console.table(testers.map((t) => ({ id: t.id, name: t.name, revoked: t.revoked, dailyNeurons: t.dailyNeurons, usedToday: Math.round(t.usedToday), requestsToday: t.requestsToday })))
    break
  }
  case 'summary':
    console.log(await call('GET', '/admin/summary'))
    break
  case 'revoke':
  case 'restore':
    console.log(await call('PATCH', `/admin/testers/${args[0]}`, { revoked: cmd === 'revoke' }))
    break
  case 'limit':
    console.log(await call('PATCH', `/admin/testers/${args[0]}`, { dailyNeurons: Number(args[1]) }))
    break
  case 'pause':
  case 'resume':
    console.log(await call('POST', '/admin/pause', { paused: cmd === 'pause' }))
    break
  default:
    console.error('Commands: add, list, summary, revoke, restore, limit, pause, resume')
    process.exit(2)
}
