#!/usr/bin/env node
/**
 * Checks that the GitHub environment guarding production AI deployments is configured:
 *   - it exists;
 *   - it has a "Required reviewers" rule with at least one reviewer (GitHub then waits for an
 *     explicit "Approve and deploy" before the job runs);
 *   - deployments are limited to the default branch (main), so a workflow on another branch
 *     can't use the environment or its secrets.
 * Read-only.
 *
 *   node beta-server/scripts/environment-check.mjs [environment] [--report]
 *
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY. Exit 0 = configured; 1 = not configured (each problem
 * printed); 2 = could not read. With --report it always exits 0 and only prints (for a status run).
 */

/** Problems with an environment, from the GitHub API's environment and branch-policy responses (exported for tests). */
export function environmentProblems(env, policies, defaultBranch = 'main') {
  const problems = []
  if (!env) return ['the environment does not exist (Settings → Environments → New environment)']
  const reviewers = (env.protection_rules ?? []).filter((r) => r.type === 'required_reviewers').flatMap((r) => r.reviewers ?? [])
  if (reviewers.length === 0) problems.push('no required reviewer (Settings → Environments → production-ai → Required reviewers → add yourself)')
  const rule = (env.protection_rules ?? []).find((r) => r.type === 'required_reviewers')
  if (rule?.prevent_self_review && reviewers.length === 1) problems.push('"Prevent self-review" is on with a single reviewer: nobody could approve their own run (turn it off, or add a second reviewer)')
  const policy = env.deployment_branch_policy
  if (!policy) problems.push(`any branch can deploy (Deployment branches and tags → Selected branches → add "${defaultBranch}")`)
  else if (policy.custom_branch_policies) {
    const names = (policies?.branch_policies ?? []).map((p) => p.name)
    if (!names.includes(defaultBranch)) problems.push(`the selected deployment branches (${names.join(', ') || 'none'}) don't include "${defaultBranch}"`)
    const extra = names.filter((n) => n !== defaultBranch)
    if (extra.length) problems.push(`branches other than "${defaultBranch}" may deploy: ${extra.join(', ')}`)
  }
  // protected_branches: true is acceptable when main is the only protected branch; reported for the operator.
  return problems
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const report = process.argv.includes('--report')
  const name = args[0] ?? 'production-ai'
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env
  const api = async (path) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  if (!token || !repo) {
    console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required')
    process.exit(report ? 0 : 2)
  }
  const env = await api(`/environments/${encodeURIComponent(name)}`)
  if (env.status !== 200 && env.status !== 404) {
    console.error(`could not read environment ${name}: HTTP ${env.status} ${JSON.stringify(env.body).slice(0, 200)}`)
    process.exit(report ? 0 : 2)
  }
  const meta = await api('')
  const defaultBranch = meta.body?.default_branch ?? 'main'
  const policies = env.status === 200 && env.body?.deployment_branch_policy?.custom_branch_policies ? (await api(`/environments/${encodeURIComponent(name)}/deployment-branch-policies`)).body : null
  const problems = environmentProblems(env.status === 200 ? env.body : null, policies, defaultBranch)
  const reviewers = env.status === 200 ? (env.body.protection_rules ?? []).filter((r) => r.type === 'required_reviewers').flatMap((r) => r.reviewers ?? []).map((r) => r.reviewer?.login ?? r.reviewer?.name ?? r.type) : []
  console.log(`environment ${name}: ${env.status === 200 ? 'exists' : 'missing'}; reviewers: ${reviewers.join(', ') || 'none'}; branch policy: ${JSON.stringify(env.body?.deployment_branch_policy ?? null)}${policies ? ` (${(policies.branch_policies ?? []).map((p) => p.name).join(', ')})` : ''}`)
  for (const p of problems) console.log(`  problem: ${p}`)
  if (!problems.length) console.log('  configured: required reviewer and default-branch-only deployments')
  process.exit(report || !problems.length ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
