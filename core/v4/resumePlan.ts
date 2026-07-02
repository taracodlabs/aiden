/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/resumePlan.ts — v4.13 Pillar 1, Gap 4.
 *
 * Resume starts with REVALIDATION, never continuation. The dead run's
 * transcript may contain false claims; the job-card and its evidence
 * handles are the truth. This module answers "is the world still what
 * the plan assumed?" BEFORE any re-drive — and is explicit about what
 * revalidation cannot check:
 *
 *   - files            → revalidatable (exists? size matches evidence?)
 *   - verified side effects → assumed done, NEVER re-fired
 *   - unverified mutations  → the dangerous class: UNKNOWN whether they
 *     landed; default policy asks the user, never silently re-executes
 *     (the same double-side-effect principle as Gap 2's mutating guard)
 *   - processes/servers the task started → honestly LOST (a dead
 *     process is gone); if the goal needs them they must be restarted
 *     as fresh verified steps
 *   - external reality (sent messages, remote writes, third-party
 *     state) → NOT CHECKABLE from here; the preamble says so
 *
 * Pure module (taskVerification.ts pattern): the caller injects a file
 * probe; no I/O happens in here beyond calling it.
 */

import type { Message } from '../../providers/v4/types';
import type { Task } from './daemon/taskStore';

// ── Types ───────────────────────────────────────────────────────────────

export interface RevalidationCheck {
  kind:   'file' | 'side_effect' | 'process' | 'protocol';
  target: string;
  status: 'confirmed' | 'missing' | 'changed' | 'unknown' | 'lost';
  detail?: string;
}

export type ResumeVerdict = 'resume' | 'ask_user' | 'abandon';

export interface ResumePlan {
  checks:  RevalidationCheck[];
  verdict: ResumeVerdict;
  reason:  string;
  /**
   * The system-level resume preamble for the fresh conversation: the
   * job-card summary + revalidation results. The model continues from
   * TRUTH, not from its dead prose.
   */
  preamble: string;
}

export interface FileProbeResult {
  exists: boolean;
  bytes?: number;
}

export interface BuildResumePlanOptions {
  /** Injected file prober (fs.statSync wrapper at the call site). */
  fileProbe:    (path: string) => FileProbeResult;
  /** Per-task wake-loop cap (default 2). */
  maxResumes?:  number;
  /** Trailing session messages when a durable tail exists (REPL-future). */
  sessionTail?: Message[];
}

// ── Protocol hygiene ────────────────────────────────────────────────────

/**
 * Synthesize honest interrupted-tool results for trailing orphan tool
 * calls (an assistant message whose tool_call ids have no matching tool
 * result — the provider-400 class). Pure; returns the patched copy and
 * how many results were synthesized. Used whenever a stored history is
 * ever replayed; the daemon re-drive itself uses a FRESH conversation,
 * so this is belt-and-braces there.
 */
export function synthesizeOrphanToolResults(
  messages: Message[],
): { messages: Message[]; synthesized: number } {
  const answered = new Set<string>();
  const requested: Array<{ id: string; index: number }> = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId);
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) requested.push({ id: c.id, index: i });
    }
  });
  const orphans = requested.filter((r) => !answered.has(r.id));
  if (orphans.length === 0) return { messages, synthesized: 0 };
  const out = [...messages];
  for (const o of orphans) {
    out.push({
      role:       'tool',
      toolCallId: o.id,
      content:    '[interrupted] the process died before this tool call completed; its outcome is unknown',
    });
  }
  return { messages: out, synthesized: orphans.length };
}

// ── The plan builder ────────────────────────────────────────────────────

export const DEFAULT_MAX_RESUMES = 2;

