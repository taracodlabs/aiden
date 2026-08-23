/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import { parseSafeMarkdown, safeLinkTarget } from '../../../dashboard-next/lib/safeMarkdown';

describe('Workbench safe Markdown', () => {
  it('parses the supported rich-text blocks without treating raw HTML as markup', () => {
    const blocks = parseSafeMarkdown([
      '# Result',
      '',
      'A **verified** result with *context* and `inline code`.',
      '',
      '> A useful note',
      '',
      '1. First',
      '   1. Nested',
      '2. Second',
      '',
      '| File | State |',
      '| --- | --- |',
      '| package.json | verified |',
      '',
      '---',
      '',
      '```json',
      '{"ok":true}',
      '```',
      '',
      '<img src=x onerror="window.pwned=true">',
    ].join('\n'));

    expect(blocks.map((block) => block.type)).toEqual([
      'heading', 'paragraph', 'blockquote', 'list', 'table', 'rule', 'code', 'paragraph',
    ]);
    expect(JSON.stringify(blocks)).toContain('verified');
    expect(JSON.stringify(blocks)).toContain('<img src=x onerror');
    expect(JSON.stringify(blocks)).not.toContain('dangerouslySetInnerHTML');
  });

  it('keeps only safe interactive link targets', () => {
    expect(safeLinkTarget('https://example.com/path')).toBe('https://example.com/path');
    expect(safeLinkTarget('http://127.0.0.1:4200')).toBe('http://127.0.0.1:4200');
    expect(safeLinkTarget('mailto:user@example.com')).toBe('mailto:user@example.com');
    expect(safeLinkTarget('#evidence')).toBe('#evidence');
    expect(safeLinkTarget('/artifacts/result')).toBe('/artifacts/result');
    expect(safeLinkTarget('javascript:alert(1)')).toBeNull();
    expect(safeLinkTarget('data:text/html,boom')).toBeNull();
  });

  it('does not confuse list, table, and fenced-code boundaries', () => {
    const blocks = parseSafeMarkdown([
      '- alpha',
      '- beta',
      '',
      '| A | B |',
      '| :--- | ---: |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const value = "| not a table |"',
      '```',
    ].join('\n'));

    expect(blocks).toMatchObject([
      { type: 'list', ordered: false },
      { type: 'table', headers: expect.any(Array), rows: expect.any(Array) },
      { type: 'code', language: 'ts', value: 'const value = "| not a table |"' },
    ]);
  });

  it('preserves intraword underscores instead of inventing emphasis', () => {
    expect(parseSafeMarkdown('PRODUCT_POLISH_WEB_OK and file_name.ts')).toEqual([{
      type: 'paragraph',
      children: [{ type: 'text', value: 'PRODUCT_POLISH_WEB_OK and file_name.ts' }],
    }]);
  });
});
