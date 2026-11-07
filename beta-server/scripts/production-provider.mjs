#!/usr/bin/env node
/**
 * Which provider the PRODUCTION Worker ("inkling-ai-beta") is configured with right now, read from
 * Cloudflare's own record of the deployed version (Workers script settings → bindings). Read-only.
 *
 *   node beta-server/scripts/production-provider.mjs [--expect deepinfra|workers-ai] [--script NAME]
 *
 * Prints `provider=<deepinfra|workers-ai|missing>` and, in GitHub Actions, sets it as a step output.
 * Exit codes: 0 = read (and matches --expect, if given); 1 = does not match; 2 = could not read
 * (callers must treat that as "unknown" and refuse to deploy: fail closed).
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Scripts: Read or Edit).
 */
import { appendFileSync } from 'node:fs'

/** The provider named by a Workers script-settings response (exported for tests). */
export function providerFromSettings(res) {
  if (!res || res.success !== true) return null
  const bindings = res.result?.bindings
  if (!Array.isArray(bindings)) return null
  const v = bindings.find((b) => b?.name === 'INFERENCE_PROVIDER' && (b.type === 'plain_text' || b.type === 'secret_text'))
  // No INFERENCE_PROVIDER binding: the Workers AI configuration (wrangler.jsonc), as before the migration.
  if (!v) return 'workers-ai'
  return typeof v.text === 'string' && v.text.trim() ? v.text.trim() : 'workers-ai'
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const expect = opt('--expect')
  const script = opt('--script') ?? 'inkling-ai-beta'
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env
  const out = (provider) => {
    console.log(`provider=${provider}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `provider=${provider}\n`)
  }
  if (!account || !token) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required')
    process.exit(2)
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/settings`
  let res
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      res = await r.json().catch(() => null)
      if (r.status === 404 || res?.errors?.some?.((e) => e.code === 10007)) {
        out('missing')
        process.exit(expect && expect !== 'missing' ? 1 : 0)
      }
      if (r.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 3000 * attempt))
  }
  const provider = providerFromSettings(res)
  if (!provider) {
    console.error(`could not read ${script}'s settings: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}`)
    process.exit(2)
  }
  out(provider)
  if (expect && provider !== expect) {
    console.error(`${script} runs ${provider}, expected ${expect}`)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
