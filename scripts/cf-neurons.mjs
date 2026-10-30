#!/usr/bin/env node
/**
 * Workers AI Neurons the Cloudflare account used between two times, as
 * Cloudflare counts them (GraphQL Analytics, aiInferenceAdaptiveGroups).
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with
 * "Account Analytics: Read". Prints JSON; never throws.
 *
 *   node scripts/cf-neurons.mjs <startISO> [endISO]
 */
const [start, end = new Date().toISOString()] = process.argv.slice(2)
const query = `query($acct: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
      count
      sum { totalNeurons }
      dimensions { modelId }
    }
  } }
}`
async function run(q) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { acct: process.env.CLOUDFLARE_ACCOUNT_ID, start, end } })
  })
  return res.json()
}
try {
  let body = await run(query)
  // If a dimension name differs, fall back to the totals only.
  if (body.errors?.length && /modelId|dimensions/i.test(JSON.stringify(body.errors))) body = await run(query.replace(/\s*dimensions \{ modelId \}/, ''))
  if (body.errors?.length || !body.data) {
    console.log(JSON.stringify({ ok: false, error: (body.errors ?? []).map((e) => e.message).join('; ') || 'no data' }))
  } else {
    const groups = body.data.viewer.accounts[0]?.aiInferenceAdaptiveGroups ?? []
    const total = groups.reduce((n, g) => n + (g.sum?.totalNeurons ?? 0), 0)
    const requests = groups.reduce((n, g) => n + (g.count ?? 0), 0)
    const byModel = Object.fromEntries(groups.filter((g) => g.dimensions?.modelId).map((g) => [g.dimensions.modelId, { requests: g.count, neurons: g.sum.totalNeurons }]))
    console.log(JSON.stringify({ ok: true, start, end, requests, neurons: total, byModel }))
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
}
