import { describe, it, expect } from 'vitest';
import {
  HonestyEnforcement,
  type HonestyTraceEntry,
} from '../../../moat/honestyEnforcement';

/**
 * v4.7.0 Phase 2.5 — behavioural tests for the outcome-based verifier.
 *
 * The deleted regex-scanner tests are gone; these assert the new
 * surface:
 *   - mutating tool errors produce `mutation_errored` events
 *   - memory_* with verified=false produce `memory_unverified` events
 *   - read-only tool errors are IGNORED (not the verifier's concern)
 *   - "model claimed X with no tool fired" is NO LONGER a finding
 *     (that was the false-refusal class — eliminated by design)
 *   - originalResponse is never rewritten in any mode
 *   - mode gates: off bypasses; detect captures without footer;
 *     enforce captures + renders footer
 */

function makeTrace(entries: Partial<HonestyTraceEntry>[]): HonestyTraceEntry[] {
  return entries.map((e) => ({
    name:           e.name ?? 'unknown',
    result:         e.result ?? null,
    verified:       e.verified,
    error:          e.error,
    handlerMutates: e.handlerMutates ?? false,
    verification:   e.verification,
  }));
}

describe('HonestyEnforcement — mode gates', () => {
  it('1. off mode: bypasses entirely regardless of trace contents', async () => {
    const h = new HonestyEnforcement('off');
    const res = await h.check(
      'I claimed something',
      [],
      makeTrace([
        { name: 'file_write', error: 'EACCES', handlerMutates: true },
      ]),
    );
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.footer).toBeUndefined();
  });

  it('2. detect mode: captures events but never renders footer', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check(
      'I saved the file',
      [],
      makeTrace([
        { name: 'file_write', error: 'EACCES', handlerMutates: true },
      ]),
    );
    expect(res.passed).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].reason).toBe('tool_errored');
    expect(res.footer).toBeUndefined();
  });

  it('3. enforce mode: captures events AND renders footer', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file',
      [],
      makeTrace([
        { name: 'file_write', error: 'EACCES', handlerMutates: true },
      ]),
    );
    expect(res.passed).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.footer).toBeDefined();
    expect(res.footer).toContain('Verifier');
    expect(res.footer).toContain('file_write');
    expect(res.footer).toContain('errored');
    expect(res.footer).toContain('EACCES');
  });
});

describe('HonestyEnforcement — mutation_errored events', () => {
  it('4. mutating tool errored → finding recorded', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_write', error: 'disk full', handlerMutates: true },
    ]));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].reason).toBe('tool_errored');
    expect(res.findings[0].claim).toBe('file_write');
  });

  it('5. mutating tool succeeded → no finding', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_write', result: { ok: true, path: 'x.txt' }, handlerMutates: true },
    ]));
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('6. read-only tool errored → NOT a finding (verifier ignores)', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_list', error: 'ENOENT', handlerMutates: false },
    ]));
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('7. footer includes extracted path when result carries one', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('x', [], makeTrace([
      {
        name:           'file_write',
        result:         { path: '/tmp/denied.txt' },
        error:          'EACCES',
        handlerMutates: true,
      },
    ]));
    expect(res.footer).toContain('/tmp/denied.txt');
  });

  it('8. footer omits path when result has no path field', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('x', [], makeTrace([
      { name: 'shell_exec', result: null, error: 'killed', handlerMutates: true },
    ]));
    expect(res.footer).toContain('shell_exec');
    expect(res.footer).not.toContain('(path:');
  });
});

describe('HonestyEnforcement — memory_unverified events', () => {
  it('9. memory_add verified=false → finding recorded', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('I remembered', [], makeTrace([
      { name: 'memory_add', verified: false, handlerMutates: true },
    ]));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].reason).toBe('memory_verified_false');
    expect(res.findings[0].claim).toBe('memory_add');
  });

  it('10. memory_replace verified=false → finding recorded', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'memory_replace', verified: false, handlerMutates: true },
    ]));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].reason).toBe('memory_verified_false');
  });

  it('11. memory_add verified=true → no finding', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'memory_add', verified: true, handlerMutates: true },
    ]));
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('12. memory_add verified undefined → no finding (silent on missing flag)', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'memory_add', handlerMutates: true },
    ]));
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('13. non-memory tool with verified=false → no memory finding', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_write', verified: false, handlerMutates: true },
    ]));
    // verified=false on non-memory tools isn't the memory failure mode
    expect(res.findings).toHaveLength(0);
  });
});

