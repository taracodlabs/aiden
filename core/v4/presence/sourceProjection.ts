/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';

import {
  normalizePresenceObservation,
  projectApprovalObservation,
  projectAutomationFailureObservation,
  projectBrowserObservation,
  projectConnectedAccountObservation,
  projectEffectObservation,
  projectJobObservation,
} from './observationProjector';
import type { PresenceAuthority } from './presenceAuthority';
import type { PresenceObservation } from './types';

const parseList = (value: string): string[] => {
  try { return (JSON.parse(value) as unknown[]).filter((entry): entry is string => typeof entry === 'string').slice(0, 20); }
  catch { return []; }
};

export function projectDurablePresenceObservations(db: Database.Database): PresenceObservation[] {
  const observations: PresenceObservation[] = [];
  const hasPresenceSource = (kind: string, identity: string): boolean => Boolean(db.prepare(
    'SELECT 1 FROM presence_items WHERE source_kind=? AND source_identity=? LIMIT 1',
  ).get(kind, identity));

  const approvals = db.prepare(
    `SELECT a.approval_id,a.job_id,a.attempt_id,a.generation,a.state,a.tool_name,a.normalized_execution_plan,a.requested_at,
            COALESCE(a.decided_at,a.invalidated_at,a.executed_at,a.requested_at) AS observed_at,t.workspace_id
       FROM approvals a JOIN tasks t ON t.id=a.job_id
      WHERE a.state IN ('created','displayed')
         OR EXISTS (SELECT 1 FROM presence_items p WHERE p.source_kind='approval' AND p.source_identity=a.approval_id)
      ORDER BY a.requested_at DESC LIMIT 500`,
  ).all() as Array<Record<string, unknown>>;
  for (const value of approvals) observations.push(projectApprovalObservation({
    approvalId: String(value.approval_id), jobId: String(value.job_id), attemptId: String(value.attempt_id),
    generation: Number(value.generation), state: String(value.state), toolName: String(value.tool_name),
    target: String(value.normalized_execution_plan ?? '').slice(0, 160), requestedAt: Number(value.observed_at),
    workspaceId: value.workspace_id === null ? null : String(value.workspace_id),
  }));

  const effects = db.prepare(
    `SELECT se.key,se.job_id,
            CASE WHEN se.reconciliation_required=1 THEN 'reconciliation_required' ELSE se.effect_state END AS effect_state,
            se.target,COALESCE(se.updated_at,se.confirmed_at,se.attempted_at) AS observed_at,t.workspace_id
       FROM side_effect_ledger se LEFT JOIN tasks t ON t.id=se.job_id
      WHERE se.job_id IS NOT NULL AND (
        se.effect_state IN ('unknown','partial','started') OR se.reconciliation_required=1
        OR EXISTS (SELECT 1 FROM presence_items p WHERE p.source_kind='effect' AND p.source_identity=se.key)
      ) ORDER BY observed_at DESC LIMIT 500`,
  ).all() as Array<Record<string, unknown>>;
  for (const value of effects) observations.push(projectEffectObservation({
    effectId: String(value.key), jobId: String(value.job_id), state: String(value.effect_state),
    updatedAt: Number(value.observed_at), target: value.target === null ? null : String(value.target),
    workspaceId: value.workspace_id === null ? null : String(value.workspace_id),
  }));

  const jobs = db.prepare(
    `SELECT id,status,goal,workspace_id,updated_at FROM tasks
      WHERE status IN ('verification_failed','completed_unverified','blocked_unknown','state_unknown','blocked','paused')
         OR EXISTS (SELECT 1 FROM presence_items p WHERE p.source_kind='job' AND p.source_identity=tasks.id)
      ORDER BY updated_at DESC LIMIT 500`,
  ).all() as Array<{ id: string; status: string; goal: string; workspace_id: string | null; updated_at: number }>;
  for (const value of jobs) observations.push(projectJobObservation({
    jobId: value.id, status: value.status, goal: value.goal, workspaceId: value.workspace_id, updatedAt: value.updated_at,
  }));

  const browsers = db.prepare(
    `SELECT browser_session_id,job_id,state,updated_at,workspace_id FROM browser_sessions
      WHERE state IN ('user_control_required','lost')
         OR EXISTS (SELECT 1 FROM presence_items p WHERE p.source_kind='browser' AND p.source_identity=browser_sessions.browser_session_id)
      ORDER BY updated_at DESC LIMIT 200`,
  ).all() as Array<{ browser_session_id: string; job_id: string; state: string; updated_at: number; workspace_id: string | null }>;
  for (const value of browsers) observations.push(projectBrowserObservation({
    browserSessionId: value.browser_session_id, jobId: value.job_id, state: value.state,
    updatedAt: value.updated_at, workspaceId: value.workspace_id,
  }));

  const accounts = db.prepare(
    `SELECT account_id,provider_id,toolkit_id,label,status,health,updated_at,workspace_id,owner_id
       FROM connected_accounts
      WHERE status <> 'active' OR health <> 'healthy'
         OR EXISTS (SELECT 1 FROM presence_items p WHERE p.source_kind='connected_account' AND p.source_identity=connected_accounts.account_id)
      ORDER BY updated_at DESC LIMIT 200`,
  ).all() as Array<Record<string, unknown>>;
  for (const value of accounts) observations.push(projectConnectedAccountObservation({
    accountId: String(value.account_id), providerId: String(value.provider_id), toolkitId: String(value.toolkit_id),
    label: String(value.label), status: String(value.status), health: String(value.health), updatedAt: Number(value.updated_at),
    workspaceId: String(value.workspace_id), ownerId: String(value.owner_id),
  }));

  const automations = db.prepare(
    `SELECT d.automation_id,d.name,d.workspace_id,d.owner_id,o.occurrence_id,o.state,o.updated_at
       FROM automation_definitions d JOIN automation_occurrences o ON o.automation_id=d.automation_id
      ORDER BY d.automation_id,o.updated_at DESC,o.occurrence_id DESC LIMIT 2000`,
  ).all() as Array<{ automation_id: string; name: string; workspace_id: string | null; owner_id: string; occurrence_id: string; state: string; updated_at: number }>;
  const seenAutomation = new Set<string>();
  for (let index = 0; index < automations.length; index += 1) {
    const latest = automations[index]!;
    if (seenAutomation.has(latest.automation_id)) continue;
    seenAutomation.add(latest.automation_id);
    let consecutiveFailures = 0;
    for (const occurrence of automations.slice(index).filter((row) => row.automation_id === latest.automation_id)) {
      if (!['failed', 'blocked', 'unknown'].includes(occurrence.state)) break;
      consecutiveFailures += 1;
    }
    if (consecutiveFailures < 2 && !hasPresenceSource('automation', latest.automation_id)) continue;
    observations.push(projectAutomationFailureObservation({
      automationId: latest.automation_id, name: latest.name, consecutiveFailures,
      lastOccurrenceId: latest.occurrence_id, updatedAt: latest.updated_at,
      workspaceId: latest.workspace_id, ownerId: latest.owner_id,
    }));
  }

  const checkpoints = db.prepare(
    `SELECT checkpoint_id,job_id,workspace_id,validity,blockers_json,proposed_next_json,reason,updated_at
       FROM continuity_checkpoints ORDER BY updated_at DESC LIMIT 300`,
  ).all() as Array<{ checkpoint_id: string; job_id: string; workspace_id: string | null; validity: string; blockers_json: string; proposed_next_json: string; reason: string; updated_at: number }>;
  for (const checkpoint of checkpoints) {
    const blockers = parseList(checkpoint.blockers_json);
    const proposedNext = parseList(checkpoint.proposed_next_json);
    const active = checkpoint.validity === 'current' && (blockers.length > 0 || proposedNext.length > 0);
    if (!active && !hasPresenceSource('continuity', checkpoint.checkpoint_id)) continue;
    observations.push(normalizePresenceObservation({
      sourceKind: 'continuity', sourceIdentity: checkpoint.checkpoint_id,
      sourceRevision: `${checkpoint.validity}:${checkpoint.updated_at}`, initiator: 'SYSTEM',
      workspaceId: checkpoint.workspace_id, jobId: checkpoint.job_id,
      category: blockers.length > 0 ? 'unresolved_gate' : 'next_action', priority: blockers.length > 0 ? 80 : 40,
      title: blockers.length > 0 ? 'Continuation is blocked' : 'A safe next step is ready',
      summary: (blockers[0] ?? proposedNext[0] ?? checkpoint.reason).slice(0, 500),
      reasonCode: blockers.length > 0 ? 'continuity_blocked' : 'continuity_next_step',
      reason: blockers.length > 0 ? 'The current durable checkpoint records an unresolved blocker.' : 'The current durable checkpoint records a proposed next step.',
      recommendedAction: blockers.length > 0 ? 'Review blocker' : 'Review next step', active,
      observedAt: checkpoint.updated_at, payload: { checkpointId: checkpoint.checkpoint_id, blockers, proposedNext },
    }));
  }

  const budgets = db.prepare(
    `SELECT b.job_id,b.kind,b.limit_value,b.used_value,b.has_unknown_usage,b.updated_at,t.workspace_id
       FROM job_budgets b JOIN tasks t ON t.id=b.job_id ORDER BY b.updated_at DESC LIMIT 500`,
  ).all() as Array<{ job_id: string; kind: string; limit_value: number | null; used_value: number; has_unknown_usage: number; updated_at: number; workspace_id: string | null }>;
  for (const budget of budgets) {
    const ratio = budget.limit_value && budget.limit_value > 0 ? budget.used_value / budget.limit_value : 0;
    const active = budget.has_unknown_usage === 1 || ratio >= 0.8;
    if (!active && !hasPresenceSource('budget', `${budget.job_id}:${budget.kind}`)) continue;
    observations.push(normalizePresenceObservation({
      sourceKind: 'budget', sourceIdentity: `${budget.job_id}:${budget.kind}`,
      sourceRevision: `${budget.updated_at}:${budget.used_value}:${budget.has_unknown_usage}`, initiator: 'SYSTEM',
      workspaceId: budget.workspace_id, jobId: budget.job_id, category: 'budget_attention',
      priority: budget.has_unknown_usage === 1 ? 82 : ratio >= 1 ? 85 : 65,
      title: budget.has_unknown_usage === 1 ? 'Usage needs reconciliation' : 'Budget is nearly used',
      summary: budget.limit_value === null ? `${budget.kind} usage is unbounded.` : `${budget.kind}: ${budget.used_value} of ${budget.limit_value}`,
      reasonCode: budget.has_unknown_usage === 1 ? 'budget_usage_unknown' : 'budget_threshold',
      reason: budget.has_unknown_usage === 1 ? 'Durable accounting contains unknown usage.' : 'Durable usage crossed the attention threshold.',
      recommendedAction: active ? 'Review usage' : null, active, observedAt: budget.updated_at,
      payload: { kind: budget.kind, used: budget.used_value, limit: budget.limit_value, unknown: budget.has_unknown_usage === 1 },
    }));
  }

  return observations;
}

export function reconcileDurablePresence(input: {
  db: Database.Database;
  authority: PresenceAuthority;
}): { observed: number; failed: number } {
  let observed = 0;
  let failed = 0;
  for (const observation of projectDurablePresenceObservations(input.db)) {
    try { input.authority.observe(observation); observed += 1; }
    catch { failed += 1; }
  }
  return { observed, failed };
}
