/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Phase D — plan_approval (batch preview/approve primitive) +
 * file_list hash option.
 *
 * The primitive presents and records; the approval ENGINE decides at
 * dispatch. These tests pin: nothing executes pre-approval, partial
 * approval registers exactly the approved signatures, declined entries
 * are decisions (recorded on the evidence envelope, not failures), and
 * the hash option gives content identity with a size guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { planApprovalTool, parseApprovalSelection } from '../../../tools/v4/approval/planApproval';
import { fileListTool } from '../../../tools/v4/files/fileList';
import { ToolRegistry, type ToolContext } from '../../../core/v4/toolRegistry';
import { argSignature } from '../../../moat/approvalEngine';
import { computeTaskFinalization } from '../../../core/v4/taskVerification';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-plan-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: tmp, paths: {} as never, ...over };
}

function mkEngine() {
  return {
    allowForSession: vi.fn(),
    getMode:         () => 'manual',
  };
}

const OPS = [
  { tool: 'file_delete', args: { path: 'C:/dl/dup1.txt' }, reason: 'duplicate of a.txt' },
  { tool: 'file_delete', args: { path: 'C:/dl/dup2.txt' }, reason: 'duplicate of b.txt' },
  { tool: 'file_move',   args: { from: 'C:/dl/shot.png', to: 'C:/vault/inbox/shot.png' }, reason: 'screenshot to inbox' },
];

describe('parseApprovalSelection', () => {
  it('all/none/y/n forms', () => {
    expect(parseApprovalSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseApprovalSelection('y', 3)).toEqual([0, 1, 2]);
    expect(parseApprovalSelection('none', 3)).toEqual([]);
    expect(parseApprovalSelection('n', 3)).toEqual([]);
    expect(parseApprovalSelection('', 3)).toEqual([]);
  });
  it('numbers + ranges, deduped and sorted', () => {
    expect(parseApprovalSelection('1,3', 3)).toEqual([0, 2]);
    expect(parseApprovalSelection('1-2, 2', 3)).toEqual([0, 1]);
  });
  it('invalid forms are rejected, never guessed', () => {
    expect(parseApprovalSelection('4', 3)).toBe('invalid');
    expect(parseApprovalSelection('0', 3)).toBe('invalid');
    expect(parseApprovalSelection('banana', 3)).toBe('invalid');
    expect(parseApprovalSelection('2-1', 3)).toBe('invalid');
  });
});

