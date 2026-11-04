/** The plain-maths flattening the text scenarios' checks rely on (tests/live/scenarios-text.ts). */
import { describe, expect, it } from 'vitest'
import { flatMath } from '../live/scenarios-text'

describe('flatMath', () => {
  it('reads fractions, π and functions however the model typesets them', () => {
    expect(flatMath('The result is $\\frac{7}{12}$.')).toContain('7/12')
    expect(flatMath('$\\dfrac{11}{15}$')).toContain('11/15')
    expect(flatMath('So $x = 6$.')).toMatch(/x=6(?!\d|\/|\.\d)/)
    expect(flatMath('x = 6.5')).not.toMatch(/x=6(?!\d|\/|\.\d)/)
    expect(flatMath('$A = \\pi r^2 = 9\\pi \\text{ cm}^2$')).toContain('9pi')
    expect(flatMath('25π cm²')).toContain('25pi')
    expect(flatMath("$f'(x) = 2x \\sin x + x^2 \\cos x$")).toMatch(/2x(\*|·)?sin\(?x/)
    expect(flatMath("$f'(x) = 2x \\sin x + x^2 \\cos x$")).toMatch(/x²(\*|·)?cos\(?x/)
    expect(flatMath('(−2)² + 5(−2) + 6 = 4 − 10 + 6 = 0')).toMatch(/4-10\+6/)
  })
})

import { answerNumber, checkFinalSpeed, checkLinear, checkPolynomialDerivative } from '../live/scenarios-practice'

const P = (question: string, answer: string) => ({ question, answer, difficulty: 'easy' as const, hints: ['h'], solution: answer })

describe('practice verifiers', () => {
  it('reads one number from an answer', () => {
    expect(answerNumber('$x = 8$')).toBe(8)
    expect(answerNumber('t = -3/2')).toBe(-1.5)
    expect(answerNumber('$\\frac{7}{2}$')).toBe(3.5)
    expect(answerNumber('20 m/s')).toBe(20)
    expect(Number.isNaN(answerNumber('x = 2 or x = 3'))).toBe(true)
  })
  it('linear equations: substitutes the answer back', () => {
    expect(checkLinear(P('Solve for $x$: $x + 7 = 15$', '$x = 8$'))).toBe(true)
    expect(checkLinear(P('Solve for $y$: $4y = 24$', '$y = 6$'))).toBe(true)
    expect(checkLinear(P('Solve for x: 3(x - 2) + 4 = 19', 'x = 7'))).toBe(true)
    expect(checkLinear(P('Solve for x: 3(x − 2) = 12', 'x = 14/3'))).toBe(false)
    expect(checkLinear(P('Solve $\\frac{x}{2} - 3 = 5$', 'x = 16'))).toBe(true)
    expect(checkLinear(P('Solve for $x$: $5x - 3 = 2x + 9$', '$x = 4$'))).toBe(true)
    expect(checkLinear(P('A number is doubled and 5 added to get 17. What is it?', '6'))).toBeNull()
  })
  it('polynomial derivatives: recomputes them', () => {
    expect(checkPolynomialDerivative(P('Find the derivative of $f(x) = 3x^3 - 2x + 5$.', "$f'(x) = 9x^2 - 2$"))).toBe(true)
    expect(checkPolynomialDerivative(P('Differentiate f(x) = x² + 4x', "f'(x) = 2x + 4"))).toBe(true)
    expect(checkPolynomialDerivative(P('Differentiate f(x) = x² + 4x', "f'(x) = 2x + 3"))).toBe(false)
    expect(checkPolynomialDerivative(P('Differentiate f(x) = sin(x) x^2', 'x')) ).toBeNull()
  })
  it('kinematics: recomputes v = u + at', () => {
    expect(checkFinalSpeed(P('A car starts from rest and accelerates at 3 m/s² for 4 s. What is its final speed?', '12 m/s'))).toBe(true)
    expect(checkFinalSpeed(P('A cyclist moving at 5 m/s accelerates at 2 m/s^2 for 6 seconds. Find the final velocity.', 'v = 17 m/s'))).toBe(true)
    expect(checkFinalSpeed(P('A train travelling at 30 m/s decelerates at 2 m/s² for 10 s. What is its final speed?', '10 m/s'))).toBe(true)
    expect(checkFinalSpeed(P('A car starts from rest and accelerates at 3 m/s² for 4 s. What is its final speed?', '7 m/s'))).toBe(false)
    expect(checkFinalSpeed(P('How far does it travel?', '80 m'))).toBeNull()
  })
})
