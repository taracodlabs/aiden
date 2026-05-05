/**
 * Phase 16d: renderMemoryConfirmations — inline confirmation lines for
 * verified memory writes. Gated strictly on `verified=true` so we never
 * fabricate a "Saved" message for an unverified or errored write.
 */
import { describe, it, expect } from 'vitest';

import { renderMemoryConfirmations } from '../../../cli/v4/chatSession';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

class StubDisplay {
  successes: string[] = [];
  warnings: string[] = [];
  success(t: string): void {
    this.successes.push(t);
  }
  warn(t: string): void {
    this.warnings.push(t);
  }
}

const trace = (entries: Partial<HonestyTraceEntry>[]): HonestyTraceEntry[] =>
  entries.map((e) => ({
    name: e.name ?? 'memory_add',
    result: e.result ?? null,
    verified: e.verified,
    error: e.error,
  })) as HonestyTraceEntry[];

describe('renderMemoryConfirmations', () => {
  it('1. verified memory_add → "Saved to memory."', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_add', verified: true, result: { file: 'memory' } },
      ]),
      d,
    );
    expect(d.successes).toEqual(['Saved to memory.']);
    expect(d.warnings).toEqual([]);
  });

  it('2. verified memory_replace on user file → "Updated user profile."', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_replace', verified: true, result: { file: 'user' } },
      ]),
      d,
    );
    expect(d.successes).toEqual(['Updated user profile.']);
  });

  it('3. unverified memory_add → warning, no success', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_add', verified: false, result: { file: 'memory' } },
      ]),
      d,
    );
    expect(d.successes).toEqual([]);
    expect(d.warnings[0]).toMatch(/not verified/i);
  });

  it('4. errored write → warning with error message', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_add', error: 'capacity exceeded', result: null },
      ]),
      d,
    );
    expect(d.successes).toEqual([]);
    expect(d.warnings[0]).toMatch(/capacity exceeded/);
  });

  it('5. non-memory tools are ignored', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'read_file', verified: true, result: { ok: true } },
        { name: 'shell', verified: true, result: { ok: true } },
      ]),
      d,
    );
    expect(d.successes).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('6. missing/unknown verified flag → warning (treats as unverified)', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([{ name: 'memory_add', result: { file: 'memory' } }]),
      d,
    );
    expect(d.successes).toEqual([]);
    expect(d.warnings.length).toBe(1);
  });

  it('7. memory_remove uses correct verb', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_remove', verified: true, result: { file: 'memory' } },
      ]),
      d,
    );
    expect(d.successes).toEqual(['Removed from memory.']);
  });

  it('8. multiple entries render in order', () => {
    const d = new StubDisplay();
    renderMemoryConfirmations(
      trace([
        { name: 'memory_add', verified: true, result: { file: 'memory' } },
        { name: 'memory_add', verified: true, result: { file: 'user' } },
      ]),
      d,
    );
    expect(d.successes).toEqual([
      'Saved to memory.',
      'Saved to user profile.',
    ]);
  });
});
