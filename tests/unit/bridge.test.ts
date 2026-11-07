/**
 * The bridge for older apps (beta-server/src/bridge.ts): which backend answers, and with which
 * routing. Older apps (no data-notice 4 header, as every published version) stay exactly as
 * production serves them today on Workers AI: practice sets on Gemma 4 26B, everything else on
 * Qwen 3.8 27B. Apps on notice 4 go to DeepInfra: Qwen 3.8 27B for everything, no routing.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isLegacyApp, serverConfig } from '../../beta-server/src/bridge'
import { inference, type Env } from '../../beta-server/src/config'
import { chooseModel } from '../../beta-server/src/route'

/** The vars of wrangler.deepinfra.jsonc, the file production would run. */
function productionVars(): Env {
  const text = readFileSync(new URL('../../beta-server/wrangler.deepinfra.jsonc', import.meta.url), 'utf8')
  const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
  return { ...json.vars, INFERENCE_API_KEY: 'test-key', AI: {} } as Env
}
const req = (notice?: string): Request => new Request('https://x/v1/tutor', { headers: notice ? { 'x-inkling-notice': notice } : {} })
const practice = [{ role: 'user' as const, parts: [{ text: 'Create 3 practice problems on fractions.' }] }]

describe('the bridge for older apps', () => {
  const env = productionVars()

  it('published apps (no notice header, or notice 3) are older apps; notice 4 and later are not', () => {
    expect(isLegacyApp(req(), 4)).toBe(true)
    expect(isLegacyApp(req('3'), 4)).toBe(true)
    expect(isLegacyApp(req('4'), 4)).toBe(false)
    expect(isLegacyApp(req('5'), 4)).toBe(false)
    expect(isLegacyApp(req('junk'), 4)).toBe(true)
  })

  it('production config: DeepInfra with the bridge on', () => {
    expect(env.INFERENCE_PROVIDER).toBe('deepinfra')
    expect(env.LEGACY_WORKERS_AI).toBe('true')
    expect(env.MODEL_TEXT).toBe('@cf/google/gemma-4-26b-a4b-it')
  })

  it('older apps keep today’s routing: practice on Gemma, chat on Qwen, no notice gate', async () => {
    const winf = inference({ ...env, INFERENCE_PROVIDER: 'workers-ai' } as Env)
    if (typeof winf === 'string') throw new Error(winf)
    const cfg = await serverConfig({ ...env, INFERENCE_PROVIDER: 'workers-ai' } as Env, winf, true)
    expect(cfg.provider).toBe('workers-ai')
    expect(cfg.minNoticeVersion).toBe(0)
    expect(cfg.textModel?.model).toBe('@cf/google/gemma-4-26b-a4b-it')
    const main = { model: cfg.model, rates: cfg.rates, reasoningEffort: cfg.reasoningEffort, disableThinking: cfg.disableThinking }
    expect(chooseModel('practice', practice, main, cfg.textModel).model).toBe('@cf/google/gemma-4-26b-a4b-it')
    expect(chooseModel('chat', practice, main, cfg.textModel).model).toBe('@cf/qwen/qwen3.8-27b')
  })

  it('apps on notice 4 get DeepInfra, Qwen for everything, no routing, the notice gate on', async () => {
    const inf = inference(env)
    if (typeof inf === 'string') throw new Error(inf)
    const cfg = await serverConfig(env, inf, false)
    expect(cfg.provider).toBe('deepinfra')
    expect(cfg.model).toBe('Qwen/Qwen3.8-27B')
    expect(cfg.textModel).toBeNull()
    expect(cfg.minNoticeVersion).toBe(4)
    expect(cfg.upstreamAttempts).toBe(3)
  })

  it('the rollback (wrangler.jsonc) keeps today’s routing for everyone', async () => {
    const text = readFileSync(new URL('../../beta-server/wrangler.jsonc', import.meta.url), 'utf8')
    const vars = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).vars
    const renv = { ...vars, AI: {} } as Env
    const inf = inference(renv)
    if (typeof inf === 'string') throw new Error(inf)
    const cfg = await serverConfig(renv, inf, false)
    expect(cfg.provider).toBe('workers-ai')
    expect(cfg.textModel?.model).toBe('@cf/google/gemma-4-26b-a4b-it')
  })
})
