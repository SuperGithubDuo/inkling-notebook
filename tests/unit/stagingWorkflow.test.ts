/**
 * The staging workflow (.github/workflows/ai-accounts-staging.yml) and its config guard
 * (beta-server/scripts/staging-guard.mjs) can only ever deploy or delete the temporary Worker.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_STAGING_NEURONS, STAGING_NAME, parseJsonc, stagingProblems } from '../../beta-server/scripts/staging-guard.mjs'

const file = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const staging = () => parseJsonc(file('beta-server/wrangler.accounts-staging.jsonc'))
const production = [parseJsonc(file('beta-server/wrangler.jsonc')), parseJsonc(file('beta-server/wrangler.deepinfra.jsonc'))]
const wf = file('.github/workflows/ai-accounts-staging.yml')
/** The shell lines of the workflow (comments dropped). */
const lines = wf.split('\n').filter((l) => !/^\s*#/.test(l))

describe('staging config guard', () => {
  it('accepts the committed staging config', () => {
    expect(stagingProblems(staging(), production)).toEqual([])
    expect(staging().vars.GLOBAL_DAILY_NEURONS).toBe(String(MAX_STAGING_NEURONS))
  })

  it('refuses anything that could touch production or spend', () => {
    const bad = (change: (c: any) => void): string[] => {
      const c = structuredClone(staging())
      change(c)
      return stagingProblems(c, production)
    }
    expect(bad((c) => (c.name = 'inkling-ai-beta')).join()).toMatch(/production Worker/)
    expect(bad((c) => (c.name = 'something-else'))).not.toEqual([])
    expect(bad((c) => (c.routes = [{ pattern: 'example.com/*' }]))).not.toEqual([])
    expect(bad((c) => (c.durable_objects.bindings[0].script_name = 'inkling-ai-beta')).join()).toMatch(/binds another Worker/)
    expect(bad((c) => (c.vars.INFERENCE_PROVIDER = 'deepinfra')).join()).toMatch(/Workers AI only/)
    expect(bad((c) => (c.vars.GLOBAL_DAILY_NEURONS = '9000')).join()).toMatch(/GLOBAL_DAILY_NEURONS/)
    expect(bad((c) => (c.vars.GLOBAL_DAILY_NEURONS = undefined))).not.toEqual([])
    expect(bad((c) => (c.vars.ACCOUNT_PLAN = 'paid'))).not.toEqual([])
    expect(bad((c) => (c.vars.WEB_ORIGINS = 'https://supergithubduo.github.io'))).not.toEqual([])
    expect(bad((c) => (c.vars.SUPABASE_ANON_KEY = 'sb_secret_x'))).not.toEqual([])
    expect(bad((c) => (c.vars.INFERENCE_API_KEY = 'x'))).not.toEqual([])
  })
})

describe('staging workflow', () => {
  it('runs only by hand, from main, one at a time, with read-only repository access', () => {
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m)
    expect(wf).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run):/m)
    expect(wf).toContain('[ "${{ github.ref }}" = refs/heads/main ]')
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(wf).toMatch(/^concurrency:\n {2}group: ai-accounts-staging/m)
  })

  it('every wrangler command uses the staging config, and nothing passes --var or --name', () => {
    const wrangler = lines.filter((l) => /npx wrangler/.test(l))
    expect(wrangler.length).toBeGreaterThanOrEqual(2)
    for (const l of wrangler) expect(l, l).toMatch(/npx wrangler (deploy|secret put ADMIN_TOKEN) -c wrangler\.accounts-staging\.jsonc\b/)
    expect(lines.join('\n')).not.toMatch(/--var\b|--name\b|wrangler delete|wrangler\.deepinfra|-c wrangler\.jsonc/)
  })

  it('production is only read; the one removal names the staging Worker literally', () => {
    const writes = lines.filter((l) => /-X (DELETE|PUT|POST|PATCH)/.test(l))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(`/workers/scripts/${STAGING_NAME}?`)
    expect(writes[0]).not.toMatch(/\$PROD\b/)
    // $PROD appears only in read-only GETs (curl -sSf) and in comparisons that refuse it.
    for (const l of lines.filter((l) => /\$PROD\b/.test(l))) expect(l, l).toMatch(/curl -sSf -H|!= "\$PROD"/)
  })

  it('needs typed confirmation to deploy or remove, and fails closed without credentials', () => {
    expect(wf).toContain('[ "$CONFIRM" = "deploy inkling-ai-accounts-test" ]')
    expect(wf).toContain('[ "$CONFIRM" = "delete inkling-ai-accounts-test" ]')
    for (const s of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) expect(wf).toContain(`[ -n "$${s}" ] || missing+=(${s})`)
    expect(wf).toContain('[ ${#STAGING_ADMIN} -ge 32 ]')
  })

  it('never loads the DeepInfra key, and never reuses or prints the admin tokens', () => {
    expect(wf).not.toMatch(/DEEPINFRA|INFERENCE_API_KEY/)
    expect(wf).toContain('secrets.INKLING_STAGING_ADMIN_TOKEN')
    // The production admin token is only compared by hash, in one step's env.
    expect(wf.match(/secrets\.INKLING_ADMIN_TOKEN\b/g)).toHaveLength(1)
    expect(wf).toContain(`"$(printf '%s' "$STAGING_ADMIN" | sha256sum)" = "$(printf '%s' "$PROD_ADMIN" | sha256sum)"`)
    for (const l of lines) {
      expect(l, l).not.toMatch(/echo[^|]*\$(STAGING_ADMIN|PROD_ADMIN|CLOUDFLARE_API_TOKEN|token)\b/)
      expect(l, l).not.toMatch(/set -x|ACTIONS_STEP_DEBUG/)
    }
    // The staging admin token reaches wrangler through stdin only.
    expect(wf).toContain(`printf '%s' "$STAGING_ADMIN" | tr -d '\\r\\n' | npx wrangler secret put ADMIN_TOKEN -c wrangler.accounts-staging.jsonc`)
  })

  it('keeps the committed 400-Neuron cap and checks it on the running Worker', () => {
    expect(wf).toContain('.limits.globalDailyNeurons == 400')
    expect(wf).toContain('.accounts == "on"')
  })

  it('compares production before and after, even when a step fails', () => {
    expect(wf).toContain('name: Production snapshot (before; read-only)')
    expect(wf).toContain("if: always() && steps.before.outcome == 'success'")
    expect(wf).toContain('PRODUCTION CHANGED')
  })
})
