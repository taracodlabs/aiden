/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/dispatcher.ts — v4.9.0 Slice 12a.
 *
 * Given an event + payload + execution context, queries the DB for
 * active subscriptions, runs each through the subprocess runner,
 * aggregates decisions per the authority/mode model, and writes a
 * `hook_executions` audit row for every firing.
 *
 * Aggregation rules:
 *   - If ANY `mandatory_policy` subscription's net outcome is `block`
 *     (including via on_error/on_timeout policy promotion), the
 *     overall dispatch returns `decision: 'block'`. Earliest blocker
 *     wins.
 *   - `transform_input` / `transform_output` patches apply in
 *     priority order (highest first); subsequent hooks see the
 *     patched payload.
 *   - Best-effort observers + advisory_policy hooks never block the
 *     overall flow — their outcomes only land in the audit table.
 */

import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import { newHookExecId } from '../identity';
import { runHookSubprocess, type RunnerOutcome } from './runtime/subprocessRunner';
import { markRevoked } from './trust';

/**
 * v4.9.0 Slice 12b — auto-disable threshold. After this many
 * consecutive non-`ok` outcomes the dispatcher auto-revokes the
 * hook regardless of `on_error` / `on_timeout` policy. Defense in
 * depth: a poorly-configured `on_error: 'allow'` won't mask a
 * permanently broken hook.
 */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/** Optional sink for `hook.auto_disabled` structured events. */
export type AutoDisableLogger = (event: {
  hookId:           string;
  subscriptionId?:  string;
  reason:           string;
  hookExecutionIds: string[];
}) => void;
let _autoDisableLogger: AutoDisableLogger | null = null;
export function setAutoDisableLogger(fn: AutoDisableLogger | null): void { _autoDisableLogger = fn; }

/**
 * Look up the most recent N `hook_executions` rows for a hook so the
 * `hook.auto_disabled` log line can cross-reference the failures.
 */
function recentExecutionIds(db: Db, hookId: string, n: number): string[] {
  const rows = db.prepare(
    `SELECT hook_execution_id FROM hook_executions WHERE hook_id = ?
       ORDER BY started_at DESC LIMIT ?`,
  ).all(hookId, n) as Array<{ hook_execution_id: string }>;
  return rows.map((r) => r.hook_execution_id);
}

/**
 * Apply auto-disable policy after a single subscription firing.
 * Branches:
 *   - status='ok'                          → reset consecutive_failures = 0
 *   - status in {timeout,crash,malformed}  → increment counter
 *     * if `on_error|on_timeout == 'disable_hook'` → immediate revoke
 *     * else if counter >= threshold       → 3-strike revoke
 *
 * `testMode=true` (used by `aiden hooks test`) skips ALL counter
 * mutation and policy application — pure dry-run.
 */
function applyAutoDisablePolicy(
  db:       Db,
  hookId:   string,
  subId:    string,
  status:   RunnerOutcome['status'],
  policy:   string,
  testMode: boolean,
): void {
  if (testMode) return;
  if (status === 'ok') {
    db.prepare(`UPDATE hooks SET consecutive_failures=0, updated_at=? WHERE hook_id=?`)
      .run(new Date().toISOString(), hookId);
    return;
  }
  // Increment counter for any non-ok outcome.
  db.prepare(`UPDATE hooks SET consecutive_failures = consecutive_failures + 1,
                              updated_at=? WHERE hook_id=?`)
    .run(new Date().toISOString(), hookId);
  // Immediate revoke when the subscription explicitly opts in.
  if (policy === 'disable_hook') {
    markRevoked(db, hookId);
    _autoDisableLogger?.({
      hookId, subscriptionId: subId,
      reason: `auto_disable:${status}`,
      hookExecutionIds: recentExecutionIds(db, hookId, 3),
    });
    return;
  }
  // 3-strike defense in depth.
  const row = db.prepare(`SELECT consecutive_failures AS n FROM hooks WHERE hook_id=?`)
    .get(hookId) as { n: number } | undefined;
  if (row && row.n >= CONSECUTIVE_FAILURE_THRESHOLD) {
    markRevoked(db, hookId);
    _autoDisableLogger?.({
      hookId, subscriptionId: subId,
      reason: `auto_disable:three_strikes:${status}`,
      hookExecutionIds: recentExecutionIds(db, hookId, 3),
    });
  }
}

