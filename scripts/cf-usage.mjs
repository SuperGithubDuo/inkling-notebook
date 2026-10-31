#!/usr/bin/env node
/**
 * The Cloudflare account's Workers AI use, hour by hour, as Cloudflare counts
 * it (GraphQL Analytics, aiInferenceAdaptiveGroups), with the total for each
 * UTC calendar day and for the rolling 24 hours ending at each hour. Used to
 * tell whether Workers AI's free allocation (10,000 Neurons) behaves as a
 * calendar day reset at 00:00 UTC or as a rolling window.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with "Account
 * Analytics: Read". Counts only: no content. Never throws.
 *
 *   node scripts/cf-usage.mjs [hours=48]
 */
const hours = Math.max(1, Math.min(168, Number(process.argv[2] ?? 48)))
const end = new Date()
const start = new Date(Math.floor(end.getTime() / 3_600_000) * 3_600_000 - (hours - 1) * 3_600_000)

const query = (dims, order = true) => `query($acct: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }${order ? ', orderBy: [datetimeHour_ASC]' : ''}) {
      count
      sum { totalNeurons }
      dimensions { ${dims} }
    }
  } }
}`

async function run(q) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { acct: process.env.CLOUDFLARE_ACCOUNT_ID, start: start.toISOString(), end: end.toISOString() } })
  })
  return res.json()
}

try {
  let body = await run(query('datetimeHour modelId'))
  if (body.errors?.length && /orderBy/i.test(JSON.stringify(body.errors))) body = await run(query('datetimeHour modelId', false))
  if (body.errors?.length && /modelId/i.test(JSON.stringify(body.errors))) body = await run(query('datetimeHour', false))
  if (body.errors?.length || !body.data) {
    console.log(JSON.stringify({ ok: false, error: (body.errors ?? []).map((e) => e.message).join('; ') || 'no data' }))
    process.exit(0)
  }
  const groups = body.data.viewer.accounts[0]?.aiInferenceAdaptiveGroups ?? []
  const byHour = new Map()
  for (const g of groups) {
    const h = new Date(g.dimensions.datetimeHour).toISOString()
    const cur = byHour.get(h) ?? { requests: 0, neurons: 0, models: new Set() }
    cur.requests += g.count ?? 0
    cur.neurons += g.sum?.totalNeurons ?? 0
    if (g.dimensions.modelId) cur.models.add(g.dimensions.modelId)
    byHour.set(h, cur)
  }
  const rows = []
  for (let t = start.getTime(); t <= end.getTime(); t += 3_600_000) {
    const h = new Date(t).toISOString()
    const v = byHour.get(h) ?? { requests: 0, neurons: 0, models: new Set() }
    let rolling = 0
    for (let k = t - 23 * 3_600_000; k <= t; k += 3_600_000) rolling += byHour.get(new Date(k).toISOString())?.neurons ?? 0
    rows.push({ hour: h.slice(0, 13) + ':00Z', requests: v.requests, neurons: Math.round(v.neurons), rolling24h: Math.round(rolling), models: [...v.models].join(' ') })
  }
  const days = {}
  for (const r of rows) days[r.hour.slice(0, 10)] = (days[r.hour.slice(0, 10)] ?? 0) + r.neurons
  const peak = rows.reduce((a, b) => (b.rolling24h > a.rolling24h ? b : a), rows[0])
  console.log(JSON.stringify({ ok: true, start: start.toISOString(), end: end.toISOString(), rollingNow: rows.at(-1)?.rolling24h ?? 0, utcDays: days, peakRolling24h: peak, hours: rows.filter((r) => r.requests > 0) }))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
}
