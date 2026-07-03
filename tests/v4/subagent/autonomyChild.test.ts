/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 2 — the subagent bridge (Pillar-3 unblock).
 *
 * A child inherits the parent's level MINUS the least-privilege tool classes,
 * auto-allows write-under-workspace (so it can PRODUCE a Pillar-3 evidence
 * handle), and ESCALATES destructive / external / out-of-scope to the parent
 * instead of a silent deny. This tests the child ENGINE wired exactly as
 * childBuilder wires it; the full spawn is proven in the dist smoke.
 */
import { describe, it, expect, vi } from 'vitest';
import { SUBAGENT_BLOCKED_TOOL_NAMES } from '../../../core/v4/subagent/childBuilder';
import { ApprovalEngine, type ApprovalRequest, type ApprovalCallbacks } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy } from '../../../moat/autonomy';

const WS = '/work/space';
function wreq(over: Partial<ApprovalRequest> & { toolName?: string } = {}): ApprovalRequest {
  return { toolName: 'file_write', category: 'write', args: { path: `${WS}/out.txt` }, ...over } as ApprovalRequest;
}

/** Build a child engine exactly as childBuilder does. */
function childEngine(level: 'Observer' | 'Assistant' | 'Partner', escalations: Array<{ tool: string }>) {
  const callbacks: ApprovalCallbacks = {
    promptUser: async (req) => { escalations.push({ tool: req.toolName }); return 'deny'; },
  };
  const e = new ApprovalEngine('smart', callbacks);
  e.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: [WS], isSubagent: true }));
  e.markSubagent();
  return e;
}

describe('subagent least-privilege blocklist', () => {
  it('strips user-contact, memory-write, background, delegation, external tools', () => {
    for (const name of ['spawn_sub_agent', 'clarify', 'send_message', 'memory', 'memory_add', 'memory_replace', 'memory_remove', 'execute_code', 'process_spawn', 'cronjob']) {
      expect(SUBAGENT_BLOCKED_TOOL_NAMES.has(name), name).toBe(true);
    }
  });
});

describe('subagent bridge — inherit level, escalate the rest', () => {
  it('Assistant child AUTO-ALLOWS an in-workspace write (no escalation) → can produce evidence', async () => {
    const escalations: Array<{ tool: string }> = [];
    const e = childEngine('Assistant', escalations);
    expect(await e.checkApproval(wreq({ args: { path: `${WS}/report.txt` } }))).toBe(true);
    expect(escalations).toHaveLength(0);
  });

  it('destructive op → ESCALATES to the parent (recorded, denied — never silent)', async () => {
    const escalations: Array<{ tool: string }> = [];
    const e = childEngine('Assistant', escalations);
    expect(await e.checkApproval(wreq({ toolName: 'file_delete', riskTier: 'dangerous', args: { path: `${WS}/x.txt` } }))).toBe(false);
    expect(escalations).toEqual([{ tool: 'file_delete' }]);
  });

  it('out-of-workspace write → escalates; external send → denied (stripped)', async () => {
    const escalations: Array<{ tool: string }> = [];
    const e = childEngine('Partner', escalations);
    // out-of-scope write escalates (ask → promptUser → record)
    expect(await e.checkApproval(wreq({ args: { path: '/etc/hosts' } }))).toBe(false);
    expect(escalations).toContainEqual({ tool: 'file_write' });
    // external send is stripped (deny) — no prompt, least-privilege
    escalations.length = 0;
    expect(await e.checkApproval(wreq({ toolName: 'send_message', category: 'network', args: {} }))).toBe(false);
    expect(escalations).toHaveLength(0);
  });

  it('Observer child stays read-only: denies all mutation, allows reads', async () => {
    const escalations: Array<{ tool: string }> = [];
    const e = childEngine('Observer', escalations);
    expect(await e.checkApproval(wreq())).toBe(false);
    expect(await e.checkApproval(wreq({ category: 'read', toolName: 'file_read' }))).toBe(true);
    expect(escalations).toHaveLength(0);   // denied outright, not escalated
  });
});