export interface DispatchContext {
  runId?:        string;
  traceId?:      string;
  spanId?:       string;
  parentSpanId?: string;
  toolCallId?:   string;
  /** When set, only matchers naming this tool fire (event-specific). */
  toolName?:     string;
  /**
   * v4.9.0 Slice 12b — when true, the dispatcher writes the audit row
   * but does NOT touch `consecutive_failures` or trigger auto-revoke.
   * Used by `aiden hooks test <id>` to dry-run a hook against a
   * synthetic payload without burning a strike against the counter.
   */
  testMode?:     boolean;
}

export interface DispatchResult {
  decision:       'allow' | 'block';
  /** Set only when `decision='block'`. */
  reason?:        string;
  user_message?:  string;
  model_message?: string;
  /** Final payload after all `transform_*` hooks applied. */
  payload:        Record<string, unknown>;
  /** Audit summary — one entry per fired subscription. */
  fired:          Array<{
    hookId:         string;
    subscriptionId: string;
    status:         RunnerOutcome['status'];
    decision:       string;
    elapsedMs:      number;
  }>;
}

interface SubRow {
  subscription_id: string;
  hook_id:         string;
  event:           string;
  matcher_json:    string | null;
  authority:       string;
  mode:            string;
  priority:        number;
  timeout_ms:      number;
  on_error:        string;
  on_timeout:      string;
  enabled:         number;
  // joined from hooks
  manifest_path:   string;
  trust_state:     string;
  hook_enabled:    number;
  argv_json?:      string;  // not in db — derived from manifest re-read
  name:            string;
}

/**
 * Match a subscription against the dispatch context. Currently
 * supports tool-name matching for `tool.call.*` events; other matcher
 * shapes (paths, etc.) extend by adding branches here.
 */
function matches(sub: SubRow, ctx: DispatchContext): boolean {
  if (!sub.matcher_json) return true;
  try {
    const m = JSON.parse(sub.matcher_json) as { tools?: string[]; paths?: string[] };
    if (m.tools && m.tools.length > 0) {
      if (!ctx.toolName || !m.tools.includes(ctx.toolName)) return false;
    }
    return true;
  } catch { return true; }  // malformed matcher → permissive
}

/**
 * Read the hook's entrypoint argv from its manifest. We re-parse on
 * each dispatch (sub-ms; the file is tiny) so a manifest edit doesn't
 * require a daemon restart — only the entrypoint code change does,
 * and that trips drift detection on the next scan.
 */
async function readEntrypoint(manifestPath: string): Promise<{ argv: string[]; cwd: string } | null> {
  try {
    const { parseHookManifest } = await import('./manifest');
    const m = await parseHookManifest(manifestPath);
    return { argv: m.entrypoint.argv, cwd: m.manifestDir };
  } catch { return null; }
}

