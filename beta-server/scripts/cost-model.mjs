#!/usr/bin/env node
/**
 * Inkling AI cost model: what 1k / 10k / 100k / 1M answers cost on each
 * provider, from token counts MEASURED with the real model and the providers'
 * published prices (checked 3 Nov 2026; see docs/AI-PROVIDERS.md).
 *
 *   node beta-server/scripts/cost-model.mjs            # Markdown tables
 *   node beta-server/scripts/cost-model.mjs --json
 *
 * Token profiles (docs/archive/live-results/cloud-qwen3.8-27b.md, 13 real answers):
 *   chat 640→150, markup 1,030→278, check 370→58, practice 365→322
 *   blended 60/25/10/5 = 697 in → 181 out ("measured")
 * "app-size" adds full-size (1024 px) images and longer histories, as the
 * monetization audit estimated: 1,100 in → 225 out.
 */
const PROFILES = {
  measured: { input: 697, output: 181 },
  'app-size': { input: 1100, output: 225 }
}

// USD per million tokens. fee: multiplier for platform fees not in the token price.
const PROVIDERS = [
  { id: 'workers-ai', label: 'Cloudflare Workers AI (@cf/qwen/qwen3.8-27b)', input: 0.45, output: 3.2 },
  { id: 'deepinfra-list', label: 'DeepInfra direct, list price', input: 0.2, output: 2.5 },
  { id: 'deepinfra-promo', label: 'DeepInfra direct, current 25% promotion', input: 0.15, output: 1.875 },
  { id: 'openrouter-deepinfra', label: 'OpenRouter → DeepInfra (list + 5.5% fee)', input: 0.2, output: 2.5, fee: 1.055 },
  { id: 'openrouter-deepinfra-promo', label: 'OpenRouter → DeepInfra (promo + 5.5% fee)', input: 0.15, output: 1.875, fee: 1.055 },
  { id: 'cerebras', label: 'Cerebras (qwen-3.8-27b)', input: 0.99, output: 1.49 },
  { id: 'groq', label: 'Groq (qwen/qwen3.8-27b, preview)', input: 0.8, output: 4.0 },
  // Groq counts every image as 2,048 input tokens; Qwen's own patching gives ~340–1,370.
  { id: 'groq-images', label: 'Groq, with its 2,048-token images (≈ +800 tokens/answer)', input: 0.8, output: 4.0, extraInput: 800 }
]

const VOLUMES = [1_000, 10_000, 100_000, 1_000_000]

export function perAnswer(p, profile) {
  const input = profile.input + (p.extraInput ?? 0)
  return ((input * p.input + profile.output * p.output) / 1e6) * (p.fee ?? 1)
}

const rows = []
for (const [name, profile] of Object.entries(PROFILES)) {
  for (const p of PROVIDERS) {
    const one = perAnswer(p, profile)
    rows.push({ profile: name, provider: p.id, label: p.label, perAnswer: one, volumes: Object.fromEntries(VOLUMES.map((v) => [v, one * v])), outputShare: (profile.output * p.output) / (profile.input * p.input + profile.output * p.output) })
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const usd = (n) => (n < 1 ? `$${n.toFixed(n < 0.01 ? 5 : 2)}` : `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 ? 2 : 0 })}`)
  for (const name of Object.keys(PROFILES)) {
    const pr = PROFILES[name]
    console.log(`\n### ${name} profile (${pr.input} input → ${pr.output} output tokens per answer)\n`)
    console.log(`| Provider | Per answer | 1,000 | 10,000 | 100,000 | 1,000,000 | Output share |`)
    console.log(`|---|---|---|---|---|---|---|`)
    for (const r of rows.filter((x) => x.profile === name)) console.log(`| ${r.label} | ${usd(r.perAnswer)} | ${VOLUMES.map((v) => usd(r.volumes[v])).join(' | ')} | ${Math.round(r.outputShare * 100)}% |`)
  }
  const wai = perAnswer(PROVIDERS[0], PROFILES.measured)
  console.log(`\nWorkers AI free allocation: 10,000 Neurons/day = $0.11/day ≈ ${Math.floor(0.11 / wai)} measured answers/day.`)
}
