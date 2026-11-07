import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const yaml = createRequire(import.meta.url)('js-yaml')

const workflow = yaml.load(readFileSync(new URL('../../.github/workflows/ai-provider-switch.yml', import.meta.url), 'utf8')) as any
const steps = workflow.jobs.switch.steps as any[]
const recover = steps.find((s) => s.id === 'recover')

describe('production recovery conditions and execution', () => {
  it.each([
    [true, false, 'failure', 'skipped', true],
    [false, true, 'cancelled', 'skipped', true],
    [true, false, 'skipped', 'failure', true],
    [false, true, 'skipped', 'cancelled', true],
    [true, false, 'success', 'success', true],
    [true, false, 'skipped', 'skipped', false],
    [false, false, 'success', 'success', false]
  ])('failure=%s cancellation=%s key=%s deploy=%s recovers=%s', (failed, cancelled, key, deploy, expected) => {
    // Evaluate the workflow's real expression with the Actions functions/outcomes supplied offline.
    const expression = recover.if.replace(/failure\(\)/g, String(failed)).replace(/cancelled\(\)/g, String(cancelled))
      .replace(/steps.key.outcome/g, JSON.stringify(key)).replace(/steps.deploy.outcome/g, JSON.stringify(deploy))
    const result = new Function('contains', 'fromJSON', `return (${expression})`)((a: string[], b: string) => a.includes(b), JSON.parse)
    expect(result).toBe(expected)
  })
  it.each([false, true])('real recovery shell fails closed when all deploy attempts fail=%s', (allFail) => {
    const stub = `npx() { ${allFail ? 'return 1' : 'return 0'}; }; sleep() { :; }; export -f npx sleep;\n`
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stub + recover.run], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(allFail ? 1 : 0)
    expect(result.stdout).toContain(allFail ? 'Recovery failed' : 'wrangler.jsonc deployed')
  })
  it('always independently verifies a successful recovery against Cloudflare and both app notices', () => {
    const verify = steps.find((s) => s.name === 'Verify the recovery')
    expect(verify.if).toBe("always() && steps.recover.outcome == 'success'")
    expect(verify.run).toContain('production-provider.mjs --expect workers-ai')
    expect(verify.run).toContain('for notice in "" 4; do')
    expect(verify.run).toContain('fail "the live server does not count in Neurons"')
    expect(steps.find((s) => s.id === 'verify')['continue-on-error']).not.toBe(true)
    expect(workflow.jobs.switch['continue-on-error']).not.toBe(true)
  })
})
