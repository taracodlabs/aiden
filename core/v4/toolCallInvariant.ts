/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolCallInvariant.ts — v4.9.4 SLICE 1.
 *
 * The tool-call/tool-result protocol invariant required by the OpenAI /
 * ChatGPT-Plus / Anthropic / Codex Responses message wire formats:
 *
 *   For every assistant message with toolCalls[],
 *   every tool_call.id MUST be answered by a later `tool` role message
 *   carrying the same toolCallId, before the next provider request.
 *
 * Aiden previously violated this in two known dispatch sites
 * (aidenAgent runTurnLoop's surfaceDecision break + abort-signal break)
 * which left orphan tool_call_ids in persisted history. Resuming such
 * a history triggered 400 from the provider:
 *
 *   Provider chatgpt-plus request failed (400):
 *   No tool output found for function call call_<id>.
 *
 * This module exposes three primitives:
 *   - assertNoUnansweredToolCalls(messages)        — preflight gate
 *   - synthesizeBlockedToolResult(call, reason)    — fill primitive
 *   - fillRemainingAsBlocked(buf, calls, idx, ..)  — batch helper
 *
 * Plus the OrphanToolCallError class thrown by the preflight.
 *
 * Provider-agnostic — each adapter translates Aiden's internal Message
 * type into its native wire shape. Assertions run against the internal
 * Message shape itself.
 */

import type { Message, ToolCallRequest } from '../../providers/v4/types';

// ── Suppression reasons ──────────────────────────────────────────────

/**
 * Reasons a tool call may be suppressed without execution. Closed union
 * for now — extend when v4.10 lands new guards (rate-limit, cost-budget,
 * hook-deny). Each new reason should map to one and only one suppression
 * site; the synthetic result content surfaces the reason verbatim so log
 * readers and the LLM can disambiguate.
 */
export type SuppressReason =
  | 'tool_loop_surface'    // TurnState recovery controller surfaced
  | 'cancelled';           // abort signal fired (Ctrl+C, /quit, programmatic)

export interface SynthesizeOpts {
  /**
   * 'interrupted' → "This call was interrupted before execution."
   *                  (the call we were ABOUT to dispatch when the
   *                  abort signal fired — mid-flight feel)
   * 'skipped'     → "This call was skipped because the turn was cancelled."
   *                  (calls never reached after a guard fired — never-began feel)
   * Defaults to 'skipped' — matches the more common case (surface guard
   * fires after one call has dispatched; remaining calls are skipped,
   * not interrupted).
   */
  variant?: 'interrupted' | 'skipped';
}

// ── Error class ──────────────────────────────────────────────────────

/**
 * Thrown by assertNoUnansweredToolCalls. Subclassed from Error so
 * triage code can:
 *
 *   try { ... } catch (e) {
 *     if (e instanceof OrphanToolCallError) { ... }
 *   }
 *
 * Production code MUST NOT catch this. If it fires, a guard upstream
 * is leaking orphan tool_call_ids and we want the failure loud at the
 * site that introduced the leak.
 */
export class OrphanToolCallError extends Error {
  readonly orphans: ReadonlyArray<{ toolCallId: string; toolName: string }>;
  constructor(orphans: ReadonlyArray<{ toolCallId: string; toolName: string }>) {
    const ids = orphans.map((o) => `${o.toolName}#${o.toolCallId}`).join(', ');
    super(
      `Tool-call/result protocol violated: ${orphans.length} unanswered tool_call_id(s) [${ids}]. ` +
      `Some guard in the dispatch loop emitted an assistant message with tool_calls[] ` +
      `but did not push a matching {role:'tool', toolCallId} for every id. ` +
      `Find the guard and add a synthesizeBlockedToolResult() call before its break/continue.`,
    );
    this.name = 'OrphanToolCallError';
    this.orphans = orphans;
  }
}

// ── Preflight assertion ──────────────────────────────────────────────

/**
 * Walk the messages once. For each assistant message at index i, scan
 * messages[i+1..] for `{ role: 'tool', toolCallId }` entries matching
 * each toolCalls[].id. Orphans (unmatched ids) accumulate; a single
 * Error is thrown listing all of them so a single debugging session
 * sees the full damage (better than throw-on-first).
 *
 * Pure. No IO, no clock. Cost is O(N*M) where N = total messages and
 * M = avg tool-calls-per-assistant-turn; trivial for any realistic
 * session (low hundreds of messages, low tens of tool calls per turn).
 *
 * Called from AidenAgent.callProvider() as the single boundary preflight
 * — every provider adapter receives messages[] through that one funnel.
 */
export function assertNoUnansweredToolCalls(messages: ReadonlyArray<Message>): void {
  // Index every tool RESULT by id → the message positions where it appears.
  // A result answers a call ONLY when it appears AFTER the call in message
  // order, so membership in a Set is not enough — we must compare POSITIONS.
  // A result that precedes its call (or a duplicate id whose only result is the
  // earlier one) leaves the later call UNANSWERED; the wire format rejects that
  // on the next request ("No tool output found for function call call_<id>").
  const resultPositions = new Map<string, number[]>();
  messages.forEach((m, idx) => {
    if (m.role !== 'tool') return;
    const at = resultPositions.get(m.toolCallId);
    if (at) at.push(idx);
    else resultPositions.set(m.toolCallId, [idx]);
  });
  // Walk assistants in order; a call at index i is answered iff a matching
  // result exists at some index > i. Orphans accumulate for a single throw.
  const orphans: Array<{ toolCallId: string; toolName: string }> = [];
  messages.forEach((m, idx) => {
    if (m.role !== 'assistant' || !m.toolCalls) return;
    for (const tc of m.toolCalls) {
      const at = resultPositions.get(tc.id);
      const answeredLater = at ? at.some((p) => p > idx) : false;
      if (!answeredLater) {
        orphans.push({ toolCallId: tc.id, toolName: tc.name });
      }
    }
  });
  if (orphans.length > 0) throw new OrphanToolCallError(orphans);
}

// ── Synthesis primitives ─────────────────────────────────────────────

/**
 * Build a tool-role message whose content is a JSON-stringified failure
 * object the LLM can parse:
 *
 *   { ok: false, blocked: true, reason: <code>, message: <human> }
 *
 * Same shape regardless of which guard fired so the LLM sees a uniform
 * signal. Internal Aiden Message type — providers/v4 adapters handle
 * wire-shape translation per their native protocol.
 */
export function synthesizeBlockedToolResult(
  call:   ToolCallRequest,
  reason: SuppressReason,
  opts:   SynthesizeOpts = {},
): Message {
  const variant = opts.variant ?? 'skipped';
  const humanMessage = variant === 'interrupted'
    ? `This call was interrupted before execution. (reason: ${reason})`
    : `This call was skipped because the turn was cancelled. (reason: ${reason})`;
  // tool_loop_surface variant is always 'skipped' semantically (we
  // already executed the call before the surface decision fired, so
  // the SKIPPED calls are the remainder). But we still let the caller
  // override if a future site has a different shape.
  const content = JSON.stringify({
    ok:      false,
    blocked: true,
    reason,
    message: humanMessage,
  });
  return {
    role:       'tool',
    toolCallId: call.id,
    content,
  };
}

/**
 * Push synthetic blocked-tool-result messages for every unprocessed
 * call from `startIdx` (inclusive) onward. Mutates `buf` in place
 * (matches the existing turnToolMessages accumulator pattern in
 * aidenAgent.ts; pure-returning would force a spread at every call
 * site).
 *
 * Exported because v4.10 guards (rate-limit, cost-budget, hook-deny)
 * will want the same shape.
 */
export function fillRemainingAsBlocked(
  buf:       Message[],
  toolCalls: ReadonlyArray<ToolCallRequest>,
  startIdx:  number,
  reason:    SuppressReason,
  variant:   'interrupted' | 'skipped' = 'skipped',
): void {
  for (let i = startIdx; i < toolCalls.length; i++) {
    buf.push(synthesizeBlockedToolResult(toolCalls[i], reason, { variant }));
  }
}

// ── Unified message preflight ─────────────────────────────────────────
//
// ONE comprehensive repair pass, run at the single ProviderAdapter.call /
// callStream boundary (see providers/v4/preflightAdapter.ts) so EVERY provider
// call — main turn, fallback slots, vision, distiller, merger, sub-agent,
// compression, auxiliary — is validated exactly once, before any provider-
// specific reshaping.
//
// The golden rule: REPAIR STRUCTURE, NEVER FABRICATE A FACT. A missing tool
// result becomes an honest "result unavailable" stub — never a fake success.
// Structural junk is repaired with a warning in production; strict mode (tests
// / dev) throws instead, so bugs are loud where they should be.

/** Sentinel name for a tool call that arrived with no name — kept (not dropped)
 *  so its result isn't orphaned. */
export const INVALID_TOOL_CALL_NAME = 'invalid_tool_call';

export interface PreflightOptions {
  /** Throw `PreflightRepairError` on ANY repair (tests / dev) instead of
   *  repairing silently. Default false — repair + warn (production). */
  strict?: boolean;
  /** Warning sink (production). Default: console.warn with a `[preflight]` tag. */
  onWarn?: (message: string) => void;
}

/** Thrown by `preflightMessages` in `strict` mode when any repair was needed. */
export class PreflightRepairError extends Error {
  readonly repairs: ReadonlyArray<string>;
  constructor(repairs: ReadonlyArray<string>) {
    super(`Message preflight found ${repairs.length} structural problem(s):\n  - ${repairs.join('\n  - ')}`);
    this.name = 'PreflightRepairError';
    this.repairs = repairs;
  }
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce tool-call arguments to a plain object. A malformed JSON string is
 *  parsed; anything unrecoverable falls back to `{}` (never a guessed value). */
function repairArgs(args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (isPlainObject(parsed)) return parsed;
    } catch { /* fall through to {} */ }
  }
  return {};
}

