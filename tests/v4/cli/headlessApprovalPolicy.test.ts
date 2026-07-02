/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 — headless one-shot (`aiden -q`) approval policy.
 *
 * The safety-switch contract the -q path depends on, proven through the
 * REAL file tools + REAL ToolRegistry executor + REAL ApprovalEngine wired
 * exactly as `buildAgentRuntime({ headless: true })` wires it (mode
 * 'manual' + a synchronous auto-DENY promptUser).
 *
 * Policy under test (the honest verdict from the -q auto-deny investigation):
 *   • READ-category tools (file_list, mutates:false) run — never gated. This
 *     is by design: `aiden -q "list files"` legitimately returns results.
 *   • MUTATING tools (file_write / file_delete, mutates:true) are DENIED —
 *     the executor routes them to checkApproval → promptUser → 'deny'. The
 *     denial surfaces as a tool `error`, and the filesystem is UNCHANGED.
 *
 * Also pins the two latent holes the fix closed by forcing 'manual':
 *   • a user config `approval_mode: 'off'` must NOT leak into -q (we assert
 *     'manual', constructed independently of config, denies mutations);
 *   • 'manual' takes the deterministic promptUser path — no auxiliary-LLM
 *     riskAssess is consulted (so a mutating call can't be rated 'safe' and
 *     auto-allowed, and there is no network hop in the headless path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ToolRegistry, type ToolContext } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { fileListTool, fileWriteTool, fileDeleteTool } from '../../../tools/v4/index';

let tmp: string;

/** The engine exactly as `buildAgentRuntime({ headless: true })` builds it:
 *  mode 'manual', promptUser auto-denies, UI events silenced. `riskAssess`
 *  is a throwing spy — 'manual' must NEVER consult it. */
function headlessEngine(riskAssess = vi.fn(async () => { throw new Error('riskAssess must not run under manual'); })) {
  return new ApprovalEngine('manual', {
    promptUser: async () => 'deny',
    onUiEvent: () => {},
    riskAssess,
  });
}

function ctx(engine: ApprovalEngine): ToolContext {
  return { cwd: tmp, paths: { authJson: path.join(tmp, 'auth.json') } as never, approvalEngine: engine } as ToolContext;
}

function exec(engine: ApprovalEngine) {
  const registry = new ToolRegistry();
  registry.register(fileListTool);
  registry.register(fileWriteTool);
  registry.register(fileDeleteTool);
  return registry.buildExecutor(ctx(engine));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-headless-approval-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('headless -q approval policy — read tools run', () => {
  it('file_list (read, mutates:false) is allowed — never gated', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hi', 'utf8');
    const run = exec(headlessEngine());
    const r = await run({ id: '1', name: 'file_list', arguments: { path: tmp } });
    expect(r.error).toBeFalsy();
    const names = (r.result as { entries?: Array<{ name: string }> }).entries?.map((e) => e.name) ?? [];
    expect(names).toContain('a.txt');
  });
});

describe('headless -q approval policy — mutating tools are denied, disk untouched', () => {
  it('file_write is DENIED and no file is created', async () => {
    const target = path.join(tmp, 'should-not-exist.txt');
    const run = exec(headlessEngine());
    const r = await run({ id: '1', name: 'file_write', arguments: { path: target, content: 'nope' } });
    expect(r.error).toBeTruthy();
    expect(String(r.error)).toMatch(/denied|approval/i);
    expect(existsSync(target)).toBe(false);   // nothing changed
  });

  it('file_delete is DENIED and the target file survives intact', async () => {
    const victim = path.join(tmp, 'keep.txt');
    await fs.writeFile(victim, 'precious', 'utf8');
    const run = exec(headlessEngine());
    const r = await run({ id: '1', name: 'file_delete', arguments: { path: victim } });
    expect(r.error).toBeTruthy();
    expect(String(r.error)).toMatch(/denied|approval/i);
    expect(existsSync(victim)).toBe(true);
    expect(await fs.readFile(victim, 'utf8')).toBe('precious');
  });

  it('manual mode takes the deterministic promptUser path — riskAssess is never consulted', async () => {
    const riskAssess = vi.fn(async () => ({ tier: 'safe' as const, rationale: 'x' }));
    const run = exec(headlessEngine(riskAssess));
    const r = await run({ id: '1', name: 'file_write', arguments: { path: path.join(tmp, 'x.txt'), content: 'y' } });
    expect(r.error).toBeTruthy();               // denied regardless
    expect(riskAssess).not.toHaveBeenCalled();  // no auxiliary-LLM hop
  });
});
