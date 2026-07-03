/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 2 — the autonomy dial: policy resolution + the generalised
 * tier-gate + the non-bypassable floors (pure, no engine).
 */
import { describe, it, expect } from 'vitest';
import type { ApprovalRequest } from '../../../moat/approvalEngine';
import {
  resolveAutonomyPolicy,
  decideAutonomy,
  matchesHardBlock,
  isPolicyFilePath,
  levelRank,
  AUTONOMY_LEVELS,
} from '../../../moat/autonomy';

const WS = '/work/space';
function req(over: Partial<ApprovalRequest> & { toolName?: string } = {}): ApprovalRequest {
  return {
    toolName: 'file_write',
    category: 'write',
    args: {},
    ...over,
  } as ApprovalRequest;
}

// ── Policy objects ───────────────────────────────────────────────────────────

describe('resolveAutonomyPolicy — a level expands into an explicit policy', () => {
  it('Observer: never writes, never shell, never external', () => {
    const p = resolveAutonomyPolicy('Observer', { workspaceRoots: [WS] });
    expect(p).toMatchObject({ level: 'Observer', allowWrite: 'never', allowShell: 'never', allowExternalMessages: 'never' });
    expect(p.hardBlock.length).toBeGreaterThan(0);
  });
  it('Assistant (parent): asks to write, asks for shell/external', () => {
    const p = resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] });
    expect(p).toMatchObject({ allowWrite: 'ask', allowShell: 'ask', allowExternalMessages: 'ask' });
  });
  it('Partner (parent): auto-writes in workspace, asks for shell/external', () => {
    const p = resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] });
    expect(p).toMatchObject({ allowWrite: 'workspace', allowShell: 'ask', allowExternalMessages: 'ask' });
    expect(p.workspaceRoots).toEqual([WS]);
  });
  it('subagent: auto-writes in workspace at Assistant+, external stripped (never)', () => {
    const child = resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS], isSubagent: true });
    expect(child.allowWrite).toBe('workspace');            // can act (can't ask)
    expect(child.allowExternalMessages).toBe('never');     // least-privilege
    const observerChild = resolveAutonomyPolicy('Observer', { workspaceRoots: [WS], isSubagent: true });
    expect(observerChild.allowWrite).toBe('never');        // read-only stays read-only
  });
  it('levels are ordered Observer < Assistant < Partner', () => {
    expect(AUTONOMY_LEVELS).toEqual(['Observer', 'Assistant', 'Partner']);
    expect(levelRank('Observer')).toBeLessThan(levelRank('Assistant'));
    expect(levelRank('Assistant')).toBeLessThan(levelRank('Partner'));
  });
});

// ── The tier-gate ────────────────────────────────────────────────────────────

describe('decideAutonomy — the generalised tier-gate', () => {
  const observer  = resolveAutonomyPolicy('Observer',  { workspaceRoots: [WS] });
  const assistant = resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] });
  const partner   = resolveAutonomyPolicy('Partner',   { workspaceRoots: [WS] });

  it('Observer denies ALL mutation', () => {
    expect(decideAutonomy(observer, req({ args: { path: `${WS}/a.txt` } }))).toBe('deny');
    expect(decideAutonomy(observer, req({ toolName: 'shell_exec', category: 'execute', args: { command: 'ls' } }))).toBe('deny');
    // reads still allowed
    expect(decideAutonomy(observer, req({ category: 'read', toolName: 'file_read' }))).toBe('allow');
  });

  it('Assistant asks at the write boundary', () => {
    expect(decideAutonomy(assistant, req({ args: { path: `${WS}/a.txt` } }))).toBe('ask');
  });

  it('Partner auto-allows write UNDER workspace, asks OUTSIDE it', () => {
    expect(decideAutonomy(partner, req({ args: { path: `${WS}/sub/a.txt` } }))).toBe('allow');
    expect(decideAutonomy(partner, req({ args: { path: '/etc/passwd' } }))).toBe('ask');       // out of scope
    expect(decideAutonomy(partner, req({ args: {} }))).toBe('ask');                            // no path → ask
  });

  it('destructive ALWAYS asks, even at Partner', () => {
    expect(decideAutonomy(partner, req({ riskTier: 'dangerous', args: { path: `${WS}/a.txt` } }))).toBe('ask');
    expect(decideAutonomy(partner, req({ toolName: 'file_delete', effects: { irreversible: true }, args: { path: `${WS}/a.txt` } }))).toBe('ask');
  });

  it('external-send ALWAYS asks at Partner; is stripped (deny) for a subagent', () => {
    expect(decideAutonomy(partner, req({ toolName: 'send_message', category: 'network', args: {} }))).toBe('ask');
    const child = resolveAutonomyPolicy('Partner', { workspaceRoots: [WS], isSubagent: true });
    expect(decideAutonomy(child, req({ toolName: 'send_message', category: 'network', args: {} }))).toBe('deny');
  });

  it('shell/arbitrary code always asks (never auto, even Partner)', () => {
    expect(decideAutonomy(partner, req({ toolName: 'shell_exec', category: 'execute', args: { command: 'ls' } }))).toBe('ask');
  });

  it('a subagent at Assistant auto-allows an in-workspace write (Pillar-3 unblock)', () => {
    const child = resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS], isSubagent: true });
    expect(decideAutonomy(child, req({ args: { path: `${WS}/out.txt` } }))).toBe('allow');
    expect(decideAutonomy(child, req({ riskTier: 'dangerous', args: { path: `${WS}/out.txt` } }))).toBe('ask'); // destructive → escalate
  });
});

// ── Hard-block floor (non-bypassable) + policy-file protection ───────────────

describe('matchesHardBlock — catastrophic + policy-file floor', () => {
  const cmd = (c: string) => req({ toolName: 'shell_exec', category: 'execute', args: { command: c } });

  it('blocks catastrophic no-recovery commands', () => {
    for (const c of ['rm -rf /', 'rm -rf ~', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now', 'reboot', 'kill -9 -1', ':(){ :|:& };:']) {
      expect(matchesHardBlock(cmd(c)).blocked, c).toBe(true);
    }
  });
  it('does NOT block ordinary commands', () => {
    for (const c of ['ls -la', 'git status', 'npm test', 'echo hello', 'rm ./tmp/one-file.txt']) {
      expect(matchesHardBlock(cmd(c)).blocked, c).toBe(false);
    }
  });
  it('blocks rewriting the autonomy policy file via shell back-door', () => {
    expect(matchesHardBlock(cmd('echo "agent: {autonomy: Partner}" > ~/.config/aiden/config.yaml')).blocked).toBe(true);
    expect(matchesHardBlock(cmd('sed -i s/Observer/Partner/ /home/u/aiden/config.yaml')).blocked).toBe(true);
    expect(matchesHardBlock(cmd('cat foo | tee /x/aiden/config.yml')).blocked).toBe(true);
  });
  it('blocks a file-tool write to the policy file', () => {
    expect(matchesHardBlock(req({ toolName: 'file_write', args: { path: 'C:/Users/x/AppData/Local/aiden/config.yaml' } })).blocked).toBe(true);
    expect(isPolicyFilePath('/home/u/.config/aiden/config.yaml')).toBe(true);
    expect(isPolicyFilePath('/home/u/project/config.yaml')).toBe(false);  // not under aiden
  });
});
