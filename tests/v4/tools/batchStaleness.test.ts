/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 — batch-staleness guard (live-demo regression).
 *
 * Real-world evidence: a 199-op approved batch relocated files, then
 * later ops in the SAME batch referenced the old paths → 4 file_move
 * failures classified `hallucination`. The fix: mutating file ops whose
 * source no longer exists return a structured SKIP — benign, verifier-ok,
 * never a failure, never hallucination — recorded on the evidence
 * envelope as a decision, invisible to the footprint (nothing was
 * touched), and visible to the model so it doesn't retry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fileMoveTool } from '../../../tools/v4/files/fileMove';
import { fileDeleteTool } from '../../../tools/v4/files/fileDelete';
import { filePatchTool } from '../../../tools/v4/files/filePatch';
import type { ToolContext } from '../../../core/v4/toolRegistry';
import { defaultVerifier } from '../../../core/v4/verifier';
import { FailureClassifier } from '../../../core/v4/failureClassifier';
import { computeTaskFinalization } from '../../../core/v4/taskVerification';
import { renderTaskDetail } from '../../../cli/v4/commands/tasksDetail';
import type { Task } from '../../../core/v4/daemon/taskStore';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-stale-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

function ctx(): ToolContext {
  return { cwd: tmp, paths: {} as never };
}

describe('mutating file ops skip absent sources (structured, benign)', () => {
  it('file_move: absent source → skipped result, model-visible reason, nothing created', async () => {
    const from = path.join(tmp, 'gone.txt');
    const to   = path.join(tmp, 'sub', 'gone.txt');
    const r = await fileMoveTool.execute({ from, to }, ctx()) as Record<string, unknown>;
    expect(r).toMatchObject({
      success: true,
      skipped: true,
      reason:  'source_absent',
      likely:  'already handled by an earlier operation',
    });
    expect(existsSync(to)).toBe(false);              // never auto-redirects/creates
  });

  it('file_delete: absent path → skipped (the end state already holds)', async () => {
    const r = await fileDeleteTool.execute({ path: path.join(tmp, 'nope.txt') }, ctx()) as Record<string, unknown>;
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('source_absent');
    expect(r.success).toBe(true);
  });

  it('file_patch: absent path → skipped, not an error', async () => {
    const r = await filePatchTool.execute(
      { path: path.join(tmp, 'nope.txt'), find: 'a', replace: 'b' }, ctx(),
    ) as Record<string, unknown>;
    expect(r.skipped).toBe(true);
    expect(r.success).toBe(true);
  });

  it('present source still moves normally (guard is a no-op on the happy path)', async () => {
    const from = path.join(tmp, 'real.txt');
    const to   = path.join(tmp, 'dst', 'real.txt');
    await fs.writeFile(from, 'content');
    const r = await fileMoveTool.execute({ from, to }, ctx()) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(existsSync(to)).toBe(true);
  });
});

describe('DEMO REGRESSION: later batch op references a source an earlier op moved', () => {
  it('op N-3 relocates the file; op N SKIPS — verifier ok, NO classification, NO hallucination', async () => {
    const a = path.join(tmp, 'report.txt');
    await fs.writeFile(a, 'body');
    // Op 1 (earlier in the batch): moves report.txt into projectA/.
    const moved = path.join(tmp, 'projectA', 'report.txt');
    const r1 = await fileMoveTool.execute({ from: a, to: moved }, ctx()) as Record<string, unknown>;
    expect(r1.success).toBe(true);
    // Op N (stale plan): tries to move the ORIGINAL path again.
    const rN = await fileMoveTool.execute(
      { from: a, to: path.join(tmp, 'projectB', 'report.txt') }, ctx(),
    ) as Record<string, unknown>;
    expect(rN.skipped).toBe(true);

    // The verifier sees a typed ok envelope → no failure...
    const verification = defaultVerifier('file_move', { from: a }, {
      id: '1', name: 'file_move', result: rN,
    });
    expect(verification.ok).toBe(true);
    // ...so the classifier never runs → no hallucination possible.
    const classifier = new FailureClassifier();
    expect(classifier.classify(verification, 'file_move', { from: a }, {
      id: '1', name: 'file_move', result: rN,
    })).toBeNull();
    // The file stayed where op 1 put it.
    expect(existsSync(moved)).toBe(true);
  });

  it('the skip lands on the evidence envelope as a decision; footprint stays clean; turn completes', () => {
    const fin = computeTaskFinalization({
      finishReason: 'stop',
      toolCallTrace: [
        {
          name: 'file_move',
          result: { success: true, from: 'C:/dl/a.txt', to: 'C:/dl/projectA/a.txt' },
          handlerMutates: true,
          verification: { ok: true, confidence: 1, code: 'ok' },
        },
        {
          name: 'file_move',
          result: { success: true, skipped: true, reason: 'source_absent', likely: 'already handled by an earlier operation', from: 'C:/dl/a.txt', to: 'C:/dl/projectB/a.txt' },
          handlerMutates: true,
          verification: { ok: true, confidence: 1, code: 'ok' },
        },
      ] as never,
    });
    expect(fin.status).toBe('completed');
    // Skip is a decision-record on the envelope…
    expect(fin.evidence.skipped).toEqual([
      { tool: 'file_move', target: 'C:/dl/a.txt -> C:/dl/projectB/a.txt', reason: 'source_absent' },
    ]);
    // …and never pollutes the footprint (only the REAL move landed).
    expect(fin.jobCard.filesTouched).toEqual(['C:/dl/projectA/a.txt']);
    expect(fin.jobCard.sideEffects).toHaveLength(1);
  });

  it('/tasks detail renders the skip distinctly', () => {
    const task: Task = {
      id: 'task_skip01', title: 't', goal: 't', status: 'completed',
      createdAt: 1, updatedAt: 2, channelId: 'repl', sessionId: 's',
      parentTaskId: null, traceIds: [], artifactIds: [],
      constraints: null, filesTouched: [], sideEffects: [], failureState: null,
      permissions: null, resumeCount: 0,
      evidence: {
        v: 1, verdict: 'completed', decidedAt: 3, handles: [], failures: [],
        skipped: [{ tool: 'file_move', target: 'a -> b', reason: 'source_absent' }],
      },
    };
    const out: string[] = [];
    renderTaskDetail(task, (s) => out.push(s));
    const text = out.join('');
    expect(text).toMatch(/skipped \(1\):/);
    expect(text).toMatch(/↷ file_move → a -> b \(source_absent\)/);
  });
});
