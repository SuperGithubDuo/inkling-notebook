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

import { pathToFileURL } from 'node:url'

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
  else if (policy.custom_branch_policies !== true || policy.protected_branches !== false) {
    problems.push('use Selected branches (custom branch policies), not all protected branches: only main may deploy')
  } else {
    const branches = policies?.branch_policies
    if (!Array.isArray(branches) || !Number.isInteger(policies?.total_count) || policies.total_count !== branches.length) {
      problems.push('deployment branch policies are unreadable or incomplete')
    } else {
      if (!branches.some((p) => p.name === 'main' && p.type === 'branch')) problems.push('the selected deployment branches do not include the main branch')
      const extra = branches.filter((p) => p.name !== 'main' || p.type !== 'branch')
      if (extra.length) problems.push(`branches or tags other than "main" may deploy: ${extra.map((p) => `${p.type ?? 'unknown'}:${p.name}`).join(', ')}`)
    }
  }
  if (defaultBranch !== 'main') problems.push('the repository default branch must be main')
  return problems
}

// Both environment endpoints require Actions: read; repository metadata needs implicit Metadata: read.
export async function checkEnvironment({ token, repo, name = 'production-ai', fetch: request = globalThis.fetch }) {
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required')
  const api = async (path, missingAllowed = false) => {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000)
    })
    if (missingAllowed && response.status === 404) return null
    if (response.status !== 200) throw new Error(`could not read ${path || 'repository'}: HTTP ${response.status}`)
    const body = await response.json()
    if (!body || typeof body !== 'object') throw new Error(`invalid API response for ${path || 'repository'}`)
    return body
  }
  const env = await api(`/environments/${encodeURIComponent(name)}`, true)
  const meta = await api('')
  if (typeof meta.default_branch !== 'string' || !meta.default_branch) throw new Error('could not read repository default branch')
  const policies = env?.deployment_branch_policy?.custom_branch_policies
    ? await api(`/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`) : null
  return { env, policies, defaultBranch: meta.default_branch, problems: environmentProblems(env, policies, meta.default_branch) }
}

async function main() {
  const name = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'production-ai'
  const report = process.argv.includes('--report')
  try {
    const { env, policies, problems } = await checkEnvironment({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, name })
    const reviewers = (env?.protection_rules ?? []).filter((r) => r.type === 'required_reviewers').flatMap((r) => r.reviewers ?? []).map((r) => r.reviewer?.login ?? r.reviewer?.name ?? r.type)
    console.log(`environment ${name}: ${env ? 'exists' : 'missing'}; reviewers: ${reviewers.join(', ') || 'none'}; branch policy: ${JSON.stringify(env?.deployment_branch_policy ?? null)}${policies ? ` (${(policies.branch_policies ?? []).map((p) => `${p.type}:${p.name}`).join(', ')})` : ''}`)
    for (const problem of problems) console.log(`  problem: ${problem}`)
    if (!problems.length) console.log('  configured: required reviewer and main-branch-only deployments')
    process.exitCode = report || !problems.length ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = report ? 0 : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
