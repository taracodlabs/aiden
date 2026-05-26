/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.9 — permission-grants-end-to-end contract eval.
 *
 * Cross-slice regression layer for Slice 10.6 + 10.6c (permission
 * system) plus its integration with Slice 10.2b's run_events
 * approval.decided emission.
 *
 * Pins the end-to-end shape:
 *   1. allow_session grants short-circuit subsequent matching calls
 *      WITHIN the same session.
 *   2. allow_always grants survive a resetSession() (permanent ⊂
 *      session).
 *   3. The Slice 10.6c per-path signature scope means a Session
 *      grant for `file_write test3.txt` does NOT cover
 *      `file_write test4.txt` — a UX regression class the prior
 *      smoke caught. Pin the state-machine intent so a future
 *      refactor that "fixes" this by collapsing scope to tool-only
 *      can't ship silently.
 *   4. The Slice 10.6c riskTier reassignment fires onDecision with
 *      the aux-LLM-decided tier, not the pre-classification fallback.
 *   5. Each decision routes through onDecision so the daemon path
 *      (Slice 10.2b) AND the REPL path (Slice 10.6 B1) emit
 *      approval.decided rows to run_events.
 */
import { describe, it, expect, vi } from 'vitest';

import { ApprovalEngine } from '../../../moat/approvalEngine';

function writeReq(over: Record<string, unknown> = {}): import('../../../moat/approvalEngine').ApprovalRequest {
  return {
    toolName: 'file_write',
    category: 'write',
    args:     { path: '/tmp/x' },
    ...(over as any),
  } as any;
}

describe('permission-grants-end-to-end — scope semantics (Slice 10.6 + 10.6c)', () => {
  it('allow_session short-circuits subsequent matching calls in the same session', async () => {
    const onDecision = vi.fn();
    const promptUser = vi.fn(async () => 'allow_session' as const);
    const engine = new ApprovalEngine('manual', { promptUser, onDecision });

    // First call — prompts the user, gets allow_session.
    await engine.checkApproval(writeReq({ args: { path: '/tmp/x' } }));
    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenLastCalledWith(expect.anything(), 'allow_session');

    // Second call same path — short-circuits, NO prompt fired.
    await engine.checkApproval(writeReq({ args: { path: '/tmp/x' } }));
    expect(promptUser).toHaveBeenCalledTimes(1);
    // onDecision fires again with the short-circuit verb.
    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it('Slice 10.6c per-path signature — Session grant for one path does NOT cover a different path', async () => {
    const promptUser = vi.fn(async () => 'allow_session' as const);
    const engine = new ApprovalEngine('manual', { promptUser });

    // Grant Session for test3.txt.
    await engine.checkApproval(writeReq({ args: { path: '/tmp/test3.txt' } }));
    expect(promptUser).toHaveBeenCalledTimes(1);

    // Different path — re-prompt expected. This is the state-machine
    // intent (defended in Slice 10.6c by the picker-label qualifier
    // "Session (this path)"). If a future refactor collapses the
    // scope to tool-only, this assertion fails and forces a
    // re-justification.
    await engine.checkApproval(writeReq({ args: { path: '/tmp/test4.txt' } }));
    expect(promptUser).toHaveBeenCalledTimes(2);
  });

  it('allow_always grants survive resetSession (permanent ⊂ session)', async () => {
    const promptUser = vi.fn(async () => 'deny' as const);
    const engine = new ApprovalEngine('manual', { promptUser });
    engine.allowAlways('file_write', 'file_write::/tmp/persistent');
    engine.resetSession();
    // After reset, sessionAllow is re-seeded from permanentAllow.
    // promptUser should NOT fire — permanent grant carries through.
    const ok = await engine.checkApproval(writeReq({ args: { path: '/tmp/persistent' } }));
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('Slice 10.6c riskTier reassignment — smart-mode safe-auto-allow fires onDecision with tier=safe', async () => {
    const onDecision = vi.fn();
    const riskAssess = vi.fn(async () => ({ tier: 'safe' as const, rationale: 'aux says safe' }));
    const engine = new ApprovalEngine('smart', { onDecision, riskAssess });
    await engine.checkApproval({
      toolName: 'mystery',
      category: 'execute',
      args:     { foo: 'bar' },
    });
    const [decidedReq, verb] = onDecision.mock.calls[0];
    expect(verb).toBe('allow');
    // Slice 10.6c fix: riskTier is the AUX-LLM-decided value,
    // not the pre-classification 'caution' default. Audit trail
    // shows the gate's actual reasoning.
    expect(decidedReq.riskTier).toBe('safe');
    expect(decidedReq.reason).toBe('aux says safe');
  });
});

describe('permission-grants-end-to-end — onDecision audit symmetry (Slice 10.6 B1)', () => {
  it('every decision verb fires onDecision exactly once with the correct verb', async () => {
    const cases: Array<{ verb: 'allow' | 'deny' | 'allow_session' | 'allow_always'; mode: 'manual' }> = [
      { verb: 'allow',         mode: 'manual' },
      { verb: 'deny',          mode: 'manual' },
      { verb: 'allow_session', mode: 'manual' },
      { verb: 'allow_always',  mode: 'manual' },
    ];
    for (const c of cases) {
      const onDecision = vi.fn();
      const promptUser = vi.fn(async () => c.verb);
      const engine = new ApprovalEngine(c.mode, { promptUser, onDecision });
      await engine.checkApproval(writeReq({ args: { path: `/tmp/${c.verb}` } }));
      expect(onDecision).toHaveBeenCalledOnce();
      expect(onDecision).toHaveBeenCalledWith(expect.any(Object), c.verb);
    }
  });

  it('off mode short-circuits + still fires onDecision with `allow`', async () => {
    const onDecision = vi.fn();
    const engine = new ApprovalEngine('off', { onDecision });
    const ok = await engine.checkApproval(writeReq({ args: { command: 'rm -rf /' } }));
    expect(ok).toBe(true);
    expect(onDecision).toHaveBeenCalledWith(expect.any(Object), 'allow');
  });
});
