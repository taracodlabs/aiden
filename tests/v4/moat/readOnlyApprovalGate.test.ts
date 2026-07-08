/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.6 Bug 3 — the approval-gate bypass for read-only shell commands.
 *
 * Proves the REAL gate in ToolRegistry: a verified read-only shell_exec skips
 * the approval engine entirely (no prompt, command runs), while a write/delete
 * still enters the gate. `onDecision` fires only when checkApproval evaluates a
 * request, so its absence = the gate was skipped.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type ToolHandler, type ToolContext } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';

let ran = 0;
const stubShell: ToolHandler = {
  schema: {
    name: 'shell_exec',
    description: 'x',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
  category: 'execute', mutates: true, toolset: 'terminal', riskTier: 'dangerous',
  async execute() { ran++; return { success: true }; },
};
const baseCtx = (): ToolContext => ({ cwd: process.cwd(), paths: { authJson: '/tmp/x' } as never } as ToolContext);

function harness() {
  const decisions: string[] = [];
  const engine = new ApprovalEngine('smart', {
    riskAssess: async () => ({ tier: 'safe', rationale: 'untouched' }),
    onDecision: (req) => { decisions.push(req.toolName); },
  });
  const registry = new ToolRegistry();
  registry.register(stubShell);
  const exec = registry.buildExecutor({ ...baseCtx(), approvalEngine: engine });
  return { exec, decisions };
}

describe('approval gate — read-only shell runs WITHOUT a prompt', () => {
  for (const command of ['rg needle src/', 'ls -la', 'cat package.json', "rg 'foo|bar' .", 'grep -rn foo .']) {
    it(`skips the gate: ${command}`, async () => {
      const { exec, decisions } = harness();
      ran = 0;
      const r = await exec({ id: '1', name: 'shell_exec', arguments: { command } });
      expect(decisions).toEqual([]);        // approval engine never consulted
      expect(ran).toBe(1);                  // the command actually executed
      expect(r.error).toBeUndefined();
    });
  }
});

describe('approval gate — writes/deletes STILL enter the gate', () => {
  for (const command of ['rm -rf build', 'mv a b', 'cat x > out.txt', 'ls && rm y', 'python danger.py']) {
    it(`enters the gate: ${command}`, async () => {
      const { exec, decisions } = harness();
      ran = 0;
      await exec({ id: '2', name: 'shell_exec', arguments: { command } });
      expect(decisions).toContain('shell_exec');   // approval engine evaluated it (prompt path)
    });
  }
});