/** An HONEST "result unavailable" stub for a tool call that never produced a
 *  result — explicitly NOT a success, so the model can't be misled. */
function unavailableStub(call: ToolCallRequest): Message {
  return {
    role:       'tool',
    toolCallId: call.id,
    content:    JSON.stringify({
      ok:      false,
      blocked: false,
      reason:  'result_unavailable',
      message: `No result was recorded for this call (${call.name}). It may have been interrupted; treat it as unavailable, not as success.`,
    }),
  };
}

/**
 * Repair a message array into a provider-valid `Message[]`. Pure (aside from the
 * optional warning sink). Runs, in order:
 *
 *   1. valid roles only                         — drop junk roles
 *   2. empty `toolCalls: []`                     — drop the key
 *   5. duplicate tool_call_id                    — dedupe (keep first)
 *   6. empty tool name                           — rename to invalid_tool_call
 *   7. malformed tool args                       — repair, fallback to {}
 *   4. orphan tool result (no matching call)     — drop
 *   3. unanswered assistant tool-call            — inject "unavailable" stub …
 *   (a) …EXCEPT a dangling tail (killed mid-tool)— strip it (no reissue loop)
 *   8. direct tool→user transition               — insert an assistant placeholder
 */
export function preflightMessages(
  input: ReadonlyArray<Message>,
  opts:  PreflightOptions = {},
): Message[] {
  const repairs: string[] = [];
  const warn = (m: string) => repairs.push(m);
  let synth = 0;

  // 1. Valid roles only.
  let msgs: Message[] = [];
  for (const m of input) {
    if (!m || typeof m !== 'object' || !VALID_ROLES.has((m as { role?: string }).role ?? '')) {
      warn(`dropped message with invalid role: ${JSON.stringify((m as { role?: unknown })?.role)}`);
      continue;
    }
    msgs.push({ ...(m as Message) });
  }

  // 2/5/6/7. Normalise assistant tool-calls + collect the set of declared ids.
  const declaredIds = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    if (m.toolCalls.length === 0) {
      delete (m as { toolCalls?: unknown }).toolCalls;   // 2. empty [] → drop key
      warn('dropped empty toolCalls: []');
      continue;
    }
    const cleaned: ToolCallRequest[] = [];
    for (const tc of m.toolCalls) {
      let id = typeof tc?.id === 'string' && tc.id ? tc.id : `synthetic_tool_call_${synth++}`;
      if (id !== tc?.id) warn(`assigned a synthetic id to a tool call missing one (${id})`);
      if (declaredIds.has(id)) { warn(`deduped duplicate tool_call_id ${id}`); continue; }  // 5
      declaredIds.add(id);
      let name = typeof tc?.name === 'string' && tc.name.trim() ? tc.name : INVALID_TOOL_CALL_NAME;  // 6
      if (name === INVALID_TOOL_CALL_NAME && tc?.name !== INVALID_TOOL_CALL_NAME) {
        warn(`renamed empty tool name → ${INVALID_TOOL_CALL_NAME}`);
      }
      const args = repairArgs(tc?.arguments);   // 7
      if (!isPlainObject(tc?.arguments)) warn(`repaired malformed tool arguments for ${name}#${id} → {}`);
      cleaned.push({ id, name, arguments: args });
    }
    if (cleaned.length === 0) delete (m as { toolCalls?: unknown }).toolCalls;
    else m.toolCalls = cleaned;
  }

  // 4. Drop orphan tool results (no matching declared call).
  msgs = msgs.filter((m) => {
    if (m.role === 'tool' && !declaredIds.has(m.toolCallId)) {
      warn(`dropped orphan tool result (no matching call): ${m.toolCallId}`);
      return false;
    }
    return true;
  });

  // 3 + (a). Answer unanswered assistant tool-calls: stub mid-history, strip at the tail.
  const answered = new Set<string>();
  for (const m of msgs) if (m.role === 'tool') answered.add(m.toolCallId);
  const withResults: Message[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      const unanswered = m.toolCalls.filter((tc) => !answered.has(tc.id));
      if (unanswered.length > 0) {
        if (i === msgs.length - 1) {
          // (a) Suicide-loop guard: a dangling assistant tool-call at the very
          // tail means the process died mid-tool. Strip the unanswered calls so
          // Aiden re-plans instead of reissuing a (possibly destructive) command.
          const kept = m.toolCalls.filter((tc) => answered.has(tc.id));
          warn(`stripped ${unanswered.length} dangling unanswered tool-call(s) at the tail (killed-mid-tool resume)`);
          if (kept.length === 0 && !(m.content && m.content.trim())) continue;   // drop now-empty msg
          if (kept.length === 0) { const { toolCalls: _drop, ...rest } = m; withResults.push(rest as Message); continue; }
          withResults.push({ ...m, toolCalls: kept });
          continue;
        }
        // 3. Mid-history: inject an honest "unavailable" stub for each — NEVER a success.
        withResults.push(m);
        for (const tc of unanswered) {
          warn(`injected 'result unavailable' stub for unanswered tool-call ${tc.name}#${tc.id}`);
          withResults.push(unavailableStub(tc));
        }
        continue;
      }
    }
    withResults.push(m);
  }
  msgs = withResults;

  // 8. No direct tool→user transition — insert an (empty) assistant placeholder
  //    so the wire alternation is valid without inventing an assistant claim.
  const alternated: Message[] = [];
  for (let i = 0; i < msgs.length; i++) {
    alternated.push(msgs[i]);
    const next = msgs[i + 1];
    if (msgs[i].role === 'tool' && next && next.role === 'user') {
      warn('inserted an assistant placeholder between a tool result and a user message');
      alternated.push({ role: 'assistant', content: '' });
    }
  }
  msgs = alternated;

  if (repairs.length > 0) {
    if (opts.strict) throw new PreflightRepairError(repairs);
    const sink = opts.onWarn ?? ((m: string) => { try { console.warn(`[preflight] ${m}`); } catch { /* no console */ } });
    for (const r of repairs) sink(r);
  }
  return msgs;
}
