/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Phase D — end-to-end mini Downloads demo IN TEST.
 *
 * Real ToolRegistry executor, real ApprovalEngine ('manual' — the
 * strictest mode), real files in a scratch dir: list+hash → dedupe
 * grouping (the "model's job", done inline here) → plan_approval batch
 * → PARTIAL user approval → approved ops execute through the normal
 * gated dispatch WITHOUT re-prompting (promptUser must never fire for
 * them) → a declined op attempted anyway still hits the engine (prompt
 * → deny) → report written → job-card finalization shows filesTouched,
 * the declined decision, and the evidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ToolRegistry, type ToolContext } from '../../../core/v4/toolRegistry';
import { fileListTool } from '../../../tools/v4/files/fileList';
import { fileMoveTool } from '../../../tools/v4/files/fileMove';
import { fileDeleteTool } from '../../../tools/v4/files/fileDelete';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { planApprovalTool } from '../../../tools/v4/approval/planApproval';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { computeTaskFinalization } from '../../../core/v4/taskVerification';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

let downloads: string;
let inbox: string;

beforeEach(async () => {
  // realpath the scratch dir so the paths the test constructs match what the
  // tools record. The file tools canonicalise via realpath (sandboxFs
  // realpathWithFallback), which resolves the macOS /var → /private/var symlink
  // and expands the Windows 8.3 short name (os.tmpdir() = C:\Users\RUNNER~1\…)
  // to its long form. Without this, `filesTouched` (realpath'd) never equals the
  // raw os.tmpdir()-based paths on macOS / Windows CI runners.
  downloads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-dl-demo-')));
  inbox = path.join(downloads, '_vault-inbox');
  // ~10 files: 2 content-duplicates, 1 fake screenshot, project files, junk.
  await fs.writeFile(path.join(downloads, 'report-final.txt'), 'project alpha report v2');
  await fs.writeFile(path.join(downloads, 'report-final-copy.txt'), 'project alpha report v2');   // dupe
  await fs.writeFile(path.join(downloads, 'notes.txt'), 'unrelated notes');
  await fs.writeFile(path.join(downloads, 'Screenshot 2026-07-01 101010.png'), 'PNGDATA');
  await fs.writeFile(path.join(downloads, 'invoice.txt'), 'invoice #42');
  await fs.writeFile(path.join(downloads, 'installer-junk.tmp'), 'x'.repeat(100));
});

afterEach(async () => {
  await fs.rm(downloads, { recursive: true, force: true }).catch(() => undefined);
});

