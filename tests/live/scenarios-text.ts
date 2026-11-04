/**
 * More live tutor scenarios, mostly WITHOUT handwriting images: the requests
 * text-only routing (beta-server/src/route.ts) may send to the text model, so
 * they are the ones that must keep their quality. Plus one multi-turn
 * handwriting conversation whose typed follow-ups must stay on the main model.
 *
 *   G  typed homework with a distribution mistake: 3(x − 2) = 12
 *   H  maths explanation: differentiate x² sin x (product rule)
 *   I  multi-turn typed tutoring on fractions: explain, hint without the answer, check
 *   J  PDF text with a wrong worked example (circle area), then an exercise
 *   K  typed answer checks: an equivalent form is right, a wrong value is not
 *   L  handwriting, then three typed follow-ups (the app's own buildTurns)
 */
import { it } from 'vitest'
import type { AiPart, AiRequest } from '../../src/shared/ai'
import { CLOUD_MODEL } from '../../src/shared/ai'
import { parseTaskResult } from '../../src/shared/tutor'
import { buildTurns, type ThreadEntry } from '../../src/renderer/src/ai/turns'
import { img, selection, type ScenarioContext } from './scenarios'

/** Answer text as plain maths: no $, backslashes, braces or spaces; \frac{a}{b} → a/b; − → -. */
export const flatMath = (s: string): string =>
  s
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\(cdot|times)/g, '*')
    .replace(/\\(sin|cos|pi)/g, '$1')
    .replace(/π/g, 'pi')
    .replace(/[\s$\\{}]/g, '')
    .replace(/−/g, '-')
    .replace(/\^2|²/g, '²')
    .replace(/\((\d+)\)\/\((\d+)\)/g, '$1/$2')
    .toLowerCase()

const claimsMistake = (s: string): boolean => /(incorrect|mistake|error|wrong|not correct|should be|instead of|isn't right|is not right)/i.test(s) && !/(no (mistakes?|errors?)|not wrong|isn't wrong)/i.test(s)

