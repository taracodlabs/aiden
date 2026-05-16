/**
 * v4.5 Phase 5a — prompt template renderer tests.
 *
 * Covers:
 *   1. {{var}} substitution + numeric / boolean coercion
 *   2. Missing variables left in place + collected in `missing`
 *   3. Whitespace tolerance: {{ var }} ≡ {{var}}
 *   4. flattenPayloadToVars: primitives passthrough; objects stringified
 */
import { describe, it, expect } from 'vitest';
import {
  renderPromptTemplate,
  flattenPayloadToVars,
} from '../../../../core/v4/daemon/dispatcher/promptTemplate';

describe('renderPromptTemplate', () => {
  it('substitutes {{var}} with string / number / boolean values', () => {
    const r = renderPromptTemplate(
      'Hello {{name}}, score is {{n}}, ready: {{ok}}',
      { name: 'Aiden', n: 42, ok: true },
    );
    expect(r.rendered).toBe('Hello Aiden, score is 42, ready: true');
    expect(r.missing).toEqual([]);
  });

  it('collects missing vars + leaves placeholders in place', () => {
    const r = renderPromptTemplate(
      'A={{a}} B={{b}} C={{c}}',
      { a: 'X' /* b + c missing */ },
    );
    // {{b}} + {{c}} remain in the rendered output verbatim.
    expect(r.rendered).toBe('A=X B={{b}} C={{c}}');
    expect(r.missing.sort()).toEqual(['b', 'c']);
  });

  it('tolerates whitespace inside braces: {{ var }} matches {{var}}', () => {
    const r = renderPromptTemplate(
      '{{ path }} == {{path}}',
      { path: '/etc/hosts' },
    );
    expect(r.rendered).toBe('/etc/hosts == /etc/hosts');
    expect(r.missing).toEqual([]);
  });

  it('treats null/undefined as missing (not as the literal string)', () => {
    const r = renderPromptTemplate(
      'optional: {{maybe}}',
      { maybe: null },
    );
    expect(r.rendered).toBe('optional: {{maybe}}');
    expect(r.missing).toEqual(['maybe']);
  });

  it('empty template → empty rendered + no missing', () => {
    const r = renderPromptTemplate('', { x: 1 });
    expect(r.rendered).toBe('');
    expect(r.missing).toEqual([]);
  });
});

describe('flattenPayloadToVars', () => {
  it('passes through primitives + JSON-stringifies objects', () => {
    const out = flattenPayloadToVars({
      path:    '/tmp/foo.txt',
      bytes:   1024,
      modified: true,
      meta:    { kind: 'file', nested: { k: 'v' } },
    });
    expect(out.path).toBe('/tmp/foo.txt');
    expect(out.bytes).toBe(1024);
    expect(out.modified).toBe(true);
    expect(typeof out.meta).toBe('string');
    expect(JSON.parse(String(out.meta))).toEqual({ kind: 'file', nested: { k: 'v' } });
  });

  it('preserves null as null (missing-var semantics)', () => {
    const out = flattenPayloadToVars({ foo: null });
    expect(out.foo).toBeNull();
  });
});
