/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Pillar 1 Gap 4 — ResumePlan (pure revalidation policy).
 *
 * Resume starts with revalidation, never continuation: these tests pin
 * the checks derived from the job-card, the never-silently-re-execute
 * policy for unverified mutations, the failure-entry-point preamble,
 * the wake-loop cap, orphan-tool-call synthesis, and the lost-process
 * honesty line.
 */
import { describe, it, expect } from 'vitest';

import {
  buildResumePlan,
  synthesizeOrphanToolResults,
  DEFAULT_MAX_RESUMES,
} from '../../core/v4/resumePlan';
import type { Task } from '../../core/v4/daemon/taskStore';
import type { Message } from '../../providers/v4/types';

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_res01', title: 'write the report', goal: 'write the report to out.txt',
    status: 'interrupted', createdAt: 1, updatedAt: 2,
    channelId: 'daemon', sessionId: 's', parentTaskId: null,
    traceIds: [], artifactIds: [],
    evidence: null, constraints: null, filesTouched: [], sideEffects: [],
    failureState: null, permissions: null, resumeCount: 0,
    ...over,
  };
}

const probeAll = (bytes = 10) => (_p: string) => ({ exists: true, bytes });
const probeNone = (_p: string) => ({ exists: false });

describe('buildResumePlan — revalidation checks', () => {
  it('clean world: files confirmed, verified effects assumed done, verdict resume, honest preamble', () => {
    const plan = buildResumePlan(mkTask({
      filesTouched: ['C:/out/a.txt'],
      sideEffects:  [{ tool: 'file_write', target: 'C:/out/a.txt', verified: true, evidence: 'bytes=10' }],
      evidence: {
        v: 1, verdict: 'failed', decidedAt: 3,
        handles: [
          { tool: 'file_write', kind: 'path', value: 'C:/out/a.txt', verified: true, code: 'ok' },
          { tool: 'file_write', kind: 'bytes', value: 10, verified: true, code: 'ok' },
        ],
        failures: [],
      },
    }), { fileProbe: probeAll(10) });

    expect(plan.verdict).toBe('resume');
    expect(plan.checks.find((c) => c.kind === 'file')!.status).toBe('confirmed');
    const effect = plan.checks.find((c) => c.kind === 'side_effect')!;
    expect(effect.status).toBe('confirmed');
    expect(effect.detail).toMatch(/will NOT be re-executed/);
    // The preamble states the truth-not-prose rule + the honesty lines.
    expect(plan.preamble).toMatch(/Do not trust any prior claims/);
    expect(plan.preamble).toMatch(/CONFIRMED \(do not redo\)/);
    expect(plan.preamble).toMatch(/LOST: any processes\/servers/);
    expect(plan.preamble).toMatch(/NOT CHECKABLE: external reality/);
    expect(plan.preamble).toMatch(/Original goal: write the report to out\.txt/);
  });

  it('missing file → check missing, still resume (our own verified file is safe to re-do), preamble lists it', () => {
    const plan = buildResumePlan(mkTask({ filesTouched: ['C:/out/a.txt'] }), { fileProbe: probeNone });
    expect(plan.verdict).toBe('resume');
    const f = plan.checks.find((c) => c.kind === 'file')!;
    expect(f.status).toBe('missing');
    expect(plan.preamble).toMatch(/MISSING\/CHANGED \(redo as fresh verified steps\)/);
  });

  it('changed file (size drifted from the evidence handle) → status changed', () => {
    const plan = buildResumePlan(mkTask({
      filesTouched: ['C:/out/a.txt'],
      evidence: {
        v: 1, verdict: 'failed', decidedAt: 3,
        handles: [
          { tool: 'file_write', kind: 'path', value: 'C:/out/a.txt', verified: true, code: 'ok' },
          { tool: 'file_write', kind: 'bytes', value: 10, verified: true, code: 'ok' },
        ],
        failures: [],
      },
    }), { fileProbe: probeAll(999) });
    expect(plan.checks.find((c) => c.kind === 'file')!.status).toBe('changed');
  });

  it('UNVERIFIED mutation → ask_user, never silently re-execute (the dangerous class)', () => {
    const plan = buildResumePlan(mkTask({
      sideEffects: [{ tool: 'shell_exec', target: 'deploy.sh', verified: false }],
    }), { fileProbe: probeAll() });
    expect(plan.verdict).toBe('ask_user');
    expect(plan.reason).toMatch(/unknown whether they landed/);
    expect(plan.reason).toMatch(/double side effect/);
    const e = plan.checks.find((c) => c.kind === 'side_effect')!;
    expect(e.status).toBe('unknown');
    expect(plan.preamble).toMatch(/UNKNOWN \(never re-execute without confirmation\)/);
  });

  it('NO MIXED SIGNALS: a verified file effect whose file is now missing defers to the file check (redo, never "do not redo")', () => {
    const plan = buildResumePlan(mkTask({
      filesTouched: ['C:/out/a.txt'],
      sideEffects:  [{ tool: 'file_write', target: 'C:/out/a.txt', verified: true, evidence: 'bytes=10' }],
    }), { fileProbe: probeNone });
    expect(plan.verdict).toBe('resume');   // our own verified file — safe to redo
    const effect = plan.checks.find((c) => c.kind === 'side_effect')!;
    expect(effect.status).toBe('changed');
    expect(effect.detail).toMatch(/redo as a fresh verified step/);
    // The preamble must NOT list it under CONFIRMED.
    const confirmedLine = plan.preamble.split('\n').find((l) => l.startsWith('CONFIRMED'));
    expect(confirmedLine ?? '').not.toMatch(/a\.txt/);
    expect(plan.preamble).toMatch(/MISSING\/CHANGED[^\n]*a\.txt/);
  });

  it('failureState → resume enters at the failure, not the old plan', () => {
    const plan = buildResumePlan(mkTask({
      failureState: {
        class: 'network', reason: 'network unreachable',
        whatWasTried: [{ attempt: 1, category: 'network', backoffMs: 400 }],
        whenAt: 5,
      },
    }), { fileProbe: probeAll() });
    expect(plan.verdict).toBe('resume');
    expect(plan.preamble).toMatch(/previous attempt FAILED at: network — network unreachable after 1 retry attempt/);
    expect(plan.preamble).toMatch(/Start by addressing that failure/);
  });

  it('wake-loop cap: resumeCount >= max → abandon, no checks run', () => {
    const plan = buildResumePlan(mkTask({ resumeCount: DEFAULT_MAX_RESUMES }), { fileProbe: probeAll() });
    expect(plan.verdict).toBe('abandon');
    expect(plan.reason).toMatch(/resume cap exhausted \(2\/2/);
  });

  it('lost-process honesty: every plan carries the LOST process check', () => {
    const plan = buildResumePlan(mkTask(), { fileProbe: probeAll() });
    const p = plan.checks.find((c) => c.kind === 'process')!;
    expect(p.status).toBe('lost');
    expect(p.detail).toMatch(/dead process is gone/);
  });
});

describe('synthesizeOrphanToolResults — protocol hygiene', () => {
  it('appends honest interrupted results for trailing orphan tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, toolCalls: [
        { id: 'c1', name: 'file_write', arguments: {} },
        { id: 'c2', name: 'shell_exec', arguments: {} },
      ] } as never,
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      // c2 has NO result — the process died mid-call.
    ];
    const { messages: out, synthesized } = synthesizeOrphanToolResults(messages);
    expect(synthesized).toBe(1);
    const last = out[out.length - 1];
    expect(last.role).toBe('tool');
    expect((last as { toolCallId?: string }).toolCallId).toBe('c2');
    expect(String(last.content)).toMatch(/\[interrupted\]/);
    expect(String(last.content)).toMatch(/outcome is unknown/);
  });

  it('no orphans → untouched input, zero synthesized', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const r = synthesizeOrphanToolResults(messages);
    expect(r.synthesized).toBe(0);
    expect(r.messages).toBe(messages);
  });

  it('a plan over a tail with orphans records the protocol check', () => {
    const tail: Message[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 't', arguments: {} }] } as never,
    ];
    const plan = buildResumePlan(mkTask(), { fileProbe: probeAll(), sessionTail: tail });
    const proto = plan.checks.find((c) => c.kind === 'protocol')!;
    expect(proto.detail).toMatch(/1 orphan tool call/);
  });
});
