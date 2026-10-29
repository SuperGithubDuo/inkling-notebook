/**
 * A Workers AI binding (`run(model, inputs)`) over Cloudflare's REST API, so
 * the beta server code can run on this computer against the REAL model,
 * without deploying a Worker. Only for live tests: it needs an API token,
 * which a deployed Worker never does.
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/{model}
 *
 * Streaming answers come back as the response body (server-sent events);
 * others inside `{ result }`. Errors arrive as `{ errors: [{ code, message }] }`
 * and are thrown as "code: message", the way the binding reports them.
 */
export function workersAiRest({ accountId, apiToken, onCall } = {}) {
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required')
  const calls = []
  return {
    calls,
    async run(model, inputs) {
      const started = Date.now()
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(inputs)
      })
      const call = { model, inputs, status: res.status, ms: Date.now() - started }
      calls.push(call)
      onCall?.(call)
      const type = res.headers.get('content-type') ?? ''
      if (res.ok && type.includes('text/event-stream')) return res.body
      const text = await res.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`${res.status}: ${text.slice(0, 200)}`)
      }
      if (!res.ok || body.success === false) {
        const e = body.errors?.[0]
        throw new Error(e ? `${e.code}: ${e.message}` : `${res.status}: ${text.slice(0, 200)}`)
      }
      return body.result ?? body
    }
  }
}
