/**
 * v4.9.0 pre-ship UI — markdown block terminators.
 * paragraph↔list / blockquote↔paragraph separated by blank line;
 * intra-list items stay tight.
 */
import { describe, it, expect } from 'vitest';
import { getReplyRenderer } from '../../../../cli/v4/replyRenderer';

const render = (md: string): string[] =>
  getReplyRenderer().render(md).replace(/\x1b\[[0-9;]*m/g, '').split('\n');

describe('markdown block terminators', () => {
  it('para → list → para: blank above + below list, tight inside', () => {
    const L = render('Para A.\n\n- b1\n- b2\n\nPara B.');
    const i1 = L.findIndex((l) => /b1/.test(l));
    const i2 = L.findIndex((l) => /b2/.test(l));
    expect(i2 - i1).toBe(1);                      // intra-list tight
    expect(L[i1 - 1].trim()).toBe('');             // blank before list
    expect(L[i2 + 1].trim()).toBe('');             // blank after list
  });
  it('blockquote → paragraph: blank line after quote', () => {
    const L = render('> quoted\n\nAfter.');
    const q = L.findIndex((l) => /quoted/.test(l));
    const a = L.findIndex((l) => /After\./.test(l));
    expect(a - q).toBeGreaterThanOrEqual(2);
  });
  it('para → para: blank line between', () => {
    const L = render('First.\n\nSecond.');
    expect(L.findIndex((l) => /Second/.test(l)) - L.findIndex((l) => /First/.test(l))).toBeGreaterThanOrEqual(2);
  });
});