describe('plan_approval — present + record, never execute', () => {
  it('NOTHING EXECUTES pre-approval: the tool only presents (clarify) and registers grants', async () => {
    const engine = mkEngine();
    const clarify = vi.fn(async () => 'none');
    // Real file in scratch — must be untouched by the tool regardless
    // of the answer.
    const real = path.join(tmp, 'victim.txt');
    await fs.writeFile(real, 'still here');
    const r = await planApprovalTool.execute({
      title: 'Delete stuff',
      operations: [{ tool: 'file_delete', args: { path: real }, reason: 'junk' }],
    }, ctx({ clarify, approvalEngine: engine as never })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(await fs.readFile(real, 'utf8')).toBe('still here');   // untouched
    expect(engine.allowForSession).not.toHaveBeenCalled();        // none approved
    expect(r.declinedCount).toBe(1);
  });

  it('partial approval: exactly the approved signatures are session-granted; declined echoed as decisions', async () => {
    const engine = mkEngine();
    const clarify = vi.fn(async () => '1,3');
    const r = await planApprovalTool.execute(
      { title: 'Clean Downloads', operations: OPS },
      ctx({ clarify, approvalEngine: engine as never }),
    ) as Record<string, unknown>;

    expect(r.approvedCount).toBe(2);
    expect(r.declinedCount).toBe(1);
    expect(engine.allowForSession).toHaveBeenCalledTimes(2);
    expect(engine.allowForSession).toHaveBeenCalledWith('file_delete', argSignature('file_delete', OPS[0].args));
    expect(engine.allowForSession).toHaveBeenCalledWith('file_move',   argSignature('file_move',   OPS[2].args));
    const declined = r.declined as Array<{ tool: string }>;
    expect(declined[0].tool).toBe('file_delete');
    expect(String(r.instruction)).toMatch(/ONLY the approved/);
    // Trust-dial seam: the record carries mode + decider.
    expect(r.mode).toBe('manual');
    expect(r.decidedVia).toBe('user');
  });

  it('unparseable answer → one retry → still unparseable counts as NONE (never guess approval)', async () => {
    const engine = mkEngine();
    const clarify = vi.fn(async () => 'whatever');
    const r = await planApprovalTool.execute(
      { title: 't', operations: OPS },
      ctx({ clarify, approvalEngine: engine as never }),
    ) as Record<string, unknown>;
    expect(clarify).toHaveBeenCalledTimes(2);
    expect(r.approvedCount).toBe(0);
    expect(engine.allowForSession).not.toHaveBeenCalled();
  });

  it('no clarify surface (daemon-shaped context) → honest unavailable, zero grants', async () => {
    const engine = mkEngine();
    const r = await planApprovalTool.execute(
      { title: 't', operations: OPS },
      ctx({ approvalEngine: engine as never }),
    ) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.status).toBe('unavailable');
    expect(engine.allowForSession).not.toHaveBeenCalled();
  });

  it('is REPL-only — excluded from the daemon catalog', () => {
    const reg = new ToolRegistry();
    reg.register(planApprovalTool);
    expect(reg.getSchemas(undefined, 'repl').map((s) => s.name)).toContain('plan_approval');
    expect(reg.getSchemas(undefined, 'daemon').map((s) => s.name)).not.toContain('plan_approval');
  });

  it('declined ops land on the evidence envelope as decisions (not failures)', () => {
    const fin = computeTaskFinalization({
      finishReason: 'stop',
      toolCallTrace: [{
        name: 'plan_approval',
        result: {
          success: true,
          approved: [],
          declined: [{ tool: 'file_delete', args: { path: 'C:/dl/dup1.txt' }, reason: 'user kept it' }],
        },
        handlerMutates: false,
        verification: { ok: true, confidence: 1, code: 'ok' },
      } as never],
    });
    expect(fin.status).toBe('completed');                    // a decline is not a failure
    expect(fin.evidence.declined).toEqual([
      { tool: 'file_delete', target: 'C:/dl/dup1.txt', reason: 'user kept it' },
    ]);
    expect(fin.evidence.failures).toEqual([]);
  });
});

describe('file_list — stat + hash (content identity for dedupe)', () => {
  it('identical content → identical sha256; different content differs; size included', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'same content here');
    await fs.writeFile(path.join(tmp, 'b.txt'), 'same content here');
    await fs.writeFile(path.join(tmp, 'c.txt'), 'different content');
    const r = await fileListTool.execute({ path: tmp, hash: true }, ctx()) as {
      success: boolean; entries: Array<{ name: string; sha256?: string; size?: number }>;
    };
    expect(r.success).toBe(true);
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    expect(byName.get('a.txt')!.sha256).toBe(byName.get('b.txt')!.sha256);
    expect(byName.get('c.txt')!.sha256).not.toBe(byName.get('a.txt')!.sha256);
    expect(byName.get('a.txt')!.size).toBe(17);
  });

  it('large-file guard: entries over the cap get hashSkipped instead of a hash', async () => {
    // 51 MB sparse-ish buffer — allocation is fast; write is the cost.
    await fs.writeFile(path.join(tmp, 'huge.bin'), Buffer.alloc(51 * 1024 * 1024));
    await fs.writeFile(path.join(tmp, 'small.txt'), 'ok');
    const r = await fileListTool.execute({ path: tmp, hash: true }, ctx()) as {
      entries: Array<{ name: string; sha256?: string; hashSkipped?: boolean }>;
    };
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    expect(byName.get('huge.bin')!.hashSkipped).toBe(true);
    expect(byName.get('huge.bin')!.sha256).toBeUndefined();
    expect(byName.get('small.txt')!.sha256).toBeDefined();
  }, 30_000);

  it('stat/hash omitted → byte-identical legacy shape (no size fields)', async () => {
    await fs.writeFile(path.join(tmp, 'x.txt'), 'hi');
    const r = await fileListTool.execute({ path: tmp }, ctx()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(r.entries[0]).toEqual({ name: 'x.txt', type: 'file' });
  });
});
