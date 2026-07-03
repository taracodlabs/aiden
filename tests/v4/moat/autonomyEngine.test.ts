/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 2 — the dial wired into the ApprovalEngine: level behaviour
 * through checkApproval, the SH.1 userInitiated/tighten-only guard, and the
 * floors holding at every level (incl. Partner).
 */
import { describe, it, expect, vi } from 'vitest';
import { ApprovalEngine, type ApprovalRequest } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy } from '../../../moat/autonomy';

const WS = '/work/space';
function wreq(over: Partial<ApprovalRequest> & { toolName?: string } = {}): ApprovalRequest {
  return { toolName: 'file_write', category: 'write', args: { path: `${WS}/a.txt` }, ...over } as ApprovalRequest;
}

describe('ApprovalEngine — autonomy dial behaviour', () => {
  it('Observer denies all mutation (promptUser never consulted)', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Observer', { workspaceRoots: [WS] }));
    expect(await e.checkApproval(wreq())).toBe(false);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('Assistant asks at the write boundary (promptUser decides)', async () => {
    const promptUser = vi.fn().mockResolvedValue('deny');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] }));
    expect(await e.checkApproval(wreq())).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('Partner auto-allows an in-workspace write WITHOUT prompting', async () => {
    const promptUser = vi.fn().mockResolvedValue('deny');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    expect(await e.checkApproval(wreq({ args: { path: `${WS}/deep/a.txt` } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('Partner still ASKS for destructive / external / out-of-scope', async () => {
    const promptUser = vi.fn().mockResolvedValue('deny');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    // destructive
    expect(await e.checkApproval(wreq({ riskTier: 'dangerous' }))).toBe(false);
    // out-of-scope write
    expect(await e.checkApproval(wreq({ args: { path: '/etc/hosts' } }))).toBe(false);
    // external send
    expect(await e.checkApproval(wreq({ toolName: 'send_message', category: 'network', args: {} }))).toBe(false);
    expect(promptUser).toHaveBeenCalledTimes(3);   // each asked, each denied
  });

  it('hard-block + destructive floors hold at EVERY level, incl. Partner + off', async () => {
    for (const level of ['Observer', 'Assistant', 'Partner'] as const) {
      const e = new ApprovalEngine('smart', { promptUser: vi.fn().mockResolvedValue('allow') });
      e.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: [WS] }));
      // Catastrophic hard-block is denied regardless of level (even if promptUser would allow).
      expect(await e.checkApproval(wreq({ toolName: 'shell_exec', category: 'execute', args: { command: 'rm -rf /' } }))).toBe(false);
    }
  });
});

describe('ApprovalEngine — setAutonomyPolicy SH.1 guard (userInitiated + tighten-only)', () => {
  it('after freeze, in-process code can TIGHTEN (lower) but NEVER raise', async () => {
    const e = new ApprovalEngine('smart', { promptUser: vi.fn().mockResolvedValue('deny') });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] }));  // boot default
    e.freeze();
    // In-process raise to Partner → rejected (returns false, policy unchanged).
    const raised = e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    expect(raised).toBe(false);
    expect(e.getAutonomyPolicy()?.level).toBe('Assistant');
    // In-process tighten to Observer → allowed (never raises risk).
    const tightened = e.setAutonomyPolicy(resolveAutonomyPolicy('Observer', { workspaceRoots: [WS] }));
    expect(tightened).toBe(true);
    expect(e.getAutonomyPolicy()?.level).toBe('Observer');
  });

  it('a userInitiated raise (the /autonomy command) is honoured after freeze', async () => {
    const e = new ApprovalEngine('smart', { promptUser: vi.fn().mockResolvedValue('deny') });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Observer', { workspaceRoots: [WS] }));
    e.freeze();
    const ok = e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }), { userInitiated: true });
    expect(ok).toBe(true);
    expect(e.getAutonomyPolicy()?.level).toBe('Partner');
  });
});
