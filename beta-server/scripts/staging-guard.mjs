#!/usr/bin/env node
/**
 * Refuses to let the account-verification staging workflow touch anything but the temporary
 * Worker. Checks beta-server/wrangler.accounts-staging.jsonc against production's configs and
 * prints the staging Worker's name (the only name the workflow may deploy or delete).
 *
 *   node beta-server/scripts/staging-guard.mjs     # prints the name, or exits 1 with each problem
 *
 * Pure checks are exported for tests/unit/stagingWorkflow.test.ts. Reads files only.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const STAGING_NAME = 'inkling-ai-accounts-test'
export const STAGING_CONFIG = 'wrangler.accounts-staging.jsonc'
/** The most staging may spend a day, in Neurons (4% of the account's shared free 10,000). */
export const MAX_STAGING_NEURONS = 400

export const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))

/** Every reason `staging` is unsafe next to the production configs; empty when it is safe. */
export function stagingProblems(staging, productionConfigs) {
  const p = []
  const vars = staging?.vars ?? {}
  const prodNames = new Set(productionConfigs.map((c) => c?.name).filter(Boolean))
  if (staging?.name !== STAGING_NAME) p.push(`name must be ${STAGING_NAME} (is ${staging?.name})`)
  if (prodNames.has(staging?.name)) p.push(`name ${staging?.name} is a production Worker`)
  for (const k of ['routes', 'route', 'services', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'queues', 'tail_consumers']) if (staging?.[k] !== undefined) p.push(`no ${k} allowed`)
  for (const b of staging?.durable_objects?.bindings ?? []) if (b.script_name) p.push(`Durable Object ${b.name} binds another Worker (${b.script_name})`)
  if (vars.INFERENCE_PROVIDER !== undefined && vars.INFERENCE_PROVIDER !== 'workers-ai') p.push('must answer with Workers AI only (no INFERENCE_PROVIDER)')
  if (vars.ACCOUNT_PLAN !== 'free') p.push('ACCOUNT_PLAN must be "free"')
  const cap = Number(vars.GLOBAL_DAILY_NEURONS)
  if (!(cap > 0 && cap <= MAX_STAGING_NEURONS)) p.push(`GLOBAL_DAILY_NEURONS must be 1–${MAX_STAGING_NEURONS} (is ${vars.GLOBAL_DAILY_NEURONS})`)
  if ((vars.WEB_ORIGINS ?? '') !== '') p.push('WEB_ORIGINS must be empty (no browser access)')
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(vars.SUPABASE_URL ?? '')) p.push('SUPABASE_URL must be the project https URL')
  if (!/^sb_publishable_/.test(vars.SUPABASE_ANON_KEY ?? '')) p.push('SUPABASE_ANON_KEY must be a publishable key')
  if (/service_role|sb_secret_|INFERENCE_API_KEY|ADMIN_TOKEN|DEEPINFRA|UPSTREAM_/i.test(JSON.stringify(vars))) p.push('no keys, admin tokens or provider settings in vars')
  return p
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = new URL('../', import.meta.url)
  const read = (f) => parseJsonc(readFileSync(new URL(f, dir), 'utf8'))
  const problems = stagingProblems(read(STAGING_CONFIG), [read('wrangler.jsonc'), read('wrangler.deepinfra.jsonc')])
  if (problems.length) {
    for (const x of problems) console.error(`::error title=Staging config::${x}`)
    process.exit(1)
  }
  console.log(STAGING_NAME)
}
