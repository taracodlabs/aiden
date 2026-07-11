/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/executionContract.ts — the shared command-execution state model.
 *
 * P1A first slice: TYPES + a pure record BUILDER, plus a turn-local shadow
 * COLLECTOR the dispatch seam populates. This is NON-AUTHORITATIVE — no
 * production path consumes the records yet. The verifier (P1B) and the dock
 * (P2C) will both read this one model in later slices so they can never drift
 * and lie differently.
 *
 * Design corrections baked in from the audit review:
 *   - THREE INDEPENDENT AXES, never collapsed into one enum:
 *       ApprovalState  — what the approval layer decided.
 *       ExecutionState — what happened when (if) the tool ran.
 *       VerificationState — whether the claimed effect verified.
 *     `denied` and `interrupted` are separated from execution `error` from day
 *     one, and a non-zero exit is separated from a genuine crash — even though
 *     the live path still collapses them into one `error` string.
 *   - ActivityPhase is a SMALLER derived value that drives RENDERING ONLY. It
 *     is derived from the three axes and never replaces them.
 *   - CommandId is Aiden-owned + branded, minted fresh at proposal. The
 *     provider's tool_call id is stored SEPARATELY (`providerCallId`), never
 *     reused as the key.
 */

import { randomUUID } from 'node:crypto';
import type { VerificationResult } from './verifier';

// ── Identity ────────────────────────────────────────────────────────────────

/** Aiden-owned, branded command id. Never a provider id. */
export type CommandId = string & { readonly __brand: 'CommandId' };

/** Mint a fresh CommandId at proposal time. */
export function mintCommandId(): CommandId {
  return `cmd_${randomUUID()}` as CommandId;
}

// ── Resources a command touched ─────────────────────────────────────────────
//
// A stable resource id links commands ↔ evidence ↔ claims (P1B). URI-shaped so
// the scheme carries the kind: file:// object:// net://. A command may touch
// SEVERAL resources (a move is from+to), so this is always a list. Exit codes
// are execution evidence, NOT resources — they never appear here.

/** URI-shaped stable resource id, e.g. `file:///abs/path`, `object://<id>`. */
export type ResourceId = string;

export interface ResourceRef {
  resource: ResourceId;
  interaction: 'wrote' | 'read' | 'deleted' | 'moved_from' | 'moved_to' | 'created' | 'sent';
}

function fileUri(p: string): ResourceId {
  return `file://${p}`;
}
function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}

/**
 * The resources a command PROVABLY touched, from its structured result only.
 * Never guesses: a `shell_exec` whose result is opaque (or exit-code-only)
 * returns `[]`. Callers must not infer resources from a shell command string.
 */
export function extractResources(result: unknown): ResourceRef[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const refs: ResourceRef[] = [];
  const from = typeof r.from === 'string' && r.from.length > 0 ? r.from : null;
  const to   = typeof r.to   === 'string' && r.to.length   > 0 ? r.to   : null;
  const p    = typeof r.path === 'string' && r.path.length > 0 ? r.path : null;
  const id   = typeof r.id   === 'string' && r.id.length   > 0 ? r.id   : null;
  const url  = typeof r.url  === 'string' && r.url.length  > 0 ? r.url  : null;
  const wrote = typeof r.bytesWritten === 'number' || typeof r.bytes === 'number';
  if (from && to) {
    refs.push({ resource: fileUri(from), interaction: 'moved_from' });
    refs.push({ resource: fileUri(to),   interaction: 'moved_to' });
  } else if (to) {
    refs.push({ resource: fileUri(to), interaction: wrote ? 'wrote' : 'created' });
  } else if (p) {
    refs.push({ resource: fileUri(p), interaction: wrote ? 'wrote' : 'read' });
  } else if (id) {
    refs.push({ resource: `object://${id}`, interaction: 'created' });
  }
  if (url) refs.push({ resource: `net://${hostOf(url)}`, interaction: 'sent' });
  return refs;
}

// ── The three independent axes ──────────────────────────────────────────────

/** What the approval layer decided about this command. */
export type ApprovalState =
  | 'not_required'   // read-only / never needed a decision
  | 'assessing'      // being classified (tier / dial)
  | 'awaiting_user'  // prompt open
  | 'allowed'        // approval granted (auto or user)
  | 'denied'         // refused — a user/policy DECISION, not a failure
  | 'interrupted';   // decision abandoned mid-prompt (Ctrl+C)

