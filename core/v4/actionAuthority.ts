/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Db } from './daemon/db/connection';
import type { JobEngine } from './daemon/jobEngine';

export interface PolicySnapshotInput {
  trustLevel: string;
  autonomyPolicy: string;
  approvalMode: string;
  toolMetadataVersion: string;
  sandboxPolicy: unknown;
  networkPolicy: unknown;
  pluginGrants: unknown;
  mcpGrants: unknown;
  spendingLimits?: unknown;
  workspaceOverrides: unknown;
  jobOverrides: unknown;
}

export interface PolicySnapshot extends PolicySnapshotInput {
  policySnapshotId: string;
  schemaVersion: 1;
  digest: string;
}

export interface NormalizedExecutionPlan {
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  cwd: string;
  executable: string | null;
  shell: string | null;
  environmentFingerprint: string | null;
  networkTargets: readonly string[];
  affectedResources: readonly string[];
  mutates: boolean;
  riskTier: string;
}

export interface NormalizedAction {
  plan: Readonly<NormalizedExecutionPlan>;
  actionDigest: string;
  policySnapshot: PolicySnapshot;
}

export interface ApprovalRecord {
  approvalId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  toolCallId: string;
  requestSequence: number;
  toolName: string;
  riskTier: string;
  actionDigest: string;
  policySnapshotId: string;
  state: 'created' | 'displayed' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'invalidated' | 'executed' | 'stale_rejected';
  decision: string | null;
  requestedAt: number;
  displayedAt: number | null;
  decidedAt: number | null;
  expiresAt: number | null;
  executedAt: number | null;
  invalidationReason: string | null;
}

export interface ActionAuthority {
  request(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    toolCallId: string;
    toolName: string;
    riskTier: string;
    riskReasons: string[];
    normalized: NormalizedAction;
    expiresAt?: number | null;
    now?: number;
  }): ApprovalRecord;
  get(approvalId: string): ApprovalRecord | null;
  listPending(jobId: string): ApprovalRecord[];
  markDisplayed(approvalId: string, now?: number): ApprovalRecord;
  decide(command: {
    approvalId: string;
    jobId: string;
    attemptId: string;
    generation: number;
    actionDigest: string;
    policySnapshotId: string;
    decision: 'approved' | 'denied' | 'cancelled';
    decisionInputId?: string | null;
    decisionScope?: string | null;
    decidedBy: string;
    decisionChannel: string;
    now?: number;
  }): ApprovalRecord;
  decideFromInput(command: { approvalId: string; inputKind: string; content: string }): never;
  authorizeExecution(command: {
    approvalId: string;
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    toolCallId: string;
    actionDigest: string;
    policySnapshotId: string;
    now?: number;
  }): { authorized: boolean; duplicate?: boolean; reason?: string };
  invalidate(approvalId: string, reason: string, now?: number): ApprovalRecord;
}

interface ApprovalRow {
  approval_id: string;
  job_id: string;
  attempt_id: string;
  generation: number;
  tool_call_id: string;
  request_sequence: number;
  tool_name: string;
  risk_tier: string;
  action_digest: string;
  policy_snapshot_id: string;
  state: ApprovalRecord['state'];
  decision: string | null;
  requested_at: number;
  displayed_at: number | null;
  decided_at: number | null;
  expires_at: number | null;
  executed_at: number | null;
  invalidation_reason: string | null;
}

const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
  }
  return value;
}

function redactedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactedCanonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : redactedCanonical(source[key]),
    ]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function policySnapshot(input: PolicySnapshotInput): PolicySnapshot {
  const safe = redactedCanonical(input) as PolicySnapshotInput;
  const digest = sha({ schemaVersion: 1, ...safe });
  return deepFreeze({
    ...safe,
    schemaVersion: 1 as const,
    digest,
    policySnapshotId: `policy_${digest}`,
  });
}

