#!/usr/bin/env node
/**
 * The Workers AI model catalog as this account sees it today (Cloudflare's
 * models search API), narrowed to text-generation models: name, whether it
 * reads images, context window, the published price (when the catalog
 * carries it), and beta/deprecation flags. Costs no Neurons.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/cf-models.mjs [out.md]
 *
 * Writes Markdown to the given file (and JSON next to it), or prints JSON.
 * Never throws: an error is reported in the output.
 */
import { writeFile } from 'node:fs/promises'

const out = process.argv[2]
const acct = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN

async function page(n) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?per_page=100&page=${n}`, { headers: { authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) throw new Error(`models search: HTTP ${res.status} ${(body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`)
  return body
}

const prop = (m, id) => m.properties?.find((p) => p.property_id === id)?.value

try {
  const all = []
  for (let n = 1; n <= 10; n++) {
    const b = await page(n)
    all.push(...(b.result ?? []))
    const info = b.result_info ?? {}
    if (!b.result?.length || (info.total_count && all.length >= info.total_count)) break
  }
  const text = all.filter((m) => /text generation/i.test(m.task?.name ?? ''))
  const rows = text
    .map((m) => {
      const price = prop(m, 'price')
      const blob = JSON.stringify(m.properties ?? []) + ' ' + (m.description ?? '')
      return {
        name: m.name,
        vision: /vision|image|multimodal|multi-modal/i.test(blob),
        context: prop(m, 'context_window') ?? prop(m, 'max_input_tokens') ?? null,
        price: Array.isArray(price) ? price.map((p) => `${p.unit}: ${p.price} ${p.currency ?? ''}`.trim()).join('; ') : (price ?? null),
        beta: prop(m, 'beta') === 'true' || prop(m, 'beta') === true,
        deprecated: prop(m, 'planned_deprecation_date') ?? null,
        terms: prop(m, 'terms') ?? prop(m, 'info') ?? null,
        properties: (m.properties ?? []).map((p) => p.property_id)
      }
    })
    .sort((a, b) => Number(b.vision) - Number(a.vision) || a.name.localeCompare(b.name))
  const result = { ok: true, at: new Date().toISOString(), models: all.length, textGeneration: rows.length, rows }
  if (out) {
    await writeFile(out.replace(/\.md$/, '.json'), JSON.stringify(result, null, 2))
    const md = [
      `# Workers AI catalog (${result.at})`,
      '',
      `${all.length} models in the catalog, ${rows.length} for text generation. "Reads images" is inferred from the catalog's properties and description.`,
      '',
      '| Model | Reads images | Context | Published price | Beta | Planned deprecation | Terms |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.name} | ${r.vision ? 'yes' : ''} | ${r.context ?? ''} | ${r.price ?? ''} | ${r.beta ? 'beta' : ''} | ${r.deprecated ?? ''} | ${r.terms ?? ''} |`)
    ].join('\n')
    await writeFile(out, md + '\n')
  } else console.log(JSON.stringify(result, null, 2))
} catch (err) {
  const result = { ok: false, error: String(err?.message ?? err) }
  if (out) await writeFile(out, `# Workers AI catalog\n\nCould not read the catalog: ${result.error}\n`)
  console.log(JSON.stringify(result))
}