export function registerTextScenarios({ run, check, timeout = 900_000 }: ScenarioContext): void {
  const chatWith = (parts: AiPart[]): AiRequest => ({ task: 'chat', turns: [{ role: 'user', parts }] })
  /** When the harness knows which model answered (direct mode), image conversations must use the main model. */
  const onMain = (r: { model?: string }): boolean => r.model === undefined || r.model === CLOUD_MODEL

  it('G: finds the mistake in typed homework', { timeout }, async () => {
    const note = `<notes title="Homework 4">\nSolve 3(x − 2) = 12.\n\n3x − 2 = 12\n3x = 14\nx = 14/3\n</notes>`
    const r = await run('G', chatWith([{ text: note }, { text: 'Check my homework. Find the first mistake, explain why it is wrong and how to fix it.' }]))
    check(r, 'answered', r.ok, r.error)
    const t = flatMath(r.text)
    check(r, 'says there is a mistake', claimsMistake(r.text), r.text.slice(0, 200))
    check(r, 'points at the distribution step (3 × 2 = 6)', /distribut|3x-6|3·2|3\*2|3×2|-6/.test(t) || /distribut/i.test(r.text), r.text.slice(0, 300))
    // The tutor may stop at the corrected step and let the student finish (its instructions favour guidance).
    check(r, 'gives the fix: 3x − 6 = 12 (or x = 6)', /3x-6=12|x=6(?!\d|\/|\.\d)/.test(t), r.text.slice(0, 300))
  })

  it('H: explains a derivative step by step', { timeout }, async () => {
    const r = await run('H', chatWith([{ text: 'Explain how to differentiate f(x) = x² sin x, step by step, and give f′(x).' }]))
    check(r, 'answered', r.ok, r.error)
    const t = flatMath(r.text)
    check(r, 'names the product rule', /product rule/i.test(r.text), r.text.slice(0, 200))
    check(r, 'has 2x sin x', /2x(\*|·)?sin\(?x/.test(t), t.slice(0, 300))
    check(r, 'has x² cos x', /x²(\*|·)?cos\(?x/.test(t), t.slice(0, 300))
  })

  it('I: multi-turn typed tutoring keeps the conversation', { timeout }, async () => {
    const history: ThreadEntry[] = []
    const say = async (q: string) => {
      const r = await run('I', { task: 'chat', turns: buildTurns(history, [{ text: q }]) })
      history.push({ role: 'user', parts: [{ text: q }], ok: true }, { role: 'model', parts: [{ text: r.text || '(no answer)' }], ok: r.ok })
      return r
    }
    const a = await say('How do I add 1/3 + 1/4? Explain it simply.')
    check(a, 'answered', a.ok, a.error)
    check(a, 'explains the common denominator', /common denominator|same (bottom|denominator)|lcd|least common/i.test(a.text), a.text.slice(0, 200))
    // A tutor may leave the sum to the student; if it does give one, it must be right (not 2/7).
    check(a, 'no wrong sum (2/7)', !/(^|[^\d])2\/7/.test(flatMath(a.text)), flatMath(a.text).slice(0, 300))
    const b = await say('Now give me a hint for 2/5 + 1/3, but don’t solve it for me.')
    check(b, 'answered', b.ok, b.error)
    check(b, 'the hint points at a common denominator', /common denominator|15|both 5 and 3|5 and 3/i.test(b.text), b.text.slice(0, 200))
    check(b, 'does not give away 11/15', !/11\/15/.test(flatMath(b.text)), b.text.slice(0, 300))
    const c = await say('I got 11/15. Is that right?')
    check(c, 'answered', c.ok, c.error)
    // 11/15 IS right: the answer must say so plainly, and must not send the student back to re-check.
    const opening = c.text.trim().split(/(?<=[.!?])\s/)[0] ?? ''
    check(c, 'confirms 11/15 is correct (first sentence)', /\b(yes|correct|right|well done|exactly|spot on)\b/i.test(opening) && !/\b(close|almost|not quite)\b/i.test(opening), opening)
    check(c, 'does not ask a correct student to re-check', !/(take (a )?(second|another) look|double-check your|re-?check|very close|almost there|not quite)/i.test(c.text) && !claimsMistake(c.text), c.text.slice(0, 200))
  })

  it('J: corrects a wrong worked example in PDF text', { timeout }, async () => {
    const page = `<page title="Geometry worksheet p. 2">\nText of the PDF page:\nWorked example: A circle has radius 3 cm. Its area is A = 2πr = 6π cm².\nExercise 2: Find the area of a circle with radius 5 cm.\n</page>`
    const r = await run('J', chatWith([{ text: page }, { text: 'Is the worked example on this page correct? Then solve exercise 2.' }]))
    check(r, 'answered', r.ok, r.error)
    const t = flatMath(r.text)
    check(r, 'says the example is wrong', claimsMistake(r.text) || /circumference/i.test(r.text), r.text.slice(0, 200))
    check(r, 'correct example area 9π', /9pi/.test(t), t.slice(0, 300))
    check(r, 'exercise area 25π', /25pi/.test(t), t.slice(0, 300))
  })

  it('K: judges typed answers: equivalent form right, wrong value wrong', { timeout }, async () => {
    const ask = (answer: string): AiRequest => ({ task: 'check', turns: [{ role: 'user', parts: [{ text: 'Practice problem:\nSolve $2x + 3 = 11$.\n\nExpected final answer: $x = 4$' }, { text: `Student answer (typed): ${answer}` }] }] })
    const right = await run('K', ask('x = 8/2'))
    check(right, 'check validates', !!right.validated, right.error ?? right.text.slice(0, 200))
    check(right, 'x = 8/2 judged correct', parseTaskResult('check', right.text)?.verdict === 'correct', right.text.slice(0, 200))
    const wrong = await run('K', ask('x = 7, because 11 − 3 = 7'))
    check(wrong, 'x = 7 not judged correct', parseTaskResult('check', wrong.text)?.verdict !== undefined && parseTaskResult('check', wrong.text)!.verdict !== 'correct', wrong.text.slice(0, 200))
  })

  it('L: typed follow-ups to a handwriting question stay with the model that read it', { timeout }, async () => {
    const image = await img('scenario-a.jpg')
    const history: ThreadEntry[] = []
    const say = async (parts: AiPart[]) => {
      const r = await run('L', { task: 'chat', turns: buildTurns(history, parts) })
      history.push({ role: 'user', parts, ok: true }, { role: 'model', parts: [{ text: r.text || '(no answer)' }], ok: r.ok })
      return r
    }
    const a = await say([selection, image, { text: 'Give me a hint for the next step.' }])
    check(a, 'answered', a.ok, a.error)
    check(a, 'on the main model', onMain(a), a.model)
    const b = await say([{ text: 'Why are the roots negative?' }])
    check(b, 'answered the follow-up', b.ok, b.error)
    check(b, 'follow-up on the main model', onMain(b), b.model)
    check(b, 'explains via the factors being zero', /zero|= ?0|negative|sign/i.test(b.text), b.text.slice(0, 200))
    const c = await say([{ text: 'Can you check x = −2 by substituting it into my first line?' }])
    check(c, 'answered the second follow-up', c.ok, c.error)
    check(c, 'second follow-up on the main model', onMain(c), c.model)
    check(c, 'substitutes: 4 − 10 + 6 = 0', /4-10\+6|=0/.test(flatMath(c.text)), flatMath(c.text).slice(0, 300))
  })
}
