/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/tasksDetail.ts — v4.13 Gap 3.
 *
 * `/tasks <task_id>` detail renderer: the operator's view of the full
 * job-card — what the task was (goal/constraints/permissions), what it
 * actually DID (files touched, side effects), how it was verified
 * (evidence envelope), and how it failed if it did (failure state with
 * the retry ledger). Pure text-building against a write sink so the
 * renderer is unit-testable outside the REPL closure; null/absent
 * fields render cleanly (a line is omitted or marked, never `undefined`).
 */
import type { Task } from '../../../core/v4/daemon/taskStore';

export function renderTaskDetail(t: Task, write: (s: string) => void): void {
  write(`Task ${t.id} [${t.status}]\n`);
  write(`  title:   ${t.title}\n`);
  if (t.goal !== t.title) write(`  goal:    ${t.goal}\n`);
  write(`  created: ${new Date(t.createdAt).toISOString()}\n`);
  write(`  updated: ${new Date(t.updatedAt).toISOString()}\n`);

  if (t.resumeCount > 0) {
    write(`  resume attempts: ${t.resumeCount}\n`);
  }
  if (t.constraints && Object.keys(t.constraints).length > 0) {
    write(`  constraints: ${JSON.stringify(t.constraints)}\n`);
  }
  if (t.permissions && Object.keys(t.permissions).length > 0) {
    write(`  permissions: ${JSON.stringify(t.permissions)}\n`);
  }

  if (t.filesTouched.length > 0) {
    write(`  files touched (${t.filesTouched.length}):\n`);
    for (const f of t.filesTouched) write(`    ${f}\n`);
  }
  if (t.sideEffects.length > 0) {
    write(`  side effects (${t.sideEffects.length}):\n`);
    for (const e of t.sideEffects) {
      write(`    ${e.verified ? '✓' : '·'} ${e.tool} → ${e.target}${e.evidence ? ` (${e.evidence})` : ''}\n`);
    }
  }
  if (t.artifactIds.length > 0) {
    write(`  artifacts: ${t.artifactIds.join(', ')}\n`);
  }

  if (t.failureState) {
    write(`  failure state: ${t.failureState.class}${t.failureState.reason ? ` — ${t.failureState.reason}` : ''}\n`);
    if (t.failureState.whatWasTried.length > 0) {
      write(`    what was tried:\n`);
      for (const a of t.failureState.whatWasTried) {
        write(`      attempt ${a.attempt}: ${a.category}${a.reason ? ` (${a.reason})` : ''}, backoff ${a.backoffMs}ms\n`);
      }
    }
    write(`    at: ${new Date(t.failureState.whenAt).toISOString()}\n`);
  }

  if (t.evidence) {
    write(`  verification: ${t.evidence.verdict} (decided ${new Date(t.evidence.decidedAt).toISOString()})\n`);
    if (t.evidence.reportedFailure) {
      write(`    reported by model: ${t.evidence.reportedFailure}\n`);
    }
    if (t.evidence.declined && t.evidence.declined.length > 0) {
      write(`    declined by user (${t.evidence.declined.length}):\n`);
      for (const d of t.evidence.declined) {
        write(`      ⊘ ${d.tool} → ${d.target}${d.reason ? ` (${d.reason})` : ''}\n`);
      }
    }
    if (t.evidence.skipped && t.evidence.skipped.length > 0) {
      write(`    skipped (${t.evidence.skipped.length}):\n`);
      for (const s of t.evidence.skipped) {
        write(`      ↷ ${s.tool} → ${s.target}${s.reason ? ` (${s.reason})` : ''}\n`);
      }
    }
    for (const f of t.evidence.failures) {
      write(`    ✗ ${f.tool}: ${f.reason}\n`);
    }
    for (const h of t.evidence.handles) {
      write(`    ${h.verified ? '✓' : '·'} ${h.tool} ${h.kind}=${String(h.value)}${h.code && h.code !== 'ok' ? ` (${h.code})` : ''}\n`);
    }
  } else {
    write(`  (no verification evidence recorded)\n`);
  }
}