function firstCommandToken(command: string): string | null {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function canonicalPath(value: string): string {
  const suffix: string[] = [];
  let cursor = path.resolve(value);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(value);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  let resolved: string;
  try { resolved = fs.realpathSync.native(cursor); }
  catch { resolved = cursor; }
  return path.join(resolved, ...suffix);
}

function resolveResource(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return canonicalPath(path.resolve(cwd, value));
}

export function normalizeExecutionPlan(command: {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  mutates: boolean;
  riskTier: string;
  policy: PolicySnapshotInput;
}): NormalizedAction {
  const requestedCwd = typeof command.args.cwd === 'string' ? command.args.cwd : command.cwd;
  const cwd = canonicalPath(path.resolve(command.cwd, requestedCwd));
  const rawCommand = typeof command.args.command === 'string' ? command.args.command : null;
  const executable = rawCommand ? firstCommandToken(rawCommand) : null;
  const shell = rawCommand ? (process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh') : null;
  const env = command.args.env && typeof command.args.env === 'object' && !Array.isArray(command.args.env)
    ? command.args.env as Record<string, unknown>
    : null;
  const environmentFingerprint = env ? sha(env) : null;
  const networkTargets = ['url', 'endpoint', 'host'].map((key) => command.args[key])
    .filter((value): value is string => typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    .sort();
  const affectedResources = ['path', 'file', 'source', 'destination', 'cwd']
    .map((key) => resolveResource(command.args[key], cwd))
    .filter((value): value is string => value !== null)
    .sort();
  const safeArgs = redactedCanonical(command.args) as Record<string, unknown>;
  const plan: NormalizedExecutionPlan = deepFreeze({
    toolName: command.toolName,
    args: safeArgs,
    cwd,
    executable,
    shell,
    environmentFingerprint,
    networkTargets,
    affectedResources,
    mutates: command.mutates,
    riskTier: command.riskTier,
  });
  const snapshot = policySnapshot(command.policy);
  const actionDigest = sha({
    toolName: command.toolName,
    args: canonical(command.args),
    cwd,
    executable,
    shell,
    environmentFingerprint,
    networkTargets,
    affectedResources,
    mutates: command.mutates,
    riskTier: command.riskTier,
    policyDigest: snapshot.digest,
  });
  return deepFreeze({ plan, actionDigest, policySnapshot: snapshot });
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    toolCallId: row.tool_call_id,
    requestSequence: row.request_sequence,
    toolName: row.tool_name,
    riskTier: row.risk_tier,
    actionDigest: row.action_digest,
    policySnapshotId: row.policy_snapshot_id,
    state: row.state,
    decision: row.decision,
    requestedAt: row.requested_at,
    displayedAt: row.displayed_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    invalidationReason: row.invalidation_reason,
  };
}

export function createActionAuthority(options: { db: Db; jobEngine: JobEngine }): ActionAuthority {
  const { db, jobEngine } = options;
  const get = (approvalId: string): ApprovalRecord | null => {
    const row = db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  };
  const persistPolicy = (snapshot: PolicySnapshot, now: number): void => {
    const p = snapshot;
    db.prepare(
      `INSERT OR IGNORE INTO policy_snapshots (
         policy_snapshot_id, schema_version, digest, trust_level, autonomy_policy,
         approval_mode, tool_metadata_version, sandbox_policy_json,
         network_policy_json, plugin_grants_json, mcp_grants_json,
         spending_limits_json, workspace_overrides_json, job_overrides_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.policySnapshotId,
      p.schemaVersion,
      p.digest,
      p.trustLevel,
      p.autonomyPolicy,
      p.approvalMode,
      p.toolMetadataVersion,
      stableJson(p.sandboxPolicy),
      stableJson(p.networkPolicy),
      stableJson(p.pluginGrants),
      stableJson(p.mcpGrants),
      p.spendingLimits === undefined ? null : stableJson(p.spendingLimits),
      stableJson(p.workspaceOverrides),
      stableJson(p.jobOverrides),
      now,
    );
  };
  const appendApprovalEvent = (record: ApprovalRecord, type: string, producer: string): void => {
    const result = jobEngine.appendJobEvent({
      jobId: record.jobId,
      attemptId: record.attemptId,
      generation: record.generation,
      type,
      producer,
      idempotencyKey: `approval:${record.approvalId}:${type}`,
      payload: {
        approvalId: record.approvalId,
        toolCallId: record.toolCallId,
        actionDigest: record.actionDigest,
        policySnapshotId: record.policySnapshotId,
        state: record.state,
      },
    });
    if (!result.applied && !result.duplicate) {
      throw new Error(`Approval event rejected: ${result.conflict ?? 'unknown conflict'}`);
    }
  };

  return {
    request(command) {
      const job = jobEngine.getJob(command.jobId);
      const attempt = jobEngine.getAttempt(command.attemptId);
      if (
        !job || !attempt || job.activeAttemptId !== command.attemptId ||
        attempt.jobId !== command.jobId || attempt.generation !== command.generation ||
        ['cancelled', 'completed', 'failed', 'dead_letter'].includes(job.status)
      ) {
        throw new Error('Approval target has a stale generation');
      }
      const now = command.now ?? Date.now();
      const transaction = db.transaction(() => {
        persistPolicy(command.normalized.policySnapshot, now);
        const sequence = (db.prepare(
          'SELECT COALESCE(MAX(request_sequence), 0) + 1 AS sequence FROM approvals WHERE job_id = ?',
        ).get(command.jobId) as { sequence: number }).sequence;
        const approvalId = makeId('approval');
        db.prepare(
          `INSERT INTO approvals (
             approval_id, job_id, attempt_id, generation, tool_call_id,
             request_sequence, tool_name, risk_tier, risk_reasons_json,
             normalized_execution_plan, action_digest, policy_snapshot_id,
             state, requested_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
        ).run(
          approvalId,
          command.jobId,
          command.attemptId,
          command.generation,
          command.toolCallId,
          sequence,
          command.toolName,
          command.riskTier,
          stableJson(command.riskReasons),
          stableJson(command.normalized.plan),
          command.normalized.actionDigest,
          command.normalized.policySnapshot.policySnapshotId,
          now,
          command.expiresAt ?? null,
        );
        const record = get(approvalId)!;
        appendApprovalEvent(record, 'approval.created', 'approval');
        return record;
      });
      return transaction.immediate();
    },
    get,
    listPending(jobId) {
      return (db.prepare(
        `SELECT * FROM approvals
          WHERE job_id = ? AND state IN ('created','displayed')
          ORDER BY request_sequence`,
      ).all(jobId) as ApprovalRow[]).map(mapApproval);
    },
    markDisplayed(approvalId, now = Date.now()) {
      return db.transaction(() => {
        db.prepare(
          `UPDATE approvals SET state = 'displayed', displayed_at = COALESCE(displayed_at, ?)
            WHERE approval_id = ? AND state = 'created'`,
        ).run(now, approvalId);
        const record = get(approvalId);
        if (!record) throw new Error('Approval not found');
        appendApprovalEvent(record, 'approval.displayed', 'approval');
        return record;
      }).immediate();
    },
    decide(command) {
      let expired = false;
      const result = db.transaction(() => {
        const record = get(command.approvalId);
        if (!record) throw new Error('Approval not found');
        const job = jobEngine.getJob(command.jobId);
        const attempt = jobEngine.getAttempt(command.attemptId);
        if (!job || ['cancelled', 'completed', 'failed', 'dead_letter'].includes(job.status)) {
          throw new Error('Terminal Job rejects approval decisions');
        }
        if (
          !attempt || job.activeAttemptId !== command.attemptId ||
          attempt.jobId !== command.jobId || attempt.generation !== command.generation
        ) {
          throw new Error('Approval decision has a stale generation');
        }
        if (
          record.jobId !== command.jobId || record.attemptId !== command.attemptId ||
          record.generation !== command.generation
        ) throw new Error('Approval decision binding mismatch or stale generation');
        if (record.actionDigest !== command.actionDigest || record.policySnapshotId !== command.policySnapshotId) {
          this.invalidate(command.approvalId, 'action or policy changed', command.now);
          throw new Error('Approval action or policy changed');
        }
        if (record.state === 'approved' || record.state === 'denied' || record.state === 'cancelled') {
          if (record.decision !== command.decision) throw new Error('Approval received a conflicting decision');
          return record;
        }
        if (!['created', 'displayed'].includes(record.state)) throw new Error(`Approval is ${record.state}`);
        const now = command.now ?? Date.now();
        if (record.expiresAt !== null && record.expiresAt <= now) {
          db.prepare(
            `UPDATE approvals SET state = 'expired', decided_at = ? WHERE approval_id = ? AND state IN ('created','displayed')`,
          ).run(now, command.approvalId);
          expired = true;
          const updated = get(command.approvalId)!;
          appendApprovalEvent(updated, 'approval.expired', command.decidedBy);
          return updated;
        }
        db.prepare(
          `UPDATE approvals SET state = ?, decision = ?, decision_input_id = ?, decision_scope = ?,
              decided_by = ?, decision_channel = ?, decided_at = ?
            WHERE approval_id = ? AND state IN ('created','displayed')`,
        ).run(
          command.decision,
          command.decision,
          command.decisionInputId ?? null,
          command.decisionScope ?? 'once',
          command.decidedBy,
          command.decisionChannel,
          now,
          command.approvalId,
        );
        const updated = get(command.approvalId)!;
        appendApprovalEvent(updated, `approval.${command.decision}`, command.decidedBy);
        return updated;
      }).immediate();
      if (expired) throw new Error('Approval expired');
      return result;
    },
    decideFromInput() {
      throw new Error('An explicit approval decision command is required; normal text is never consent');
    },
    authorizeExecution(command) {
      return db.transaction(() => {
        const record = get(command.approvalId);
        if (!record) return { authorized: false, reason: 'approval not found' };
        if (record.state === 'executed') return { authorized: false, duplicate: true, reason: 'approval already executed' };
        if (record.state !== 'approved') return { authorized: false, reason: `approval is ${record.state}` };
        const job = jobEngine.getJob(command.jobId);
        const attempt = jobEngine.getAttempt(command.attemptId);
        const now = command.now ?? Date.now();
        if (
          !job || !attempt || job.activeAttemptId !== command.attemptId ||
          attempt.generation !== command.generation ||
          attempt.fenceToken !== command.fenceToken ||
          attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= now ||
          !['running', 'waiting'].includes(job.status) ||
          !['running', 'waiting', 'leased'].includes(attempt.status)
        ) {
          this.invalidate(command.approvalId, 'stale Job or Attempt generation', command.now);
          return { authorized: false, reason: 'stale Job, Attempt generation, or fence' };
        }
        if (
          record.jobId !== command.jobId || record.attemptId !== command.attemptId ||
          record.generation !== command.generation || record.toolCallId !== command.toolCallId ||
          record.actionDigest !== command.actionDigest || record.policySnapshotId !== command.policySnapshotId
        ) {
          this.invalidate(command.approvalId, 'approved action changed or binding mismatch', command.now);
          return { authorized: false, reason: 'approved action changed or binding mismatch' };
        }
        if (record.expiresAt !== null && record.expiresAt <= now) {
          db.prepare(`UPDATE approvals SET state = 'expired', invalidated_at = ? WHERE approval_id = ? AND state = 'approved'`)
            .run(now, command.approvalId);
          appendApprovalEvent(get(command.approvalId)!, 'approval.expired', 'approval');
          return { authorized: false, reason: 'approval expired' };
        }
        const changed = db.prepare(
          `UPDATE approvals SET state = 'executed', executed_at = ? WHERE approval_id = ? AND state = 'approved'`,
        ).run(now, command.approvalId);
        if (changed.changes !== 1) {
          return { authorized: false, duplicate: true, reason: 'approval execution already claimed' };
        }
        appendApprovalEvent(get(command.approvalId)!, 'approval.executed', 'approval');
        return { authorized: true };
      }).immediate();
    },
    invalidate(approvalId, reason, now = Date.now()) {
      return db.transaction(() => {
        db.prepare(
          `UPDATE approvals
              SET state = 'invalidated', invalidated_at = ?, invalidation_reason = ?
            WHERE approval_id = ? AND state IN ('created','displayed','approved')`,
        ).run(now, reason, approvalId);
        const record = get(approvalId);
        if (!record) throw new Error('Approval not found');
        appendApprovalEvent(record, 'approval.invalidated', 'approval');
        return record;
      }).immediate();
    },
  };
}
