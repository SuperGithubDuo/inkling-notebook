import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as check from '../../beta-server/scripts/environment-check.mjs'

const good = {
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'operator' } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
}
const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }

describe('strict main-only approval policy', () => {
  it('rejects protected-branches mode because it does not prove main is the only allowed branch', () => {
    expect(check.environmentProblems({ ...good, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, null).join(' ')).toMatch(/selected|custom/i)
  })
  it('rejects a tag named main', () => {
    expect(check.environmentProblems(good, { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }).join(' ')).toMatch(/tag|branch/i)
  })
  it('rejects incomplete policy responses and a changed repository default', () => {
    expect(check.environmentProblems(good, { ...policies, total_count: 2 }).length).toBeGreaterThan(0)
    expect(check.environmentProblems(good, policies, 'develop').length).toBeGreaterThan(0)
  })
})

describe('environment API access fails closed', () => {
  const invoke = async (responses: Record<string, { status: number; body: unknown }>) => {
    const api = vi.fn(async (url: string) => {
      const path = new URL(url).pathname.replace('/repos/owner/repo', '')
      const response = responses[path] ?? { status: 404, body: {} }
      return { status: response.status, json: async () => response.body }
    })
    const fn = (check as unknown as { checkEnvironment: (options: unknown) => Promise<{ problems: string[] }> }).checkEnvironment
    return fn({ token: 'test-token', repo: 'owner/repo', name: 'production-ai', fetch: api })
  }
  const ok = {
    '': { status: 200, body: { default_branch: 'main' } },
    '/environments/production-ai': { status: 200, body: good },
    '/environments/production-ai/deployment-branch-policies': { status: 200, body: policies }
  }
  it('reads environment, reviewers, branch policies and repository metadata', async () => {
    await expect(invoke(ok)).resolves.toMatchObject({ problems: [] })
  })
  it.each(['', '/environments/production-ai', '/environments/production-ai/deployment-branch-policies'])('refuses inaccessible API response %s', async (path) => {
    await expect(invoke({ ...ok, [path]: { status: 403, body: { message: 'Resource not accessible by integration' } } })).rejects.toThrow(/HTTP 403/)
  })
  it('does not default an unreadable default branch to main', async () => {
    await expect(invoke({ ...ok, '': { status: 200, body: {} } })).rejects.toThrow(/default branch/i)
  })
  it('reports a missing environment as a blocking problem', async () => {
    await expect(invoke({ ...ok, '/environments/production-ai': { status: 404, body: {} } })).resolves.toMatchObject({ problems: [expect.stringMatching(/does not exist/)] })
  })
})

describe('workflow minimum API permissions', () => {
  it.each(['ai-provider-switch.yml', 'ai-preflight.yml'])('%s grants Actions read, not unnecessary Deployments read', (name) => {
    const source = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
    expect(source).toMatch(/^  actions: read\r?$/m)
    expect(source).not.toMatch(/^  deployments:/m)
  })
  it('the switch gate explicitly rejects non-main refs before requesting approval', () => {
    const source = readFileSync(new URL('../../.github/workflows/ai-provider-switch.yml', import.meta.url), 'utf8')
    expect(source).toContain('[ "$GITHUB_REF" = refs/heads/main ]')
  })
})
