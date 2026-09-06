/**
 * A deliberately small Markdown renderer for the legal drafts in `legal/`.
 *
 * Only the constructs those documents use: headings, paragraphs, unordered lists,
 * pipe tables, bold, italics and inline code. Keeping it to ~80 lines avoids pulling a
 * Markdown dependency and its sanitiser into the bundle for four static pages, and the
 * input is repo-controlled, never user content.
 */

import { Fragment, type ReactNode } from 'react'

function inline(text: string, keyPrefix: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean)
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`
    if (token.startsWith('**') && token.endsWith('**')) {
      return (
        <strong key={key} className="text-[var(--color-ink)]">
          {token.slice(2, -2)}
        </strong>
      )
    }
    if (token.startsWith('*') && token.endsWith('*')) {
      return <em key={key}>{token.slice(1, -1)}</em>
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code key={key} className="tabular text-sm bg-[var(--color-bg)] px-1.5 py-0.5 rounded">
          {token.slice(1, -1)}
        </code>
      )
    }
    return <Fragment key={key}>{token}</Fragment>
  })
}

const isTableSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line.trim())

export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let table: string[][] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const text = paragraph.join(' ')
    blocks.push(
      <p key={`p-${blocks.length}`} className="text-[var(--color-ink-2)] leading-relaxed mb-4">
        {inline(text, `p${blocks.length}`)}
      </p>,
    )
    paragraph = []
  }

  const flushList = () => {
    if (list.length === 0) return
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="list-disc pl-5 mb-4 grid gap-1.5 text-[var(--color-ink-2)]">
        {list.map((item, i) => (
          <li key={i}>{inline(item, `li${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  const flushTable = () => {
    if (table.length === 0) return
    const [head, ...body] = table
    blocks.push(
      <div key={`t-${blocks.length}`} className="overflow-x-auto mb-6">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              {(head ?? []).map((cell, i) => (
                <th
                  key={i}
                  className="text-left font-semibold py-2 pr-4 border-b border-[var(--color-line)] whitespace-nowrap"
                >
                  {inline(cell, `th${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="py-2 pr-4 border-b border-[var(--color-line)] text-[var(--color-ink-2)] align-top">
                    {inline(cell, `td${r}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    )
    table = []
  }

  const flushAll = () => {
    flushParagraph()
    flushList()
    flushTable()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.trim() === '') {
      flushAll()
      continue
    }

    if (line.startsWith('|')) {
      flushParagraph()
      flushList()
      if (isTableSeparator(line)) continue
      table.push(
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      )
      continue
    }
    flushTable()

    if (line.startsWith('### ')) {
      flushAll()
      blocks.push(
        <h3 key={`h3-${blocks.length}`} className="text-lg mt-6 mb-2">
          {line.slice(4)}
        </h3>,
      )
    } else if (line.startsWith('## ')) {
      flushAll()
      blocks.push(
        <h2 key={`h2-${blocks.length}`} className="text-xl mt-8 mb-3">
          {line.slice(3)}
        </h2>,
      )
    } else if (line.startsWith('# ')) {
      flushAll()
      blocks.push(
        <h1 key={`h1-${blocks.length}`} className="text-3xl mb-4">
          {line.slice(2)}
        </h1>,
      )
    } else if (line.startsWith('- ')) {
      flushParagraph()
      list.push(line.slice(2))
    } else {
      flushList()
      paragraph.push(line)
    }
  }

  flushAll()
  return <div className="max-w-2xl">{blocks}</div>
}
