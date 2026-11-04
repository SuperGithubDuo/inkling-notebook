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