export function buildResumePlan(task: Task, opts: BuildResumePlanOptions): ResumePlan {
  const checks: RevalidationCheck[] = [];
  const maxResumes = opts.maxResumes ?? DEFAULT_MAX_RESUMES;

  // ── Wake-loop cap — checked first; an exhausted task never wakes ─────
  if (task.resumeCount >= maxResumes) {
    return {
      checks,
      verdict: 'abandon',
      reason:  `resume cap exhausted (${task.resumeCount}/${maxResumes} attempts spent)`,
      preamble: '',
    };
  }

  // ── Files: exists + size-vs-evidence ─────────────────────────────────
  const bytesByPath = new Map<string, number>();
  for (const h of task.evidence?.handles ?? []) {
    // Pair a bytes handle with the path handle of the same tool call by
    // simple adjacency: extractEvidenceHandles emits path then bytes.
    if (h.kind === 'bytes' && typeof h.value === 'number') {
      const prevPath = (task.evidence?.handles ?? [])
        .slice(0, (task.evidence?.handles ?? []).indexOf(h))
        .reverse()
        .find((p) => p.kind === 'path' && p.tool === h.tool);
      if (prevPath && typeof prevPath.value === 'string') {
        bytesByPath.set(prevPath.value, h.value);
      }
    }
  }
  for (const f of task.filesTouched) {
    let probe: FileProbeResult;
    try { probe = opts.fileProbe(f); }
    catch { probe = { exists: false }; }
    if (!probe.exists) {
      checks.push({ kind: 'file', target: f, status: 'missing', detail: 'file no longer exists — must be re-done as a fresh verified step' });
      continue;
    }
    const expected = bytesByPath.get(f);
    if (typeof expected === 'number' && typeof probe.bytes === 'number' && probe.bytes !== expected) {
      checks.push({ kind: 'file', target: f, status: 'changed', detail: `size ${probe.bytes} != evidence ${expected} — content drifted since the dead run` });
    } else {
      checks.push({ kind: 'file', target: f, status: 'confirmed' });
    }
  }

  // ── Side effects: verified assumed done; unverified are the danger ──
  // A verified file effect whose FILE check just failed defers to the
  // file check — "was verified then, but the file is gone/drifted now"
  // must read as redo, never as "do not redo" (no mixed signals).
  const brokenFiles = new Set(
    checks
      .filter((c) => c.kind === 'file' && (c.status === 'missing' || c.status === 'changed'))
      .map((c) => c.target),
  );
  let unknownMutations = 0;
  for (const e of task.sideEffects) {
    if (e.verified && brokenFiles.has(e.target)) {
      checks.push({ kind: 'side_effect', target: `${e.tool} → ${e.target}`, status: 'changed', detail: 'was verified at write time, but the file check failed — redo as a fresh verified step' });
    } else if (e.verified) {
      checks.push({ kind: 'side_effect', target: `${e.tool} → ${e.target}`, status: 'confirmed', detail: 'verified by evidence — will NOT be re-executed' });
    } else {
      unknownMutations += 1;
      checks.push({ kind: 'side_effect', target: `${e.tool} → ${e.target}`, status: 'unknown', detail: 'mutation without verification — may or may not have landed; never silently re-executed' });
    }
  }

  // ── Processes/servers: honestly LOST (no registry survives death) ───
  checks.push({
    kind:   'process',
    target: '(any processes/servers started by the dead run)',
    status: 'lost',
    detail: 'a dead process is gone; anything the goal needs must be restarted as a fresh verified step',
  });

  // ── Protocol hygiene on a stored tail, when one exists ──────────────
  if (opts.sessionTail && opts.sessionTail.length > 0) {
    const { synthesized } = synthesizeOrphanToolResults(opts.sessionTail);
    if (synthesized > 0) {
      checks.push({
        kind:   'protocol',
        target: 'session tail',
        status: 'unknown',
        detail: `${synthesized} orphan tool call(s) — honest interrupted results must be synthesized before any replay`,
      });
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────
  let verdict: ResumeVerdict = 'resume';
  let reason  = 'world revalidated; safe to re-drive from truth';
  if (unknownMutations > 0) {
    verdict = 'ask_user';
    reason  = `${unknownMutations} unverified mutation(s) from the dead run — unknown whether they landed; re-executing blind risks a double side effect. User must decide.`;
  }

  // ── Preamble: the truth the fresh conversation starts from ──────────
  const lines: string[] = [];
  lines.push('[resume] This task is being RESUMED after the previous run died. Do not trust any prior claims of completion — only the verified record below.');
  lines.push(`Original goal: ${task.goal}`);
  if (task.failureState) {
    const tried = task.failureState.whatWasTried.length > 0
      ? ` after ${task.failureState.whatWasTried.length} retry attempt(s)`
      : '';
    lines.push(`The previous attempt FAILED at: ${task.failureState.class}${task.failureState.reason ? ` — ${task.failureState.reason}` : ''}${tried}. Start by addressing that failure, not by repeating the old plan.`);
  }
  const confirmed = checks.filter((c) => c.status === 'confirmed');
  const missing   = checks.filter((c) => c.status === 'missing' || c.status === 'changed');
  const unknown   = checks.filter((c) => c.status === 'unknown');
  if (confirmed.length > 0) {
    lines.push(`CONFIRMED (do not redo): ${confirmed.map((c) => c.target).join('; ')}`);
  }
  if (missing.length > 0) {
    lines.push(`MISSING/CHANGED (redo as fresh verified steps): ${missing.map((c) => `${c.target} (${c.status})`).join('; ')}`);
  }
  if (unknown.length > 0) {
    lines.push(`UNKNOWN (never re-execute without confirmation): ${unknown.map((c) => c.target).join('; ')}`);
  }
  lines.push('LOST: any processes/servers the previous run started are gone — restart them if the goal needs them.');
  lines.push('NOT CHECKABLE: external reality (messages sent, remote/third-party writes) could not be revalidated — verify before repeating any external action.');

  return { checks, verdict, reason, preamble: lines.join('\n') };
}
