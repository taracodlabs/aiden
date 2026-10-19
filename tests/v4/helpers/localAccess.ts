import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createActionAuthority, normalizeExecutionPlan } from '../../../core/v4/actionAuthority';
import { currentJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';

/** Real approvals for owned wire fixtures; no policy or dispatch mocks. */
export function localAccessFixture(origin: string, capabilities: string[], accountId: string | null = null, principalDigest: string | null = null) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); runMigrations(db);
  db.prepare("INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES ('local-fixture',1,'test',1,1,'test')").run();
  const engine = createJobEngine({ db });
  const admission = engine.submitJob({ entryPoint: 'interactive', source: 'test', sessionId: 'local-session', workspaceId: 'local-workspace', instanceId: 'local-fixture', idempotencyNamespace: 'local', idempotencyKey: 'fixture', goal: 'Use owned local fixture' });
  const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 120000 });
  const job = { jobId: admission.jobId, attemptId: admission.attemptId, generation: 1, fenceToken: lease.fenceToken! };
  engine.transitionAttempt({ ...job, expectedStateVersion: lease.stateVersion!, to: 'running', producer: 'test', eventIdempotencyKey: 'a' });
  engine.transitionJob({ ...job, expectedStateVersion: 0, to: 'running', producer: 'test', eventIdempotencyKey: 'j' });
  const actions = createActionAuthority({ db, jobEngine: engine });
  const expiresAt = Date.now() + 120000;
  const scope = { origin: new URL(origin).origin, workspaceId: 'local-workspace', sessionId: 'local-session', accountId, principalDigest, action: 'owned_fixture', capabilities, expiresAt };
  const normalized = normalizeExecutionPlan({ toolName: scope.action, args: {}, cwd: process.cwd(), mutates: false, riskTier: 'caution', policy: { trustLevel: 'Assistant', autonomyPolicy: 'ask', approvalMode: 'smart', toolMetadataVersion: '1', sandboxPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {}, networkPolicy: { localAccess: scope } } });
  const approval = actions.request({ ...job, toolCallId: 'local-call', toolName: scope.action, riskTier: 'caution', riskReasons: [], normalized, expiresAt });
  actions.decide({ ...job, approvalId: approval.approvalId, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, decision: 'approved', decidedBy: 'fixture-owner', decisionChannel: 'test' });
  const binding = { ...job, approvalId: approval.approvalId, toolCallId: 'local-call', effectId: null, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, workspaceId: scope.workspaceId, sessionId: scope.sessionId, accountId, action: scope.action };
  return { db, engine, actions, binding, policy: normalized.policySnapshot, run: <T>(operation: () => T | Promise<T>) => actions.runWithLocalAccess(binding, operation), close: () => db.close() };
}

export async function withLocalAccess<T>(origin: string, capabilities: string[], operation: () => T | Promise<T>): Promise<T> {
  const fixture = localAccessFixture(origin, capabilities);
  try { return await fixture.run(operation); } finally { fixture.close(); }
}

/** Approve the actual child Job in runtime interop tests. Control/discovery
 * calls outside a child use their own active, explicitly approved fixture Job. */
export async function withRuntimeLocalAccess<T>(db: Database.Database, origin: string, capabilities: string[], operation: () => T | Promise<T>): Promise<T> {
  const current = currentJobExecutionContext();
  if (!current) return withLocalAccess(origin, capabilities, operation);
  const job = current.engine.getJob(current.jobId)!;
  const actions = createActionAuthority({ db, jobEngine: current.engine });
  const expiresAt = Date.now() + 60000;
  const action = 'owned_a2a';
  const normalized = normalizeExecutionPlan({ toolName: action, args: {}, cwd: process.cwd(), mutates: false, riskTier: 'caution', policy: { trustLevel: 'Assistant', autonomyPolicy: 'ask', approvalMode: 'smart', toolMetadataVersion: '1', sandboxPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {}, networkPolicy: { localAccess: { origin: new URL(origin).origin, workspaceId: job.workspaceId, sessionId: job.sessionId, accountId: null, action, capabilities, expiresAt } } } });
  const toolCallId = `local-${crypto.randomUUID()}`;
  const approval = actions.request({ ...current, toolCallId, toolName: action, riskTier: 'caution', riskReasons: [], normalized, expiresAt });
  actions.decide({ ...current, approvalId: approval.approvalId, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, decision: 'approved', decidedBy: 'fixture-owner', decisionChannel: 'test' });
  return actions.runWithLocalAccess({ ...current, approvalId: approval.approvalId, toolCallId, effectId: null, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, workspaceId: job.workspaceId!, sessionId: job.sessionId, accountId: null, action }, operation);
}
