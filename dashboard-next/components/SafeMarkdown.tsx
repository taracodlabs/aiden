'use client'

import { useState, type ReactNode } from 'react'

import {
  parseSafeMarkdown,
  type MarkdownInline,
  type MarkdownListBlock,
} from '../lib/safeMarkdown'

function InlineContent({ nodes }: { nodes: MarkdownInline[] }) {
  return <>{nodes.map((node, index): ReactNode => {
    const key = `${node.type}:${index}`
    if (node.type === 'text') return <span key={key}>{node.value}</span>
    if (node.type === 'strong') return <strong key={key}><InlineContent nodes={node.children} /></strong>
    if (node.type === 'emphasis') return <em key={key}><InlineContent nodes={node.children} /></em>
    if (node.type === 'code') return <code key={key}>{node.value}</code>
    if (node.type === 'break') return <br key={key} />
    if (!node.href) return <span key={key}><InlineContent nodes={node.children} /></span>
    const external = /^https?:/i.test(node.href)
    return <a key={key} href={node.href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}><InlineContent nodes={node.children} /></a>
  })}</>
}

function MarkdownList({ block }: { block: MarkdownListBlock }) {
  const items = block.items.map((item, index) => (
    <li key={index}>
      <InlineContent nodes={item.children} />
      {item.nested.map((nested, nestedIndex) => <MarkdownList key={nestedIndex} block={nested} />)}
    </li>
  ))
  return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    }).catch(() => {})
  }
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{language || 'code'}</span>
        <button type="button" className="aiden-button aiden-button-ghost aiden-button-compact" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre tabIndex={0}><code>{value}</code></pre>
    </div>
  )
}

export function SafeMarkdown({ content }: { content: string }) {
  const blocks = parseSafeMarkdown(content)
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        const key = `${block.type}:${index}`
        if (block.type === 'heading') {
          if (block.level === 1) return <h1 key={key}><InlineContent nodes={block.children} /></h1>
          if (block.level === 2) return <h2 key={key}><InlineContent nodes={block.children} /></h2>
          return <h3 key={key}><InlineContent nodes={block.children} /></h3>
        }
        if (block.type === 'paragraph') return <p key={key}><InlineContent nodes={block.children} /></p>
        if (block.type === 'blockquote') return <blockquote key={key}><InlineContent nodes={block.children} /></blockquote>
        if (block.type === 'rule') return <hr key={key} />
        if (block.type === 'code') return <CodeBlock key={key} language={block.language} value={block.value} />
        if (block.type === 'list') return <MarkdownList key={key} block={block} />
        return (
          <div className="markdown-table-wrap" key={key} tabIndex={0}>
            <table>
              <thead><tr>{block.headers.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: block.alignments[cellIndex] ?? 'left' }}><InlineContent nodes={cell} /></th>)}</tr></thead>
              <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ textAlign: block.alignments[cellIndex] ?? 'left' }}><InlineContent nodes={cell} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