describe('HonestyEnforcement — multi-event + edge cases', () => {
  it('14. multiple failures: footer aggregates all', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_write', error: 'disk full', handlerMutates: true },
      { name: 'memory_add', verified: false, handlerMutates: true },
    ]));
    expect(res.findings).toHaveLength(2);
    expect(res.footer).toContain('2 tool outcome(s)');
    expect(res.footer).toContain('file_write');
    expect(res.footer).toContain('memory_add');
  });

  it('15. clean trace → no findings, no footer', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('x', [], makeTrace([
      { name: 'file_write', result: { path: 'x' }, handlerMutates: true },
      { name: 'file_list',  result: { entries: [] }, handlerMutates: false },
    ]));
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.footer).toBeUndefined();
  });

  it('16. empty trace → no findings (no "no_tool_call" false-refusal)', async () => {
    // This is the key behavior shift: the OLD verifier flagged
    // "model claimed X with no tool" as a finding. The NEW one
    // records OUTCOMES only — silence on missing tools.
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('I saved the file', [], []);
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.footer).toBeUndefined();
  });

  it('17. originalResponse is never rewritten', async () => {
    const h = new HonestyEnforcement('enforce');
    const original = 'I saved your file.';
    const res = await h.check(original, [], makeTrace([
      { name: 'file_write', error: 'fail', handlerMutates: true },
    ]));
    expect(res.originalResponse).toBe(original);
    // The new result shape has `footer`, not `correctedResponse`.
    expect((res as { correctedResponse?: unknown }).correctedResponse).toBeUndefined();
  });

  it('18. handlerMutates undefined on legacy trace entry → treated as false', async () => {
    // Trace entries built before v4.7 Phase 2.3 won't carry the
    // handlerMutates field. The verifier MUST treat undefined as
    // "not a mutating tool" so legacy traces don't produce
    // spurious findings.
    const h = new HonestyEnforcement('enforce');
    const legacyTrace: HonestyTraceEntry[] = [
      {
        name:   'file_write',
        result: null,
        error:  'EACCES',
        // handlerMutates: undefined (not set)
      },
    ];
    const res = await h.check('x', [], legacyTrace);
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('19. setMode + getMode round-trip', async () => {
    const h = new HonestyEnforcement('enforce');
    expect(h.getMode()).toBe('enforce');
    h.setMode('off');
    expect(h.getMode()).toBe('off');
    h.setMode('detect');
    expect(h.getMode()).toBe('detect');
  });

  it('20. logger invoked when findings exist', async () => {
    let logSeen = false;
    const h = new HonestyEnforcement('detect', undefined, (lvl, msg) => {
      if (lvl === 'info' && msg.includes('unverified outcome')) logSeen = true;
    });
    await h.check('x', [], makeTrace([
      { name: 'file_write', error: 'fail', handlerMutates: true },
    ]));
    expect(logSeen).toBe(true);
  });

  it('21. recordOutcomes is a pure function (callable without check)', async () => {
    const h = new HonestyEnforcement('enforce');
    const events = h.recordOutcomes(makeTrace([
      { name: 'memory_add', verified: false, handlerMutates: true },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('memory_unverified');
  });

  it('22. buildFooter renders standalone (for telemetry / external callers)', () => {
    const h = new HonestyEnforcement('enforce');
    const footer = h.buildFooter([
      { kind: 'mutation_errored', tool: 'file_write', reason: 'disk full', path: 'x.txt' },
    ]);
    expect(footer).toContain('Verifier');
    expect(footer).toContain('file_write');
    expect(footer).toContain('x.txt');
    expect(footer).toContain('disk full');
  });
});

describe('HonestyEnforcement — claim_contradicted (v4.11 Slice 2)', () => {
  const failedShell = (): Partial<HonestyTraceEntry> => ({
    name: 'shell_exec',
    result: { success: false },
    verification: { ok: false, confidence: 1, code: 'failed', reason: 'non-zero exit (1)' },
  });

  it('ui_test_result{failed:0} + shell_exec failed → contradiction', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('Tests pass.', [], makeTrace([failedShell()]), [
      { name: 'ui_test_result', args: { framework: 'vitest', passed: 12, failed: 0 } },
    ]);
    expect(res.passed).toBe(false);
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(true);
    expect(res.footer).toMatch(/contradicts evidence/);
    expect(res.footer).toMatch(/shell_exec failed/);
  });

  it('ui_task_done{status:"success"} + shell_exec failed → contradiction', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('Done.', [], makeTrace([failedShell()]), [
      { name: 'ui_task_done', args: { task_id: 't1', status: 'success' } },
    ]);
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(true);
  });

  it('ui_test_result{failed:0} + shell_exec OK → no contradiction', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('Tests pass.', [], makeTrace([
      { name: 'shell_exec', result: { success: true },
        verification: { ok: true, confidence: 1, code: 'ok' } },
    ]), [
      { name: 'ui_test_result', args: { framework: 'vitest', passed: 12, failed: 0 } },
    ]);
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(false);
  });

  it('ui_test_result{failed:2} (not a success claim) + shell_exec failed → no contradiction', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('2 failing.', [], makeTrace([failedShell()]), [
      { name: 'ui_test_result', args: { framework: 'vitest', passed: 10, failed: 2 } },
    ]);
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(false);
  });

  it('FP guard: success claim + a NON-shell tool failure → no contradiction (scoped to shell_exec)', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('Tests pass.', [], makeTrace([
      { name: 'web_fetch', result: { success: false },
        verification: { ok: false, confidence: 1, code: 'failed', reason: 'soft-block' } },
    ]), [
      { name: 'ui_test_result', args: { framework: 'vitest', passed: 12, failed: 0 } },
    ]);
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(false);
  });

  it('no ui claims → no contradiction (back-compat: uiClaims defaults to [])', async () => {
    const h = new HonestyEnforcement('detect');
    const res = await h.check('hi', [], makeTrace([failedShell()]));
    expect(res.findings.some((f) => f.reason === 'claim_contradicted')).toBe(false);
  });
});
