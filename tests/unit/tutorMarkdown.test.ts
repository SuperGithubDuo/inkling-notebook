// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, MarkdownInline } from '../../src/renderer/src/ai/Markdown'

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

describe('tutor Markdown rendering', () => {
  it('renders inline and display math with KaTeX', () => {
    const out = html('Subtract $3$ from both sides:\n\n$$2x = 8$$\n\nso **x = 4**.')
    expect(out).toContain('class="katex"')
    expect(out).toContain('katex-display')
    expect(out).toContain('<strong>x = 4</strong>')
    expect(html('Also \\(x^2\\) and\n\n\\[y=1\\]')).toMatch(/katex[\s\S]*katex-display/)
  })

  it('leaves prices and unclosed dollars as text', () => {
    const out = html('It costs $5 and $6 today, and $x is unfinished')
    expect(out).not.toContain('katex')
    expect(out).toContain('$5 and $6')
  })

  it('never injects HTML from the answer and only links to http(s)', () => {
    const out = html('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](https://example.com)\n\n<script>alert(1)</script>')
    expect(out).not.toMatch(/<img|<script/)
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('href="https://example.com"')
  })

  it('renders lists, tables and code', () => {
    const out = html('1. one $a$\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```')
    expect(out).toMatch(/<ol><li>one <span><span class="katex">/)
    expect(out).toContain('<td>2</td>')
    expect(out).toContain('<pre><code>code</code></pre>')
  })

  it('renders inline-only text with math', () => {
    expect(renderToStaticMarkup(createElement(MarkdownInline, { text: 'Solve $x^2=4$ & check' }))).toMatch(/Solve <span><span class="katex">[\s\S]* &amp; check/)
  })
})
