/** The temporary staging Worker (beta-server/wrangler.accounts-staging.jsonc) can't touch production. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accounts, inference, limits, type Env } from '../../beta-server/src/config'

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../beta-server/${file}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))

describe('staging Worker config', () => {
  const staging = read('wrangler.accounts-staging.jsonc')
  const production = read('wrangler.deepinfra.jsonc')

  it('is a separate Worker: its own name, ledger (Durable Object) and no routes', () => {
    expect(staging.name).toBe('inkling-ai-accounts-test')
    expect(staging.name).not.toBe(production.name)
    expect(read('wrangler.jsonc').name).toBe(production.name)
    // A binding without script_name is this Worker's own class, so its own storage.
    for (const b of staging.durable_objects.bindings) expect(b.script_name).toBeUndefined()
    for (const k of ['routes', 'route', 'services', 'kv_namespaces', 'd1_databases', 'r2_buckets']) expect(staging[k], k).toBeUndefined()
  })

  it('runs on Workers AI Free with a tiny cap, no browser access and no secrets in vars', () => {
    const env = { ...staging.vars, AI: {} } as Env
    expect(env.INFERENCE_PROVIDER).toBeUndefined()
    expect(typeof inference(env)).not.toBe('string')
    expect(limits(env).globalDailyNeurons).toBeLessThanOrEqual(500)
    expect(env.WEB_ORIGINS).toBe('')
    expect(env.SUPABASE_ANON_KEY).toMatch(/^sb_publishable_/)
    expect(JSON.stringify(staging)).not.toMatch(/service_role|sb_secret_|INFERENCE_API_KEY|ADMIN_TOKEN"\s*:/)
    const verify = accounts(env)
    expect(verify).toBeTypeOf('function')
    expect(verify!.misconfigured).toBeUndefined()
  })
})
