/**
 * The guards around production deployments: reading which provider production runs, and the
 * production-ai approval environment's configuration. The workflows call these scripts and refuse
 * to deploy when they fail; here their decisions are tested on recorded API shapes.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { providerFromSettings } from '../../beta-server/scripts/production-provider.mjs'
import { environmentProblems } from '../../beta-server/scripts/environment-check.mjs'

const settings = (vars: Record<string, string>): unknown => ({
  success: true,
  result: { bindings: [{ name: 'AI', type: 'ai' }, { name: 'LEDGER', type: 'durable_object_namespace' }, ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))] }
})

describe('production provider, from the deployed Worker’s settings', () => {
  it('DeepInfra when INFERENCE_PROVIDER says so; Workers AI when it is absent (wrangler.jsonc)', () => {
    expect(providerFromSettings(settings({ INFERENCE_PROVIDER: 'deepinfra', MODEL: '@cf/qwen/qwen3.8-27b' }))).toBe('deepinfra')
    expect(providerFromSettings(settings({ MODEL: '@cf/qwen/qwen3.8-27b', ACCOUNT_PLAN: 'free' }))).toBe('workers-ai')
    expect(providerFromSettings(settings({ INFERENCE_PROVIDER: 'workers-ai' }))).toBe('workers-ai')
  })
  it('unreadable answers are unknown (callers refuse to deploy)', () => {
    expect(providerFromSettings({ success: false, errors: [{ code: 10000 }] })).toBeNull()
    expect(providerFromSettings(null)).toBeNull()
    expect(providerFromSettings({ success: true, result: {} })).toBeNull()
  })
})

describe('production-ai environment configuration', () => {
  const me = { type: 'User', reviewer: { login: 'operator' } }
  const good = { protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [me] }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }
  it('configured: a required reviewer and main-only deployments', () => {
    expect(environmentProblems(good, { branch_policies: [{ name: 'main' }] })).toEqual([])
  })
  it('each missing piece is named', () => {
    expect(environmentProblems(null, null)[0]).toMatch(/does not exist/)
    expect(environmentProblems({ ...good, protection_rules: [] }, { branch_policies: [{ name: 'main' }] })[0]).toMatch(/no required reviewer/)
    expect(environmentProblems({ ...good, deployment_branch_policy: null }, null)[0]).toMatch(/any branch can deploy/)
    expect(environmentProblems(good, { branch_policies: [{ name: 'main' }, { name: 'ops/*' }] })[0]).toMatch(/other than "main"/)
    expect(environmentProblems({ ...good, protection_rules: [{ ...good.protection_rules[0], prevent_self_review: true }] }, { branch_policies: [{ name: 'main' }] })[0]).toMatch(/self-review/)
  })
})

describe('no workflow can change the production Worker outside the manual, approved process', () => {
  const read = (f: string): string => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8')
  // Every workflow that runs `wrangler deploy` or sets a secret on the PRODUCTION Worker (wrangler.jsonc /
  // wrangler.deepinfra.jsonc, i.e. inkling-ai-beta).
  const production = ['ai-provider-switch.yml', 'beta-server.yml', 'ai-routing-smoke.yml']
  it.each(production)('%s: manual only, approval environment, shared production lock, provider guard', (f) => {
    const y = read(f)
    expect(y).not.toMatch(/^\s*push:/m)
    expect(y).toMatch(/environment: production-ai/)
    expect(y).toMatch(/group: beta-server-production/)
    expect(y).toMatch(/production-provider\.mjs/)
  })
  it('the test workflows deploy only their own Workers', () => {
    for (const f of ['ai-server-next.yml', 'ai-preflight.yml']) {
      const y = read(f)
      for (const line of y.split('\n').filter((l) => /wrangler (deploy|secret put)/.test(l) && !/^\s*#/.test(l))) {
        expect(line, `${f}: ${line.trim()}`).toMatch(/wrangler\.external\.jsonc|--name "\$NAME"|--name inkling-ai-next/)
      }
    }
  })
})

describe('Release workflow: unsigned builds stay beta-only', () => {
  const y = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  it('tells the app whether it was signed', () => {
    expect(y).toContain('MAIN_VITE_INKLING_SIGNED=1')
    expect(y).toContain('MAIN_VITE_INKLING_SIGNED=0')
  })
  it('refuses an unsigned stable draft release, and never calls unsigned updates authenticated', () => {
    expect(y).toMatch(/publish \}\}" = always \] && \[ "\$signed" = no \] && \[\[ "\$ver" != \*-\* \]\]; then[\s\S]{0,400}exit 1/)
    expect(y).toMatch(/NOT publisher-authenticated/)
  })
  it('passes the signing state to finalize-draft', () => {
    expect(y).toContain("WIN_SIGNED: ${{ secrets.WIN_CSC_LINK != '' }}")
    expect(y).toContain("MAC_SIGNED: ${{ secrets.MAC_CSC_LINK != '' }}")
  })
})
