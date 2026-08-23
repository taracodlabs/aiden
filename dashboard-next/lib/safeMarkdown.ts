export type MarkdownInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'emphasis'; children: MarkdownInline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string | null; children: MarkdownInline[] }
  | { type: 'break' }

export interface MarkdownListItem {
  children: MarkdownInline[]
  nested: MarkdownListBlock[]
}

export interface MarkdownListBlock {
  type: 'list'
  ordered: boolean
  items: MarkdownListItem[]
}

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'blockquote'; children: MarkdownInline[] }
  | { type: 'code'; language: string; value: string }
  | MarkdownListBlock
  | { type: 'table'; headers: MarkdownInline[][]; rows: MarkdownInline[][][]; alignments: Array<'left' | 'center' | 'right' | null> }
  | { type: 'rule' }

const INLINE_PATTERNS = [
  { kind: 'code', pattern: /`([^`\n]+)`/ },
  { kind: 'strong', pattern: /\*\*([^*\n]+)\*\*/ },
  { kind: 'strong', pattern: new RegExp('(?<![\\p{L}\\p{N}])__([^_\\n]+)__(?![\\p{L}\\p{N}])', 'u') },
  { kind: 'emphasis', pattern: /\*([^*\n]+)\*/ },
  { kind: 'emphasis', pattern: new RegExp('(?<![\\p{L}\\p{N}])_([^_\\n]+)_(?![\\p{L}\\p{N}])', 'u') },
  { kind: 'link', pattern: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
] as const

export function safeLinkTarget(value: string): string | null {
  const target = value.trim()
  if (/^(https?:|mailto:)/i.test(target)) return target
  if (target.startsWith('#') || target.startsWith('/')) return target
  return null
}

export function parseMarkdownInline(value: string): MarkdownInline[] {
  const source = value
    .replace(/ {2,}\n/g, '\u0000')
    .replace(/\n/g, ' ')
  const output: MarkdownInline[] = []
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] === '\u0000') {
      output.push({ type: 'break' })
      cursor += 1
      continue
    }

    let match: { kind: typeof INLINE_PATTERNS[number]['kind']; result: RegExpExecArray } | null = null
    for (const candidate of INLINE_PATTERNS) {
      candidate.pattern.lastIndex = 0
      const result = candidate.pattern.exec(source.slice(cursor))
      if (!result) continue
      if (!match || result.index < match.result.index) match = { kind: candidate.kind, result }
    }

    if (!match) {
      output.push({ type: 'text', value: source.slice(cursor).replaceAll('\u0000', '\n') })
      break
    }

    if (match.result.index > 0) {
      output.push({ type: 'text', value: source.slice(cursor, cursor + match.result.index).replaceAll('\u0000', '\n') })
    }

    const full = match.result[0]
    if (match.kind === 'code') output.push({ type: 'code', value: match.result[1] ?? '' })
    else if (match.kind === 'strong') output.push({ type: 'strong', children: parseMarkdownInline(match.result[1] ?? '') })
    else if (match.kind === 'emphasis') output.push({ type: 'emphasis', children: parseMarkdownInline(match.result[1] ?? '') })
    else output.push({
      type: 'link',
      href: safeLinkTarget(match.result[2] ?? ''),
      children: parseMarkdownInline(match.result[1] ?? ''),
    })
    cursor += match.result.index + full.length
  }

  return output
}

interface RawListRow {
  depth: number
  ordered: boolean
  value: string
}

function buildList(rows: RawListRow[]): MarkdownListBlock {
  const root: MarkdownListBlock = { type: 'list', ordered: rows[0]?.ordered ?? false, items: [] }
  const stack: Array<{ depth: number; list: MarkdownListBlock }> = [{ depth: rows[0]?.depth ?? 0, list: root }]

  for (const row of rows) {
    while (stack.length > 1 && row.depth < stack[stack.length - 1]!.depth) stack.pop()
    let frame = stack[stack.length - 1]!
    if (row.depth > frame.depth) {
      const parent = frame.list.items[frame.list.items.length - 1]
      if (parent) {
        const nested: MarkdownListBlock = { type: 'list', ordered: row.ordered, items: [] }
        parent.nested.push(nested)
        frame = { depth: row.depth, list: nested }
        stack.push(frame)
      }
    }
    frame.list.items.push({ children: parseMarkdownInline(row.value), nested: [] })
  }
  return root
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of trimmed) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '|') { cells.push(current.trim()); current = ''; continue }
    current += character
  }
  cells.push(current.trim())
  return cells
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (!line.trim()) return true
  if (/^```/.test(line) || /^#{1,3}\s+/.test(line) || /^\s*([-+*]|\d+\.)\s+/.test(line)) return true
  if (/^\s*>/.test(line) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true
  return index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1] ?? '')
}

export function parseSafeMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) { index += 1; continue }

    const fence = line.match(/^```\s*([^\s`]*)\s*$/)
    if (fence) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) body.push(lines[index++] ?? '')
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', language: (fence[1] ?? '').trim(), value: body.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, children: parseMarkdownInline(heading[2] ?? '') })
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quote.push((lines[index++] ?? '').replace(/^\s*>\s?/, ''))
      }
      blocks.push({ type: 'blockquote', children: parseMarkdownInline(quote.join('\n')) })
      continue
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headerCells = splitTableRow(line)
      const dividers = splitTableRow(lines[index + 1] ?? '')
      const alignments = dividers.map((cell) => {
        const compact = cell.replace(/\s/g, '')
        if (compact.startsWith(':') && compact.endsWith(':')) return 'center'
        if (compact.endsWith(':')) return 'right'
        if (compact.startsWith(':')) return 'left'
        return null
      }) as Array<'left' | 'center' | 'right' | null>
      index += 2
      const rows: MarkdownInline[][][] = []
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(splitTableRow(lines[index++] ?? '').map(parseMarkdownInline))
      }
      blocks.push({ type: 'table', headers: headerCells.map(parseMarkdownInline), rows, alignments })
      continue
    }

    const listMatch = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/)
    if (listMatch) {
      const rows: RawListRow[] = []
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/)
        if (!match) break
        const indent = (match[1] ?? '').replace(/\t/g, '  ').length
        rows.push({ depth: indent, ordered: /^\d/.test(match[2] ?? ''), value: match[3] ?? '' })
        index += 1
      }
      blocks.push(buildList(rows))
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && !startsBlock(lines, index)) paragraph.push((lines[index++] ?? '').trim())
    blocks.push({ type: 'paragraph', children: parseMarkdownInline(paragraph.join('\n')) })
  }

  return blocks
}
