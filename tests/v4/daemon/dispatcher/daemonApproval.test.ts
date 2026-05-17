/**
 * v4.5 Phase 7 — daemon approval policy tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../../core/v4/daemon/runStore';
import {
  buildDaemonApprovalCallbacks,
  decideForPolicy,
  isDaemonApprovalPolicy,
} from '../../../../core/v4/daemon/dispatcher/daemonApproval';
import type { ApprovalRequest } from '../../../../moat/approvalEngine';

let db: Database.Database;
let runStore: ReturnType<typeof createRunStore>;
let runId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.5.0');
  runStore = createRunStore({ db });
  runId = runStore.create({ sessionId: 's', instanceId: 'inst-1', status: 'running' });
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function mkReq(tier: 'safe' | 'caution' | 'dangerous', name = 'tool_x'): ApprovalRequest {
  return { toolName: name, category: 'write', args: {}, riskTier: tier };
}

describe('decideForPolicy — pure decision table', () => {
  it('safe-only: safe→allow, caution+dangerous→deny', () => {
    expect(decideForPolicy('safe-only', 'safe')).toBe('allow_session');
    expect(decideForPolicy('safe-only', 'caution')).toBe('deny');
    expect(decideForPolicy('safe-only', 'dangerous')).toBe('deny');
  });

  it('caution-ok: safe+caution→allow, dangerous→deny', () => {
    expect(decideForPolicy('caution-ok', 'safe')).toBe('allow_session');
    expect(decideForPolicy('caution-ok', 'caution')).toBe('allow_session');
    expect(decideForPolicy('caution-ok', 'dangerous')).toBe('deny');
  });

  it('dangerous-ok: all tiers→allow', () => {
    expect(decideForPolicy('dangerous-ok', 'safe')).toBe('allow_session');
    expect(decideForPolicy('dangerous-ok', 'caution')).toBe('allow_session');
    expect(decideForPolicy('dangerous-ok', 'dangerous')).toBe('allow_session');
  });
});

describe('buildDaemonApprovalCallbacks — promptUser + onDecision', () => {
  it('promptUser auto-decides per policy', async () => {
    const cb = buildDaemonApprovalCallbacks({ policy: 'safe-only', runStore, runId });
    expect(await cb.promptUser!(mkReq('safe'))).toBe('allow_session');
    expect(await cb.promptUser!(mkReq('caution'))).toBe('deny');
    expect(await cb.promptUser!(mkReq('dangerous'))).toBe('deny');
  });

  it('onDecision emits approval_decision run_event with policy', () => {
    const cb = buildDaemonApprovalCallbacks({ policy: 'caution-ok', runStore, runId });
    cb.onDecision!(mkReq('caution', 'file_write'), 'allow_session');
    cb.onDecision!(mkReq('dangerous', 'shell_exec'), 'deny');
    const events = runStore.listEvents(runId);
    expect(events).toHaveLength(2);
    const p0 = JSON.parse(events[0].payload);
    expect(p0.toolName).toBe('file_write');
    expect(p0.decision).toBe('allow_session');
    expect(p0.policy).toBe('caution-ok');
    expect(p0.riskTier).toBe('caution');
    const p1 = JSON.parse(events[1].payload);
    expect(p1.toolName).toBe('shell_exec');
    expect(p1.decision).toBe('deny');
  });
});

describe('isDaemonApprovalPolicy — type guard', () => {
  it('accepts the three valid policies + rejects others', () => {
    expect(isDaemonApprovalPolicy('safe-only')).toBe(true);
    expect(isDaemonApprovalPolicy('caution-ok')).toBe(true);
    expect(isDaemonApprovalPolicy('dangerous-ok')).toBe(true);
    expect(isDaemonApprovalPolicy('off')).toBe(false);
    expect(isDaemonApprovalPolicy('')).toBe(false);
  });
});