/** What happened when (if) the tool ran. */
export type ExecutionState =
  | 'not_started'    // never ran (e.g. denied)
  | 'running'        // in flight
  | 'succeeded'      // ran clean (no error, zero/absent exit code)
  | 'nonzero_exit'   // ran and returned a non-zero exit — may be EXPECTED
  | 'errored'        // the tool itself threw / failed to run (a crash)
  | 'interrupted';   // aborted mid-run

/** Whether the claimed effect verified. Independent of execution. */
export type VerificationState =
  | 'not_applicable' // nothing to verify (read-only / no verifier)
  | 'pending'        // verification not yet computed
  | 'verified'       // verifier ok, code 'ok' (evidence-backed elsewhere)
  | 'weak'           // verifier ok but low_signal / no_progress
  | 'failed'         // verifier said no, OR claimed artifact absent on disk
  | 'unknown';       // verifier ran but could not classify

/**
 * Derived, RENDERING-ONLY. Never replaces the three axes; a renderer picks the
 * single most-active phase to show a row's status. Deliberately coarse.
 */
export type ActivityPhase =
  | 'proposed'
  | 'assessing'
  | 'awaiting_approval'
  | 'running'
  | 'verifying'
  | 'terminal';

// ── The record shapes ───────────────────────────────────────────────────────

/** The model's intent — one tool call. */
export interface CommandProposal {
  /** Aiden-minted key. */
  id: CommandId;
  /** The provider's tool_call id, stored separately — NOT the key. */
  providerCallId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Static per-tool mutation flag (handler.mutates). */
  mutates: boolean;
  proposedAt: number;
}

export interface ApprovalDecision {
  state: ApprovalState;
  /** How the decision was reached, when known. Provenance the live boolean loses. */
  via?:
    | 'auto_safe'
    | 'allowlist'
    | 'builtin_safe'
    | 'autonomy_dial'
    | 'user_prompt'
    | 'hard_block'
    | 'yolo';
  reason?: string;
}

export interface CommandOutcome {
  state: ExecutionState;
  /** Shell-like exit code when the result exposed one. */
  exitCode?: number;
  /** GENUINE execution error only — never a denial or an interrupt. */
  error?: string;
  /** Separated from `error` from day one, even while the live path collapses them. */
  denied?: boolean;
  interrupted?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface VerificationClaim {
  state: VerificationState;
  ok?: boolean;
  confidence?: number;
  /** The verifier's machine code ('ok' | 'failed' | 'low_signal' | …). */
  code?: string;
  reason?: string;
}

export interface EvidenceRecord {
  tool: string;
  kind: 'path' | 'exit_code' | 'bytes' | 'object_id' | 'note';
  value: string | number;
  verified: boolean;
  code?: string;
}

/** The per-command aggregate both P1B and P2C will consume (later). */
export interface CommandRecord {
  proposal: CommandProposal;
  approval: ApprovalDecision;
  execution: CommandOutcome;
  verification: VerificationClaim;
  evidence: EvidenceRecord[];
  /** Resources this command provably touched (from its structured result). */
  resources: ResourceRef[];
}

// ── Derivation from the (currently collapsed) live signals ───────────────────

/** Marker the approval gate writes into the error string on a refusal. */
const DENIAL_MARKER = 'denied by approval engine';
/** Markers aidenAgent's finally-guarantee writes on an abort. */
const INTERRUPT_MARKERS = ['interrupted', 'dispatch ended before completing'];

function isDenial(error?: string): boolean {
  return !!error && error.toLowerCase().includes(DENIAL_MARKER);
}
function isInterrupt(error?: string, aborted?: boolean): boolean {
  if (aborted) return true;
  if (!error) return false;
  const e = error.toLowerCase();
  return INTERRUPT_MARKERS.some((m) => e.includes(m));
}

/** Pull a shell-style exit code out of a tool result, when present. */
function exitCodeOf(result: unknown): number | undefined {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const c = r.exitCode ?? r.exit_code;
    if (typeof c === 'number') return c;
  }
  return undefined;
}

