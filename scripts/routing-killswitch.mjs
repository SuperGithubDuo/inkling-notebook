#!/usr/bin/env node
/**
 * One practice request and one typed chat request to an Inkling AI server, as a
 * fresh anonymous app would send them, to show which tasks are affected when
 * the text model is unavailable or switched off. Prints JSON; never throws.
 *
 *   node scripts/routing-killswitch.mjs <server URL> [label]
 *
 * Each result: HTTP status, whether an answer arrived (done) or the error code
 * and message the app would show. No content is printed beyond the error text.
 */
import { randomBytes } from 'node:crypto'

const [url, label = ''] = process.argv.slice(2)
const install = () => 'inst_' + randomBytes(24).toString('base64url')

async function ask(body) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/v1/tutor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkling-install': install(), 'x-inkling-notice': '3' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
      const j = await res.json().catch(() => ({}))
      return { status: res.status, answered: false, error: j.error?.code, message: j.error?.message }
    }
    const text = await res.text()
    const last = text.trim().split('\n\n').at(-1) ?? ''
    const event = /^event: (.+)$/m.exec(last)?.[1]
    const data = JSON.parse(/^data: (.*)$/m.exec(last)?.[1] ?? '{}')
    return { status: res.status, answered: event === 'done', neurons: data.neurons, ...(event === 'error' ? { error: data.code, message: data.message } : {}) }
  } catch (err) {
    return { status: 0, answered: false, error: 'network', message: String(err?.message ?? err) }
  }
}

const practice = await ask({ task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create 1 practice problems at easy difficulty on: solving linear equations.' }] }] })
const chat = await ask({ task: 'chat', turns: [{ role: 'user', parts: [{ text: '<notes title="Photosynthesis">The Calvin cycle happens in the stroma.</notes>' }, { text: 'Where does the Calvin cycle happen, according to my notes? One sentence.' }] }] })
console.log(JSON.stringify({ label, at: new Date().toISOString(), practice, chat }))
