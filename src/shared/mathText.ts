/**
 * Converts simple LaTeX (as models write it) into plain text with Unicode
 * math, for places that cannot typeset formulas, such as text boxes drawn on
 * the canvas: "$\frac{x^2}{2} \le \sqrt{y}$" → "(x²)/2 ≤ √y".
 */

const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←',
  implies: '⇒', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀',
  exists: '∃', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', degree: '°', circ: '°', angle: '∠', perp: '⊥',
  parallel: '∥', therefore: '∴', ldots: '…', cdots: '⋯', dots: '…', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '!': '', ' ': ' ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  left: '', right: '', big: '', Big: '', displaystyle: '', textstyle: '', limits: '', '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', _: '_'
}
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh'])
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', k: 'ᵏ', m: 'ᵐ', t: 'ᵗ' }
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', i: 'ᵢ', x: 'ₓ', a: 'ₐ', k: 'ₖ', m: 'ₘ', t: 'ₜ' }

/** Reads a `{group}` or single token starting at i; returns its source and the next index. */
function readArg(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++
  if (s[i] === '{') {
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1]
    }
    return [s.slice(i + 1), s.length]
  }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i))
    if (m) return [m[0], i + m[0].length]
  }
  return [s[i] ?? '', i + 1]
}

const script = (text: string, map: Record<string, string>, mark: string): string =>
  [...text].every((c) => map[c]) ? [...text].map((c) => map[c]).join('') : `${mark}${text.length > 1 ? `(${text})` : text}`
/** Wraps compound expressions in parentheses so "a+b/c" stays unambiguous. */
const group = (t: string): string => (/^[\p{L}\p{N}.²³√]+$/u.test(t) ? t : `(${t})`)

function convert(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i))
      if (!m) {
        i++
        continue
      }
      const name = m[1]!
      i += m[0].length
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, j] = readArg(s, i)
        const [b, k] = readArg(s, j)
        out += `${group(convert(a))}/${group(convert(b))}`
        i = k
      } else if (name === 'sqrt') {
        let root = ''
        if (s[i] === '[') {
          const end = s.indexOf(']', i)
          root = convert(s.slice(i + 1, end))
          i = end + 1
        }
        const [a, j] = readArg(s, i)
        out += `${root ? script(root, SUP, '^') : ''}√${group(convert(a))}`
        i = j
      } else if (['text', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'textbf', 'textit', 'mbox', 'boxed'].includes(name)) {
        const [a, j] = readArg(s, i)
        out += name.startsWith('text') || name === 'mbox' ? a : convert(a)
        i = j
      } else if (FUNCS.has(name)) out += name
      else if (name in SYMBOLS) out += SYMBOLS[name]
      else out += name
    } else if (c === '^' || c === '_') {
      const [a, j] = readArg(s, i + 1)
      out += script(convert(a), c === '^' ? SUP : SUB, c)
      i = j
    } else if (c === '{' || c === '}') i++
    else if (c === '~') {
      out += ' '
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Plain-text version of a string that may contain $…$, $$…$$, \(…\) or \[…\] math. */
export function latexToPlain(text: string): string {
  const replaced = text.replace(/\$\$([\s\S]+?)\$\$|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g, (_, a, b, c, d) => convert(a ?? b ?? c ?? d))
  // Bare LaTeX commands outside delimiters (models sometimes forget them).
  const plain = /\\[A-Za-z]/.test(replaced) ? convert(replaced) : replaced
  return plain.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[ \t]{2,}/g, ' ').trim()
}
