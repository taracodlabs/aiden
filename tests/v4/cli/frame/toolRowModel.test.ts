/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 1 — tool-row state machine (id-keyed, parallel,
 * active→trail→transcript, survives silent long calls + interrupts).
 */
import { describe, it, expect } from 'vitest';
import { ToolRowModel } from '../../../../cli/v4/frame/toolRowModel';

describe('ToolRowModel', () => {
  it('rows are keyed by tool-call id — parallel calls are DISTINCT rows', () => {
    const m = new ToolRowModel();
    m.start('a', 'file_read', 0);
    m.start('b', 'web_search', 0);
    expect(m.activeCount()).toBe(2);
    m.complete('a', 'ok', 100);
    expect(m.activeCount()).toBe(1);          // only 'a' completed
    expect(m.activeIds()).toEqual(['b']);     // 'b' still running
  });

  it('an active row renders a LIVE elapsed timer even while the model is silent', () => {
    const m = new ToolRowModel();
    m.start('a', 'shell_exec', 1_000);
    expect(m.renderActive(4_000)).toEqual(['⟳ shell_exec · 3s']);   // 3s elapsed, no completion yet
    expect(m.renderActive(9_000)).toEqual(['⟳ shell_exec · 8s']);   // keeps ticking
  });

  it('complete moves a row to the trail with its outcome + duration', () => {
    const m = new ToolRowModel();
    m.start('a', 'file_write', 0);
    m.complete('a', 'ok', 250);
    expect(m.hasActive()).toBe(false);
    expect(m.renderTrail()).toEqual(['✓ file_write · 250ms']);
  });

  it('finalizeTranscript assembles ALL rows BEFORE clearing (nothing vanishes)', () => {
    const m = new ToolRowModel();
    m.start('a', 'file_read', 0);
    m.complete('a', 'ok', 50);
    m.start('b', 'file_write', 0);
    m.complete('b', 'fail', 80, 'disk full');
    const transcript = m.finalizeTranscript(100);
    expect(transcript).toEqual(['✓ file_read · 50ms', '✗ file_write disk full · 80ms']);
    // Live + trail state is cleared after assembly.
    expect(m.hasActive()).toBe(false);
    expect(m.renderTrail()).toEqual([]);
  });

  it('INTERRUPT: a still-active row at turn end is recorded (never lost)', () => {
    const m = new ToolRowModel();
    m.start('a', 'file_read', 0);
    m.complete('a', 'ok', 40);
    m.start('b', 'shell_exec', 0);          // still running when the turn ends
    // Default: straggler = 'interrupted'.
    const t1 = new ToolRowModel();
    t1.start('x', 'shell_exec', 0);
    expect(t1.finalizeTranscript(500)).toEqual(['⊘ shell_exec · 500ms']);
    // User esc → straggler labelled 'cancelled'.
    const transcript = m.finalizeTranscript(500, { interrupted: true });
    expect(transcript).toContain('✓ file_read · 40ms');
    expect(transcript.some((l) => l.includes('shell_exec'))).toBe(true);   // the running row is still there
  });
});
