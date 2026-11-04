/**
 * Practice-generation evaluations: what text-only routing sends to the text
 * model first (TEXT_MODEL_TASKS=practice). Four subjects, an easy and a hard
 * set each, through the app's own request format (src/renderer/src/ai/practiceStore.ts):
 *
 *   PA  algebra: linear equations        PG  geometry: area of triangles and circles
 *   PC  calculus: derivatives of polynomials  PK  physics: constant-acceleration kinematics
 *
 * Every set must validate, have the number of problems asked for, the requested
 * difficulty, at least one hint that doesn't give the answer away, and a worked
 * solution that ends at the stated answer. Where the maths can be checked
 * mechanically, it is: a linear equation's answer is substituted back, a
 * polynomial's derivative is recomputed, and v = u + at is recomputed. A
 * problem whose form the checker doesn't recognise is counted as "not checked
 * automatically" (it is read by hand in the report), never as a pass.
 */
import { it } from 'vitest'
import type { AiRequest } from '../../src/shared/ai'
import { parseTaskResult, type PracticeSet } from '../../src/shared/tutor'
import type { Run, ScenarioContext } from './scenarios'

type Problem = PracticeSet['problems'][number]

/** Plain text of a maths string: no $, \, braces; unicode minus and × normalised. */
const plain = (s: string): string =>
  s
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\(cdot|times)/g, '*')
    .replace(/\\(left|right)/g, '')
    .replace(/[$\\{}]/g, '')
    .replace(/[−–]/g, '-')
    .replace(/×/g, '*')
    .replace(/\s+/g, ' ')
    .replace(/\((-?[\d.]+)\)\/\((-?[\d.]+)\)/g, '$1/$2')
    .trim()

const num = (s: string): number => {
  const t = s.replace(/\s/g, '')
  const frac = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(t)
  if (frac) return Number(frac[1]) / Number(frac[2])
  return Number(t)
}

/** The number in an answer like "x = 4", "$t = -3/2$", "20 m/s". NaN if there isn't exactly one. */
export function answerNumber(answer: string): number {
  const nums = plain(answer).replace(/^[a-z]\s*=\s*/i, '').match(/-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/g)
  return nums && nums.length === 1 ? num(nums[0]!) : NaN
}

/** Linear equation in one variable, e.g. "Solve for x: 3(x - 2) + 4 = 19" → substitute and compare. */
export function checkLinear(p: Problem): boolean | null {
  // Words (two letters or more) separate the equation from the instructions around it.
  const q = plain(p.question).replace(/[.?]\s*$/, '').replace(/[a-z]{2,}/gi, '|').replace(/:/g, '|')
  const eq = q.split('|').find((seg) => (seg.match(/=/g) ?? []).length === 1 && /[a-z]/i.test(seg))?.trim()
  if (!eq) return null
  const vars = [...new Set(eq.match(/[a-z]/gi) ?? [])]
  if (vars.length !== 1) return null
  const v = vars[0]!
  const x = answerNumber(p.answer)
  if (!Number.isFinite(x)) return null
  const expr = (side: string): number | null => {
    // Implicit multiplication: 3x, 3(x, )(, )x → explicit, then evaluate with only digits and operators left.
    const js = side
      .replace(new RegExp(`(\\d)\\s*${v}`, 'g'), `$1*${v}`)
      .replace(/(\d|\))\s*\(/g, '$1*(')
      .replace(new RegExp(`\\)\\s*${v}`, 'g'), `)*${v}`)
      .replace(new RegExp(v, 'g'), `(${x})`)
    if (!/^[-+*/().\d\s]+$/.test(js)) return null
    try {
      // eslint-disable-next-line no-new-func -- only digits, operators and parentheses reach here
      return Function(`"use strict"; return (${js})`)() as number
    } catch {
      return null
    }
  }
  const [l, r] = eq.split('=')
  const a = expr(l!)
  const b = expr(r!)
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.abs(a - b) < 1e-6
}

/** "Find the derivative of f(x) = 3x^3 - 2x + 5" (polynomial only) → recompute and compare at a few points. */
export function checkPolynomialDerivative(p: Problem): boolean | null {
  const q = plain(p.question).replace(/²/g, '^2').replace(/³/g, '^3')
  const m = /=\s*([-+\dx^.\s*]+?)\s*(?:[.?,]|$|\bat\b|\busing\b)/i.exec(q)
  if (!m) return null
  const terms = m[1]!.replace(/\s|\*/g, '').replace(/-/g, '+-').split('+').filter(Boolean)
  const poly: Array<[number, number]> = []
  for (const t of terms) {
    const tm = /^(-?\d*(?:\.\d+)?)(x(?:\^(\d+))?)?$/.exec(t)
    if (!tm) return null
    const c = tm[1] === '' || tm[1] === undefined ? 1 : tm[1] === '-' ? -1 : Number(tm[1])
    const e = tm[2] ? (tm[3] ? Number(tm[3]) : 1) : 0
    poly.push([c, e])
  }
  if (!poly.some(([, e]) => e > 0)) return null
  const d = (x: number): number => poly.reduce((s, [c, e]) => s + (e > 0 ? c * e * x ** (e - 1) : 0), 0)
  const ans = plain(p.answer).replace(/²/g, '^2').replace(/³/g, '^3').replace(/^.*?=\s*/, '').replace(/\s|\*/g, '')
  const at = (x: number): number | null => {
    const js = ans.replace(/(\d)x/g, '$1*x').replace(/\^/g, '**').replace(/x/g, `(${x})`)
    if (!/^[-+*/().\d]+$/.test(js)) return null
    try {
      // eslint-disable-next-line no-new-func -- only digits and operators reach here
      return Function(`"use strict"; return (${js})`)() as number
    } catch {
      return null
    }
  }
  for (const x of [-2, 0.5, 3]) {
    const got = at(x)
    if (got === null) return null
    if (Math.abs(got - d(x)) > 1e-6) return false
  }
  return true
}

