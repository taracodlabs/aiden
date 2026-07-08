/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase 6 — honest refusals. A block must tell the user the REASON and the safe
 * way forward, not just "blocked":
 *   - protected paths: WHY it's off-limits + that it's a hard, non-waivable limit
 *   - approval denials: WHICH gate fired (hard-block / autonomy-floor / manual)
 *     + HOW to allow (/mode auto, approve when prompted, or "never allowed")
 */
import { describe, it, expect } from 'vitest';
import { protectedPathMessage } from '../../../tools/v4/utils/paths';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy } from '../../../moat/autonomy';

describe('protectedPathMessage — reason + non-waivable remedy', () => {
  it('names the path, WHY it is protected, and that the limit cannot be waived', () => {
    const m = protectedPathMessage('/home/u/.ssh/id_rsa');
    expect(m).toContain('/home/u/.ssh/id_rsa');
    expect(m.toLowerCase()).toMatch(/credential|ssh|\.env|key/);          // the reason
    expect(m.toLowerCase()).toMatch(/can'?t be waived|hard safety|yourself/); // the honest remedy
  });
});

describe('ApprovalEngine.explainDenial — which gate + how to allow', () => {
  it('hard-block: never allowed at any level', () => {
    const engine = new ApprovalEngine('smart');
    const msg = engine.explainDenial({
      toolName: 'shell_exec', category: 'shell',
      args: { command: 'rm -rf /' }, riskTier: 'dangerous',
    });
    expect(msg.toLowerCase()).toMatch(/never allowed|safety floor/);
  });

  it('autonomy-floor: names the mode and how to raise it', () => {
    const engine = new ApprovalEngine('smart');
    // Observer denies every mutating call (decideAutonomy → 'deny').
    engine.setAutonomyPolicy(
      resolveAutonomyPolicy('Observer', { workspaceRoots: [process.cwd()] }),
      { userInitiated: true },
    );
    const msg = engine.explainDenial({
      toolName: 'file_write', category: 'write',
      args: { path: 'notes.txt' }, riskTier: 'caution',
    });
    expect(msg).toContain('Observer');
    expect(msg).toContain('/mode auto');
  });

  it('manual-deny: approve when prompted, or /mode auto to stop being asked', () => {
    const engine = new ApprovalEngine('smart');
    const msg = engine.explainDenial({
      toolName: 'file_write', category: 'write',
      args: { path: 'notes.txt' }, riskTier: 'caution',
    });
    expect(msg.toLowerCase()).toMatch(/prompt|approve/);
    expect(msg).toContain('/mode auto');
  });
});
