import { describe, expect, it } from 'vitest'
import { latexToPlain } from '../../src/shared/mathText'

describe('LaTeX to plain text', () => {
  it.each([
    ['Solve $x^2 - 5x + 6 = 0$.', 'Solve x² - 5x + 6 = 0.'],
    ['$\\frac{1}{2}x$', '1/2x'],
    ['$\\frac{x+1}{x-1}$', '(x+1)/(x-1)'],
    ['$\\sqrt{x^2+1} \\le 3\\pi$', '√(x²+1) ≤ 3π'],
    ['$a_{n+1} = 2a_n$', 'aₙ₊₁ = 2aₙ'],
    ['$$x = \\pm\\sqrt{4}$$', 'x = ±√4'],
    ['\\(2 \\times 3 \\neq 5\\)', '2 × 3 ≠ 5'],
    ['$e^{i\\theta}$', 'e^(iθ)'],
    ['$\\sin^2\\theta + \\cos^2\\theta = 1$', 'sin²θ + cos²θ = 1'],
    ['$x = 4$ \\text{ only}', 'x = 4 only'],
    ['It costs 5 dollars', 'It costs 5 dollars'],
    ['**Check:** $11 - 3 = 8$', 'Check: 11 - 3 = 8']
  ])('%s → %s', (input, expected) => {
    expect(latexToPlain(input)).toBe(expected)
  })
})
