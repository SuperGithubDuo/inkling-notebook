import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../beta-server/scripts/usage-summary.mjs', import.meta.url))
const summary = {
  day: '2026-11-07', unit: 'usd', globalUsed: 150_000, globalLimit: 250_000,
  todayUsed: 100_000, answers: 12, month: '2026-11', monthUsed: 1_500_000,
  monthLimit: 5_000_000, monthAnswers: 120, installations: 3, networks: 2,
  answering: 1, paused: false, upstreamExhausted: false
}
function report(overrides: Record<string, unknown> = {}): string {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ ...summary, ...overrides }), encoding: 'utf8'
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe('emergency usage summary formatter (real CLI)', () => {
  it('converts ledger USD microdollars into dollars for rolling and daily use', () => {
    const text = report()
    expect(text).toContain('2026-11-07 UTC')
    expect(text).toContain('$0.15 of $0.25 used in the last 24 h (60%)')
    expect(text).toContain('$0.10 today')
    expect(text).toContain('12 answers today, 3 installations, 2 networks, 1 answering now, paused=false')
    expect(text).not.toMatch(/Neurons|Cloudflare/)
  })

  it('keeps legacy Neurons values without dollar conversion', () => {
    const text = report({ unit: 'neurons', globalUsed: 150, globalLimit: 250, todayUsed: 100, monthUsed: 1500, monthLimit: 5000 })
    expect(text).toContain('150 Neurons of 250 Neurons used in the last 24 h (60%)')
    expect(text).toContain('1500 Neurons used, 5000 Neurons budget, 3500 Neurons remaining (30%)')
    expect(text).not.toContain('$')
  })

  it.each([0, null, undefined])('handles zero or absent limits (%s) without inventing percentages or remaining', (limit) => {
    const text = report({ globalLimit: limit, monthLimit: limit })
    expect(text).not.toMatch(/NaN|Infinity|%/)
    if (limit === 0) {
      expect(text).toContain('$0.00 budget')
      expect(text).toContain('$0.00 remaining')
    } else {
      expect(text).toContain('budget unavailable')
      expect(text).toContain('remaining unavailable')
      expect(text).not.toContain('$0.00 budget')
    }
  })

  it.each(['credits', undefined, null])('never silently labels an unknown or missing unit (%s) as dollars or Neurons', (unit) => {
    const text = report({ unit })
    expect(text).toContain('usage unit unavailable')
    expect(text).not.toMatch(/\$|Neurons|%/)
    expect(text).toContain('12 answers today')
  })

  it('reports zero use accurately and clamps over-budget remaining without hiding overspend', () => {
    const zero = report({ globalUsed: 0, todayUsed: 0, monthUsed: 0 })
    expect(zero).toContain('$0.00 of $0.25 used in the last 24 h (0%)')
    expect(zero).toContain('$0.00 used, $5.00 budget, $5.00 remaining (0%)')
    expect(report({ monthUsed: 6_000_000 })).toContain('$6.00 used, $5.00 budget, $0.00 remaining (120%)')
  })

  it.each([null, undefined, -1, '150000'])('does not invent missing or invalid usage (%s)', (used) => {
    const text = report({ globalUsed: used, todayUsed: used, monthUsed: used })
    expect(text).toContain('unavailable today')
    expect(text).toContain('remaining unavailable')
    expect(text).not.toMatch(/NaN|Infinity|%/)
  })

  it('reports monthly usage, budget and remaining in the ledger unit', () => {
    expect(report()).toContain('2026-11: $1.50 used, $5.00 budget, $3.50 remaining (30%), 120 answers this month')
  })
})

