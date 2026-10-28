/**
 * Renders the tutor's Markdown answers as React elements, with KaTeX math.
 *
 * Answers come from a remote model, so no HTML from them is ever injected:
 * Markdown is tokenised with `marked` and each token becomes a React element
 * (raw HTML shows as text, links must be http(s)). The only injected markup
 * is KaTeX's own output, rendered with `trust: false`.
 */
import { memo, type ReactNode } from 'react'
import { Marked, type Token, type TokenizerExtension, type Tokens } from 'marked'
import katex from 'katex'
import 'katex/dist/katex.min.css'

interface MathToken extends Tokens.Generic {
  type: 'math'
  text: string
  display: boolean
}

const blockMath: TokenizerExtension = {
  name: 'math',
  level: 'block',
  start: (src) => {
    const i = src.search(/\$\$|\\\[/)
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src) ?? /^\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/.exec(src)
    if (m) return { type: 'math', raw: m[0], text: m[1]!.trim(), display: true }
    return undefined
  }
}

const inlineMath: TokenizerExtension = {
  name: 'math',
  level: 'inline',
  start: (src) => {
    const i = src.search(/\$|\\\(/)
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    let m = /^\$\$([^$]+?)\$\$/.exec(src)
    if (m) return { type: 'math', raw: m[0], text: m[1]!.trim(), display: true }
    // $…$ that does not start or end with a space and is not followed by a digit (so "$5 and $6" stays text).
    m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src) ?? /^\\\(([\s\S]+?)\\\)/.exec(src)
    if (m) return { type: 'math', raw: m[0], text: m[1]!.trim(), display: false }
    return undefined
  }
}

const marked = new Marked({ gfm: true, breaks: false, extensions: [blockMath, inlineMath] })

function Math({ tex, display }: { tex: string; display: boolean }) {
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' })
  return display ? <div className="tutor-math-block" dangerouslySetInnerHTML={{ __html: html }} /> : <span dangerouslySetInnerHTML={{ __html: html }} />
}

function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((t, i) => <InlineToken key={i} token={t} />)
}

function InlineToken({ token: t }: { token: Token }): ReactNode {
  switch (t.type) {
    case 'text':
      return 'tokens' in t && t.tokens?.length ? inline(t.tokens) : decode(t.text)
    case 'escape':
      return t.text
    case 'strong':
      return <strong>{inline(t.tokens)}</strong>
    case 'em':
      return <em>{inline(t.tokens)}</em>
    case 'del':
      return <del>{inline(t.tokens)}</del>
    case 'codespan':
      return <code>{decode(t.text)}</code>
    case 'br':
      return <br />
    case 'math':
      return <Math tex={(t as MathToken).text} display={(t as MathToken).display} />
    case 'link':
      return /^https?:\/\//i.test(t.href) ? (
        <a href={t.href} target="_blank" rel="noreferrer">
          {inline(t.tokens)}
        </a>
      ) : (
        inline(t.tokens)
      )
    case 'image':
      return t.text ? `[${t.text}]` : null
    default:
      return 'raw' in t ? t.raw : null
  }
}

function Block({ token: t }: { token: Token }): ReactNode {
  switch (t.type) {
    case 'space':
      return null
    case 'paragraph':
      return <p>{inline(t.tokens)}</p>
    case 'text':
      return 'tokens' in t && t.tokens ? <p>{inline(t.tokens)}</p> : <p>{decode(t.text)}</p>
    case 'heading':
      return t.depth <= 2 ? <h4>{inline(t.tokens)}</h4> : <h5>{inline(t.tokens)}</h5>
    case 'math':
      return <Math tex={(t as MathToken).text} display />
    case 'code':
      return (
        <pre>
          <code>{t.text}</code>
        </pre>
      )
    case 'blockquote':
      return <blockquote>{blocks(t.tokens)}</blockquote>
    case 'hr':
      return <hr />
    case 'list': {
      const items = (t as Tokens.List).items.map((item, i) => (
        <li key={i}>
          {item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled />}
          {item.tokens.length === 1 && item.tokens[0]!.type === 'text' ? inline((item.tokens[0] as Tokens.Text).tokens) : blocks(item.tokens)}
        </li>
      ))
      return t.ordered ? <ol start={typeof t.start === 'number' && t.start !== 1 ? t.start : undefined}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table': {
      const table = t as Tokens.Table
      return (
        <div className="tutor-table">
          <table>
            <thead>
              <tr>
                {table.header.map((c, i) => (
                  <th key={i}>{inline(c.tokens)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{inline(c.tokens)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    default:
      return 'raw' in t && t.raw.trim() ? <p>{t.raw}</p> : null
  }
}

function blocks(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((t, i) => <Block key={i} token={t} />)
}

/** marked keeps entities such as &amp; in text tokens; show them as characters. */
function decode(s: string): string {
  return s.includes('&') ? s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!) : s
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`tutor-md ${className ?? ''}`}>{blocks(marked.lexer(text))}</div>
})

/** Inline-only rendering (for short strings such as practice questions in a row). */
export const MarkdownInline = memo(function MarkdownInline({ text }: { text: string }) {
  return <>{inline(marked.Lexer.lexInline(text, { gfm: true, extensions: marked.defaults.extensions } as never))}</>
})