it('mini demo: list+hash → batch → partial approve → gated execute → report → job-card', async () => {
  // ── Wiring: real registry + strictest engine. promptUser is armed to
  // FAIL LOUDLY if any approved op re-prompts (the demo-killer class),
  // and to DENY anything else (the declined-op attempt below).
  const promptUser = vi.fn(async () => 'deny' as const);
  const engine = new ApprovalEngine('manual', { promptUser } as never);
  const clarify = vi.fn(async () =>
    // Approve the dupe delete (1), the screenshot move (2), and the
    // report write (4); DECLINE the junk delete (3).
    '1,2,4');
  const registry = new ToolRegistry();
  for (const t of [fileListTool, fileMoveTool, fileDeleteTool, fileWriteTool, planApprovalTool]) {
    registry.register(t);
  }
  const context: ToolContext = {
    cwd: downloads,
    paths: {} as never,
    approvalEngine: engine,
    clarify,
  };
  const exec = registry.buildExecutor(context);
  const trace: HonestyTraceEntry[] = [];
  let callId = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    callId += 1;
    const r = await exec({ id: String(callId), name, arguments: args });
    const result = (r.result ?? {}) as Record<string, unknown>;
    trace.push({
      name,
      result,
      error: r.error,
      handlerMutates: name === 'file_delete' || name === 'file_move' || name === 'file_write',
      verification: r.error
        ? { ok: false, confidence: 1, code: 'failed', reason: r.error }
        : { ok: true, confidence: 1, code: 'ok' },
    } as HonestyTraceEntry);
    return r.error ? { success: false, error: r.error } : result;
  }

  // ── 1: PREVIEW — list with content hashes; group dupes (model's job).
  const listing = await call('file_list', { path: downloads, hash: true }) as {
    entries: Array<{ name: string; sha256?: string; type: string }>;
  };
  const byHash = new Map<string, string[]>();
  for (const e of listing.entries) {
    if (e.type !== 'file' || !e.sha256) continue;
    byHash.set(e.sha256, [...(byHash.get(e.sha256) ?? []), e.name]);
  }
  const dupes = [...byHash.values()].filter((names) => names.length > 1);
  expect(dupes).toHaveLength(1);
  expect(dupes[0].sort()).toEqual(['report-final-copy.txt', 'report-final.txt']);
  const dupeToDelete = dupes[0][1];   // keep the first, delete the other
  const screenshot = listing.entries.find((e) => /screenshot/i.test(e.name))!.name;

  // ── 2: APPROVE — one batch, one user decision.
  const dupePath = path.join(downloads, dupeToDelete);
  const shotFrom = path.join(downloads, screenshot);
  const shotTo   = path.join(inbox, screenshot);
  const junkPath = path.join(downloads, 'installer-junk.tmp');
  const reportPath = path.join(downloads, 'cleanup-report.md');
  const reportContent = `# Downloads cleanup\n- deleted duplicate: ${dupeToDelete}\n- moved screenshot to inbox\n- junk delete DECLINED by user\n`;
  const batch = await call('plan_approval', {
    title: 'Clean Downloads',
    operations: [
      { tool: 'file_delete', args: { path: dupePath }, reason: 'duplicate content (same sha256)' },
      { tool: 'file_move',   args: { from: shotFrom, to: shotTo }, reason: 'screenshot to vault inbox' },
      { tool: 'file_delete', args: { path: junkPath }, reason: 'installer junk' },
      { tool: 'file_write',  args: { path: reportPath, content: reportContent }, reason: 'cleanup report' },
    ],
  });
  expect(batch.approvedCount).toBe(3);
  expect(batch.declinedCount).toBe(1);
  // NOTHING destructive has executed yet — filesystem untouched.
  expect(existsSync(dupePath)).toBe(true);
  expect(existsSync(shotFrom)).toBe(true);
  expect(existsSync(junkPath)).toBe(true);

  // ── 3: EXECUTE — approved ops pass the gate with ZERO prompts.
  const del = await call('file_delete', { path: dupePath });
  const mov = await call('file_move', { from: shotFrom, to: shotTo });
  expect(del.success).toBe(true);
  expect(mov.success).toBe(true);
  expect(promptUser).not.toHaveBeenCalled();      // the demo-killer assertion
  expect(existsSync(dupePath)).toBe(false);
  expect(existsSync(shotTo)).toBe(true);

  // A DECLINED op attempted anyway still hits the engine → deny.
  const sneaky = await call('file_delete', { path: junkPath });
  expect(sneaky.success).toBe(false);
  expect(String(sneaky.error)).toMatch(/denied by approval engine/);
  expect(promptUser).toHaveBeenCalledTimes(1);
  expect(existsSync(junkPath)).toBe(true);        // still there

  // ── 4: AUDIT — report artifact (pre-approved in the batch) + card.
  const rep = await call('file_write', { path: reportPath, content: reportContent });
  expect(rep.success).toBe(true);
  expect(existsSync(reportPath)).toBe(true);
  expect(promptUser).toHaveBeenCalledTimes(1);    // ONLY the sneaky declined attempt ever prompted

  const fin = computeTaskFinalization({ finishReason: 'stop', toolCallTrace: trace }, { approvalMode: 'manual' });
  expect(fin.jobCard.filesTouched).toContain(dupePath);
  expect(fin.jobCard.filesTouched).toContain(shotTo);
  expect(fin.evidence.declined).toEqual([
    { tool: 'file_delete', target: junkPath, reason: 'installer junk' },
  ]);
}, 30_000);