describe('emergency workflow integration', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/beta-server-ops.yml', import.meta.url), 'utf8')

  function runSwitch(action: string, mismatch = '', httpError = '') {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), 'usage-workflow-'))
    try {
      const body = workflow.replace(/\r/g, '').split('        run: |\n')[1]!
        .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n')
        .replaceAll('/tmp/', `${dir.replaceAll('\\', '/')}/`)
      const mock = `
        curl() {
          local out='' url='' notice=legacy data='' arg
          while [ "$#" -gt 0 ]; do
            arg=$1; shift
            case "$arg" in
              -o) out=$1; shift ;;
              -d) data=$1; shift ;;
              -H) case "$1" in 'x-inkling-notice: 4') notice=4 ;; esac; shift ;;
              https://*) url=$arg ;;
            esac
          done
          echo "$url notice=$notice data=$data" >> "$MOCK_CALLS"
          case "$url" in
            */admin/pause) printf '{}' > "$out"; printf 200 ;;
            */v1/status)
              local state=$EXPECTED code=200
              [ "$notice" != "$MISMATCH" ] || { [ "$state" = true ] && state=false || state=true; }
              [ "$notice" != "$HTTP_ERROR" ] || code=503
              if [ -n "$out" ]; then printf '{"paused":%s}' "$state" > "$out"; printf '%s' "$code"
              else printf '{"paused":%s}' "$state"; fi ;;
            */admin/summary) printf '%s' "$MOCK_SUMMARY" > "$out"; printf 200 ;;
            *) return 97 ;;
          esac
        }
        jq() {
          if [ "$1" = -r ]; then
            if [ "$#" -ge 3 ]; then node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).paused)' "$3"
            else node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).paused)'; fi
          else node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))))' "$2"; fi
        }
      `
      const output = spawnSync('bash', ['-e', '-o', 'pipefail'], {
        input: `${mock}\n${body}`, encoding: 'utf8',
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, ACTION: action, URL: 'https://mock.invalid',
          INKLING_ADMIN_TOKEN: 'test-only-not-a-credential'.repeat(2),
          EXPECTED: action.endsWith('pause') ? 'true' : 'false',
          MISMATCH: mismatch, HTTP_ERROR: httpError, MOCK_SUMMARY: JSON.stringify(summary),
          MOCK_CALLS: join(dir, 'calls').replaceAll('\\', '/'),
          GITHUB_STEP_SUMMARY: join(dir, 'report.md').replaceAll('\\', '/') }
      })
      return { ...output, calls: readFileSync(join(dir, 'calls'), 'utf8'),
        report: output.status === 0 ? readFileSync(join(dir, 'report.md'), 'utf8') : '' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.each(['pause', 'ops/resume'])('executes %s with both status checks and no inference (mocked curl)', (action) => {
    const result = runSwitch(action)
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.calls).toContain('/v1/status notice=4')
    expect(result.calls).toContain('/v1/status notice=legacy')
    expect(result.calls).toContain(`data={"paused":${action === 'pause'}}`)
    expect(result.calls).not.toMatch(/tutor|chat\/completions/)
    expect(result.stdout).toContain('$0.15 of $0.25')
    expect(result.report).toContain('$1.50 used, $5.00 budget, $3.50 remaining')
  })

  it('summary is read-only (mocked curl)', () => {
    const result = runSwitch('summary')
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls.trim().split('\n')).toHaveLength(1)
    expect(result.calls).toContain('/admin/summary')
    expect(result.calls).not.toContain('/admin/pause')
  })

  it.each(['4', 'legacy'])('rejects a pause mismatch from notice %s (mocked curl)', (notice) => {
    const result = runSwitch('pause', notice)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Asked for paused=true')
    expect(result.calls).not.toContain('/admin/summary')
  })

  it.each(['4', 'legacy'])('rejects non-200 status from notice %s (mocked curl)', (notice) => {
    const result = runSwitch('resume', '', notice)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('503')
    expect(result.calls).not.toContain('/admin/summary')
  })

  it('checks out the formatter and uses it for the operator report instead of dividing with jq', () => {
    expect(workflow).toMatch(/uses: actions\/checkout@v4/)
    expect(workflow).toMatch(/line=\$\(node beta-server\/scripts\/usage-summary\.mjs < \/tmp\/sum\.json\)/)
    expect(workflow).not.toMatch(/100\*\.globalUsed\/\.globalLimit/)
    expect(workflow).toContain('echo "$line"')
  })

  it('verifies both notice-4 primary and legacy status after pause or resume', () => {
    expect(workflow).toMatch(/for notice in 4 legacy; do/)
    expect(workflow).toMatch(/x-inkling-notice: \$notice/)
    expect(workflow).toMatch(/\[ "\$notice" = legacy \]/)
    expect(workflow).toMatch(/\[ "\$now" = "\$paused" \]/)
    expect(workflow).toMatch(/\[ "\$code" = 200 \]/)
    expect(workflow).toContain('"$URL/admin/pause"')
    expect(workflow).toContain('"$URL/v1/status"')
  })
})