/** Inputs the dispatch seam can supply (all from context it already holds). */
export interface BuildCommandRecordInput {
  providerCallId: string;
  tool: string;
  args: Record<string, unknown>;
  mutates: boolean;
  /** ToolCallResult.result. */
  result: unknown;
  /** ToolCallResult.error (may encode a denial / interrupt — we un-collapse it). */
  error?: string;
  /** Per-call verifier verdict, when computed. */
  verification?: VerificationResult;
  /** The turn signal was aborted around this call. */
  aborted?: boolean;
  /**
   * True when the tool CLAIMED a written artifact that is NOT on disk. Lets the
   * verification axis agree with the disk-postcondition check without coupling
   * to the (buggy) turn-verdict policy.
   */
  artifactMissing?: boolean;
  startedAt?: number;
  endedAt?: number;
  approvalVia?: ApprovalDecision['via'];
}

function deriveExecution(i: BuildCommandRecordInput): CommandOutcome {
  const denied = isDenial(i.error);
  const interrupted = !denied && isInterrupt(i.error, i.aborted);
  const exitCode = exitCodeOf(i.result);
  let state: ExecutionState;
  if (denied) state = 'not_started';
  else if (interrupted) state = 'interrupted';
  else if (i.error) state = 'errored';
  else if (typeof exitCode === 'number' && exitCode !== 0) state = 'nonzero_exit';
  else state = 'succeeded';
  return {
    state,
    exitCode,
    // `error` holds a GENUINE crash only — denial/interrupt are their own flags.
    error: state === 'errored' ? i.error : undefined,
    denied: denied || undefined,
    interrupted: interrupted || undefined,
    startedAt: i.startedAt,
    endedAt: i.endedAt,
  };
}

function deriveApproval(i: BuildCommandRecordInput, exec: CommandOutcome): ApprovalDecision {
  if (exec.denied) return { state: 'denied', via: i.approvalVia, reason: i.error };
  if (!i.mutates) return { state: 'not_required' };
  // A mutating tool that ran (or errored/interrupted mid-run, but was not
  // denied) had approval resolved to allow.
  return { state: 'allowed', via: i.approvalVia };
}

function deriveVerification(i: BuildCommandRecordInput): VerificationClaim {
  const v = i.verification;
  if (!v) {
    // No verifier verdict. A claimed-but-missing artifact still fails.
    return i.artifactMissing
      ? { state: 'failed', reason: 'claimed artifact absent on disk' }
      : { state: 'not_applicable' };
  }
  let state: VerificationState;
  if (v.ok && i.artifactMissing) state = 'failed';
  else if (v.ok && v.code === 'ok') state = 'verified';
  else if (v.ok && (v.code === 'low_signal' || v.code === 'no_progress')) state = 'weak';
  else if (!v.ok) state = 'failed';
  else state = 'unknown';
  return {
    state,
    ok: v.ok,
    confidence: v.confidence,
    code: v.code,
    reason: i.artifactMissing && v.ok ? 'claimed artifact absent on disk' : v.reason,
  };
}

/**
 * Build a CommandRecord from the seam's (collapsed) signals. Pure. Mints a
 * fresh CommandId; the provider's id rides along in `providerCallId`.
 */
export function buildCommandRecord(i: BuildCommandRecordInput): CommandRecord {
  const execution = deriveExecution(i);
  const approval = deriveApproval(i, execution);
  const verification = deriveVerification(i);
  const proposal: CommandProposal = {
    id: mintCommandId(),
    providerCallId: i.providerCallId,
    tool: i.tool,
    args: i.args,
    mutates: i.mutates,
    proposedAt: i.startedAt ?? i.endedAt ?? 0,
  };
  return { proposal, approval, execution, verification, evidence: [], resources: extractResources(i.result) };
}

/**
 * Derive the coarse rendering phase from the three axes. RENDERING ONLY — the
 * dock uses this to pick a row's single visible status; it never stands in for
 * the axes a consumer should read directly.
 */
export function deriveActivityPhase(r: CommandRecord): ActivityPhase {
  if (r.approval.state === 'assessing') return 'assessing';
  if (r.approval.state === 'awaiting_user') return 'awaiting_approval';
  if (r.execution.state === 'running') return 'running';
  if (r.verification.state === 'pending') return 'verifying';
  return 'terminal';
}
