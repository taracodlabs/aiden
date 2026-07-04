/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 UX polish (Bug 2) — the default trust level stops over-prompting on
 * safe, reversible actions, WITHOUT weakening any floor.
 *
 *   • Default level is Partner: workspace-internal writes/moves auto-allow.
 *   • FLOORS UNCHANGED: destructive / external-send / spend / out-of-scope
 *     still ASK; the hard-block set still DENIES — at every level.
 *   • Blanket grants (session/always) are recorded ONLY for safe classes; a
 *     destructive/external/spend call asks every single time.
 */
import { describe, it, expect, vi } from 'vitest';

import { ApprovalEngine, type ApprovalRequest } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy, isNeverBlanketAllow } from '../../../moat/autonomy';
import { resolveConfiguredAutonomyLevel } from '../../../core/v4/config';

const WS = '/work/space';
const cfg = (vals: Record<string, unknown>) => ({
  getValue: (<T,>(k: string, fb?: T): T => (k in vals ? (vals[k] as T) : (fb as T))),
});
function wreq(over: Partial<ApprovalRequest> & { toolName?: string } = {}): ApprovalRequest {
  return { toolName: 'file_write', category: 'write', args: { path: `${WS}/a.txt` }, ...over } as ApprovalRequest;
}
/** An engine at the DEFAULT level (Partner), workspace rooted at WS. */
function defaultEngine(promptUser = vi.fn().mockResolvedValue('deny')) {
  const level = resolveConfiguredAutonomyLevel(cfg({}));   // nothing configured → default
  const e = new ApprovalEngine('smart', { promptUser });
  e.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: [WS] }));
  return { e, promptUser };
}

// ── the default level ───────────────────────────────────────────────────────
describe('resolveConfiguredAutonomyLevel — the sane default', () => {
  it('nothing configured → Partner (auto-allows safe workspace writes)', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({}))).toBe('Partner');
  });
  it('explicit approval_mode: manual is respected → Assistant (cautious)', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'manual' }))).toBe('Assistant');
  });
  it('approval_mode smart / off → Partner', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'smart' }))).toBe('Partner');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'off' }))).toBe('Partner');
  });
  it('explicit agent.autonomy always wins', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Observer' }))).toBe('Observer');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Assistant', 'agent.approval_mode': 'smart' }))).toBe('Assistant');
  });
  it('a garbage agent.autonomy never RAISES — falls back to the default', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Superuser' }))).toBe('Partner');
  });
});

// ── safe classes auto-allow at the default level (no prompt) ─────────────────
describe('default level — safe/reversible classes auto-allow (zero prompt)', () => {
  it('a workspace-internal write (absolute path) auto-allows', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ args: { path: `${WS}/src/x.ts` } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
  it('a workspace-internal write with a RELATIVE path auto-allows', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ args: { path: 'notes/today.md' } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
  it('a move WITHIN the workspace auto-allows', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ toolName: 'file_move', args: { from: `${WS}/a.txt`, to: `${WS}/b.txt` } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
  it('reads always allow (category read short-circuits)', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ toolName: 'file_read', category: 'read', args: { path: '/anywhere/at/all' } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
});

// ── FLOORS unchanged — still ASK / DENY at the default level ─────────────────
describe('default level — floors STILL gate (unchanged)', () => {
  it('destructive (dangerous) still ASKS', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ toolName: 'file_delete', riskTier: 'dangerous' }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an out-of-workspace write still ASKS', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ args: { path: '/etc/hosts' } }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an ESCAPING relative path (../) resolves out-of-scope and ASKS', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ args: { path: '../../etc/passwd' } }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an external send still ASKS', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ toolName: 'send_message', category: 'network', args: {} }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an external SPEND still ASKS', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ toolName: 'api_call', effects: { externalSpend: true }, args: {} }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('the hard-block set is DENIED without a prompt (even if promptUser would allow)', async () => {
    const { e, promptUser } = defaultEngine(vi.fn().mockResolvedValue('allow'));
    expect(await e.checkApproval(wreq({ toolName: 'shell_exec', category: 'execute', args: { command: 'rm -rf /' } }))).toBe(false);
    expect(promptUser).not.toHaveBeenCalled();
  });
});

// ── session-allow: safe categories suppress re-prompt; floors never do ───────
describe('blanket session-allow — safe suppresses, destructive/external/spend never', () => {
  it('approving Session on a SAFE prompted write suppresses the re-prompt for the same category', async () => {
    // Use Assistant so a workspace write actually prompts (Partner auto-allows).
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] }));
    const req = wreq({ args: { path: `${WS}/report.txt` } });
    expect(await e.checkApproval(req)).toBe(true);   // 1st: prompted → session-allowed
    expect(await e.checkApproval(req)).toBe(true);   // 2nd: same signature → suppressed
    expect(promptUser).toHaveBeenCalledOnce();        // only ONE prompt for the whole category
  });

  it('a DESTRUCTIVE call asks EVERY time even when the user picks Session', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const del = wreq({ toolName: 'file_delete', riskTier: 'dangerous', args: { path: `${WS}/a.txt` } });
    expect(await e.checkApproval(del)).toBe(true);    // one-time allow (ran once)
    expect(await e.checkApproval(del)).toBe(true);
    expect(promptUser).toHaveBeenCalledTimes(2);      // NOT blanket — asked both times
  });

  it('an EXTERNAL send asks every time even when Session is picked', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const send = wreq({ toolName: 'send_message', category: 'network', args: { to: 'x' } });
    await e.checkApproval(send);
    await e.checkApproval(send);
    expect(promptUser).toHaveBeenCalledTimes(2);
  });

  it('even allow_always does NOT persist a blanket for a destructive call', async () => {
    const persistAllow = vi.fn();
    const promptUser = vi.fn().mockResolvedValue('allow_always');
    const e = new ApprovalEngine('smart', { promptUser, persistAllow });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const del = wreq({ toolName: 'file_delete', riskTier: 'dangerous', args: { path: `${WS}/a.txt` } });
    await e.checkApproval(del);
    expect(persistAllow).not.toHaveBeenCalled();       // never written to the permanent allowlist
  });
});

// ── the never-blanket predicate ──────────────────────────────────────────────
describe('isNeverBlanketAllow — the floor classifier', () => {
  it('true for destructive / irreversible / external-send / spend', () => {
    expect(isNeverBlanketAllow(wreq({ riskTier: 'dangerous' }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ effects: { irreversible: true } }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ toolName: 'send_message' }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ effects: { externalSpend: true } }))).toBe(true);
  });
  it('false for an ordinary safe write', () => {
    expect(isNeverBlanketAllow(wreq())).toBe(false);
  });
});