/** "starts at 4 m/s … accelerates at 2 m/s² for 5 s … final speed?" → v = u + at. */
export function checkFinalSpeed(p: Problem): boolean | null {
  const q = plain(p.question)
  if (!/(final (speed|velocity)|how fast|velocity after|speed after)/i.test(q) || /(distance|displacement|how far)/i.test(q)) return null
  const u = /from rest|at rest/i.test(q) ? 0 : Number(/(?:initial (?:speed|velocity) of|at|starts? (?:moving )?at|travell?ing at|moving at)\s*(-?\d+(?:\.\d+)?)\s*m\s*\/\s*s(?!\^|²)/i.exec(q)?.[1])
  const a = Number(/(-?\d+(?:\.\d+)?)\s*m\s*\/\s*s(?:\^2|²|\s*\^\s*2)/i.exec(q)?.[1])
  const t = Number(/(?:for|after)\s*(\d+(?:\.\d+)?)\s*(?:s\b|seconds)/i.exec(q)?.[1])
  if (![u, a, t].every(Number.isFinite)) return null
  const v = answerNumber(p.answer)
  if (!Number.isFinite(v)) return null
  const decel = /(decelerat|slows|brak)/i.test(q) && a > 0
  return Math.abs(v - (u + (decel ? -a : a) * t)) < 0.05
}

/** The hints must not just state the final answer. */
const hintGivesAway = (p: Problem): boolean => {
  const n = answerNumber(p.answer)
  const a = plain(p.answer).replace(/\s/g, '').toLowerCase()
  return p.hints.some((h) => {
    const t = plain(h).replace(/\s/g, '').toLowerCase()
    return (a.length > 2 && t.includes(a)) || (Number.isFinite(n) && Math.abs(n) > 1 && new RegExp(`(^|[^\\d.])=${String(n).replace('.', '\\.')}(?![\\d.])`).test(t))
  })
}

/** The worked solution reaches the stated answer (its number, or its text). */
const solutionReachesAnswer = (p: Problem): boolean => {
  const n = answerNumber(p.answer)
  const sol = plain(p.solution).replace(/\s/g, '').toLowerCase()
  if (Number.isFinite(n)) return [String(n), String(Math.round(n * 100) / 100)].some((s) => sol.includes(s)) || sol.includes(plain(p.answer).replace(/\s/g, '').toLowerCase())
  return sol.includes(plain(p.answer).replace(/\s/g, '').toLowerCase().replace(/^[a-z]=/, ''))
}

const SUBJECTS = [
  { id: 'PA', topic: 'solving linear equations in one variable', verify: checkLinear },
  { id: 'PG', topic: 'area of triangles and circles', verify: null },
  { id: 'PC', topic: 'derivatives of polynomials', verify: checkPolynomialDerivative },
  { id: 'PK', topic: 'constant-acceleration kinematics: final speed from initial speed, acceleration and time', verify: checkFinalSpeed }
] as const

/** Counts every mechanically checked problem across the run, for the report. */
export const practiceTally = { checked: 0, correct: 0, unchecked: 0 }

export function registerPracticeScenarios({ run, check, timeout = 900_000 }: ScenarioContext): void {
  const ask = (difficulty: string, topic: string, count: number): AiRequest => ({ task: 'practice', turns: [{ role: 'user', parts: [{ text: `Create ${count} practice problems at ${difficulty} difficulty on: ${topic}.` }] }] })

  for (const s of SUBJECTS) {
    it(`${s.id}: practice sets on ${s.topic}`, { timeout }, async () => {
      for (const difficulty of ['easy', 'hard'] as const) {
        const r: Run = await run(s.id, ask(difficulty, s.topic, 2))
        check(r, `${difficulty}: structured output validates`, !!r.validated, r.error ?? r.text.slice(0, 200))
        const set = parseTaskResult('practice', r.text)
        if (!set) continue
        check(r, `${difficulty}: two problems`, set.problems.length === 2, String(set.problems.length))
        check(r, `${difficulty}: labelled ${difficulty}`, set.problems.every((p) => p.difficulty === difficulty), set.problems.map((p) => p.difficulty).join(','))
        check(r, `${difficulty}: every problem has a hint`, set.problems.every((p) => p.hints.length >= 1))
        check(r, `${difficulty}: hints don't give the answer away`, !set.problems.some(hintGivesAway), set.problems.map((p) => `${p.answer} | ${p.hints.join(' / ')}`).join(' ;; ').slice(0, 300))
        check(r, `${difficulty}: solutions reach the stated answer`, set.problems.every(solutionReachesAnswer), set.problems.map((p) => `${p.answer} ⇐ …${p.solution.slice(-80)}`).join(' ;; ').slice(0, 300))
        if (s.verify) {
          for (const [i, p] of set.problems.entries()) {
            const ok = s.verify(p)
            if (ok === null) {
              practiceTally.unchecked++
              continue
            }
            practiceTally.checked++
            if (ok) practiceTally.correct++
            check(r, `${difficulty}: problem ${i + 1} answer is mathematically correct`, ok, `${p.question} → ${p.answer}`.slice(0, 300))
          }
        }
      }
    })
  }
}