function writeAudit(db: Db, row: {
  hookExecId: string; hookId: string; subscriptionId: string; event: string;
  ctx: DispatchContext; status: RunnerOutcome['status']; decision: string;
  outcome: RunnerOutcome | null; startedAt: string; finishedAt: string;
}): void {
  db.prepare(
    `INSERT INTO hook_executions
       (hook_execution_id, hook_id, subscription_id, event,
        run_id, trace_id, span_id, parent_span_id, tool_call_id,
        status, decision, elapsed_ms, exit_code,
        payload_hash, response_hash, stdout_preview, stderr_preview,
        error_kind, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.hookExecId, row.hookId, row.subscriptionId, row.event,
    row.ctx.runId ?? null, row.ctx.traceId ?? null, row.ctx.spanId ?? null,
    row.ctx.parentSpanId ?? null, row.ctx.toolCallId ?? null,
    row.status, row.decision, row.outcome?.elapsedMs ?? 0, row.outcome?.exitCode ?? null,
    row.outcome?.payloadHash ?? null, row.outcome?.responseHash ?? null,
    row.outcome?.stdoutPreview ?? null, row.outcome?.stderrPreview ?? null,
    row.outcome?.errorKind ?? null, row.outcome?.errorMessage ?? null,
    row.startedAt, row.finishedAt,
  );
}

/**
 * Dispatch all subscriptions matching `event` + `ctx`. Always
 * resolves (never throws); decision aggregation is fail-closed for
 * `mandatory_policy` and fail-open for everything else.
 */
export async function dispatchHook(
  db:       Db,
  event:    string,
  payload:  Record<string, unknown>,
  ctx:      DispatchContext,
): Promise<DispatchResult> {
  const subs = db.prepare(
    `SELECT s.*, h.manifest_path, h.trust_state, h.enabled AS hook_enabled, h.name AS name
       FROM hook_subscriptions s
       JOIN hooks h ON h.hook_id = s.hook_id
      WHERE s.event = ? AND s.enabled = 1
        AND h.enabled = 1 AND h.trust_state = 'trusted'
      ORDER BY s.priority DESC, s.subscription_id ASC`,
  ).all(event) as SubRow[];

  const fired: DispatchResult['fired'] = [];
  let workingPayload = { ...payload };
  let blockReason:  string | undefined;
  let userMessage:  string | undefined;
  let modelMessage: string | undefined;
  let blocked = false;

  for (const sub of subs) {
    if (!matches(sub, ctx)) continue;
    const ep = await readEntrypoint(sub.manifest_path);
    const startedAt = new Date().toISOString();
    const hookExecId = newHookExecId();

    let outcome: RunnerOutcome | null = null;
    let policyDecision: 'allow' | 'block' | 'none' = 'allow';

    if (!ep) {
      // Couldn't read manifest → treat as crash, apply on_error.
      outcome = {
        status: 'crash', exitCode: null, elapsedMs: 0, payloadHash: '',
        stdoutPreview: '', stderrPreview: '',
        errorKind: 'ManifestReadFailed',
        errorMessage: `could not re-read manifest at ${sub.manifest_path}`,
      };
    } else {
      outcome = await runHookSubprocess({
        argv:         ep.argv,
        cwd:          ep.cwd,
        payload:      { event, hook_id: sub.hook_id, subscription_id: sub.subscription_id,
                        run_id: ctx.runId, trace_id: ctx.traceId, parent_span_id: ctx.parentSpanId,
                        payload: workingPayload },
        timeoutMs:    sub.timeout_ms,
        hookId:       sub.hook_id,
        event,
        runId:        ctx.runId,
        traceId:      ctx.traceId,
        parentSpanId: ctx.parentSpanId,
      });
    }

    // Map outcome → policy decision.
    if (outcome.status === 'ok') {
      const d = outcome.response?.decision ?? 'none';
      if (d === 'block' && sub.authority === 'decision') {
        policyDecision = 'block';
      } else {
        policyDecision = 'allow';
      }
      // Apply transform_* patches (priority order is loop order).
      if (outcome.response?.patch && (sub.authority === 'transform_input' || sub.authority === 'transform_output')) {
        workingPayload = { ...workingPayload, ...outcome.response.patch };
      }
    } else {
      // Non-ok statuses route via on_error / on_timeout.
      const policy = outcome.status === 'timeout' ? sub.on_timeout : sub.on_error;
      if (policy === 'block' && sub.mode === 'mandatory_policy') {
        policyDecision = 'block';
      }
      // For 'disable_hook' policy in 12a: we don't auto-disable here;
      // we just treat as allow (12b's CLI surfaces the failure).
    }

    const finishedAt = new Date().toISOString();
    writeAudit(db, {
      hookExecId, hookId: sub.hook_id, subscriptionId: sub.subscription_id,
      event, ctx, status: outcome.status, decision: outcome.response?.decision ?? policyDecision,
      outcome, startedAt, finishedAt,
    });
    // v4.9.0 Slice 12b — auto-disable policy. `disable_hook` triggers
    // immediate revoke; 3 consecutive failures triggers revoke
    // regardless of policy (defense in depth).
    const policy = outcome.status === 'timeout' ? sub.on_timeout : sub.on_error;
    applyAutoDisablePolicy(db, sub.hook_id, sub.subscription_id, outcome.status, policy, ctx.testMode === true);
    fired.push({
      hookId: sub.hook_id, subscriptionId: sub.subscription_id,
      status: outcome.status, decision: outcome.response?.decision ?? policyDecision,
      elapsedMs: outcome.elapsedMs,
    });

    if (policyDecision === 'block' && !blocked) {
      blocked       = true;
      blockReason   = outcome.response?.reason       ?? (outcome.errorMessage ?? 'blocked by hook');
      userMessage   = outcome.response?.user_message;
      modelMessage  = outcome.response?.model_message;
      // For mandatory_policy block, we still run later hooks so they
      // can record audit rows — but mark `decision='block'`.
    }
  }

  return {
    decision: blocked ? 'block' : 'allow',
    reason: blockReason, user_message: userMessage, model_message: modelMessage,
    payload: workingPayload, fired,
  };
}

/** Re-export for caller convenience. */
export { runHookSubprocess };
// Silences unused-import lint when no path matcher fires.
void path;
