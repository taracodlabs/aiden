import http from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createActionAuthority, normalizeExecutionPlan } from '../../../core/v4/actionAuthority';
import { secureFetch } from '../../../moat/secureFetch';
import { SSRFProtection } from '../../../moat/ssrfProtection';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { localAccessFixture } from '../helpers/localAccess';
import { networkPrincipalDigest } from '../../../core/v4/localNetworkContext';

describe('durable local network approval at dispatch', () => {
  let db: Database.Database;
  let server: http.Server;
  let origin: string;
  let requests: number;
  let connections: number;
  let actions: ReturnType<typeof createActionAuthority>;
  let binding: any;
  beforeEach(async () => {
    requests = connections = 0;
    server = http.createServer((_req, res) => { requests++; res.end('owned-marker'); });
    server.on('connection', () => connections++);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON'); runMigrations(db);
    db.prepare("INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES ('i',1,'test',1,1,'test')").run();
    const jobs = createJobEngine({ db });
    const admission = jobs.submitJob({ entryPoint: 'interactive', source: 'test', sessionId: 's', workspaceId: 'w', instanceId: 'i', idempotencyNamespace: 'test', idempotencyKey: 'grant', goal: 'local read' });
    const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60000 });
    const job = { jobId: admission.jobId, attemptId: admission.attemptId, generation: 1, fenceToken: lease.fenceToken! };
    jobs.transitionAttempt({ ...job, expectedStateVersion: lease.stateVersion!, to: 'running', producer: 'test', eventIdempotencyKey: 'a' });
    jobs.transitionJob({ ...job, expectedStateVersion: 0, to: 'running', producer: 'test', eventIdempotencyKey: 'j' });
    actions = createActionAuthority({ db, jobEngine: jobs });
    const normalized = normalizeExecutionPlan({ toolName: 'local_read', args: {}, cwd: process.cwd(), mutates: false, riskTier: 'caution', policy: {
      trustLevel: 'Assistant', autonomyPolicy: 'ask', approvalMode: 'smart', toolMetadataVersion: '1', sandboxPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
      networkPolicy: { localAccess: { workspaceId: 'w', sessionId: 's', accountId: null, origin, action: 'local_read', capabilities: ['http:GET'], expiresAt: Date.now() + 60000 } },
    } });
    const approval = actions.request({ ...job, toolCallId: 'tc', toolName: 'local_read', riskTier: 'caution', riskReasons: [], normalized, expiresAt: Date.now() + 60000 });
    actions.decide({ ...job, approvalId: approval.approvalId, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, decision: 'approved', decidedBy: 'owner', decisionChannel: 'test' });
    binding = { ...job, approvalId: approval.approvalId, toolCallId: 'tc', effectId: null, actionDigest: approval.actionDigest, policySnapshotId: approval.policySnapshotId, workspaceId: 'w', sessionId: 's', accountId: null, action: 'local_read' };
  });
  afterEach(async context => {
    console.log(JSON.stringify({ gate: context.task.name, observedRequests: requests, observedConnections: connections }));
    db?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const fetchLocal = (url: string) => secureFetch(url, {}, { allowLoopbackOrigin: new URL(url).origin });
  it('rejects the old origin-only exception with zero egress', async () => {
    await expect(fetchLocal(origin)).rejects.toThrow();
    expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
  });
  it('correct approved Job and explicitly authorized localhost succeed', async () => {
    const response = await actions.runWithLocalAccess(binding, () => fetchLocal(origin));
    expect(await response.text()).toBe('owned-marker');
    expect({ requests, connections }).toEqual({ requests: 1, connections: 1 });
  });
  for (const [label, patch] of Object.entries({ forged: { approvalId: 'forged' }, job: { jobId: 'other' }, workspace: { workspaceId: 'other' }, action: { action: 'other' }, session: { sessionId: 'other' }, account: { accountId: 'other' }, fence: { fenceToken: 'other' } })) {
    it(`rejects ${label} with zero egress`, async () => {
      await expect(Promise.resolve().then(() => actions.runWithLocalAccess({ ...binding, ...patch }, () => fetchLocal(origin)))).rejects.toThrow();
      expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
    });
  }
  for (const target of ['origin', 'port', 'capability', 'expiry', 'revoked', 'cached']) {
    it(`rejects ${target} with zero egress`, async () => {
      if (target === 'expiry') db.prepare('UPDATE approvals SET expires_at = 1').run();
      if (target === 'revoked' || target === 'cached') actions.invalidate(binding.approvalId, 'owner revoked');
      const url = target === 'origin' ? origin.replace('127.0.0.1', 'localhost') : target === 'port' ? 'http://127.0.0.1:1' : origin;
      await expect(Promise.resolve().then(() => actions.runWithLocalAccess({ ...binding }, () => target === 'capability'
        ? secureFetch(url, { method: 'POST' }, { allowLoopbackOrigin: new URL(url).origin }) : fetchLocal(url)))).rejects.toThrow();
      expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
    });
  }
  it('rejects a nested different Job even when the original grant object is reused', async () => {
    await expect(actions.runWithLocalAccess(binding, () => runWithJobExecutionContext({
      ...binding, jobId: 'another-job', producer: 'test', engine: {} as never,
    }, () => fetchLocal(origin)))).rejects.toThrow(/another Job/);
    expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
  });
  it('rechecks revocation after asynchronous destination resolution', async () => {
    const localhost = origin.replace('127.0.0.1', 'localhost');
    db.prepare("UPDATE policy_snapshots SET network_policy_json=json_set(network_policy_json,'$.localAccess.origin',?)").run(localhost);
    const policy = new SSRFProtection(async () => {
      actions.invalidate(binding.approvalId, 'revoked during DNS');
      return [{ address: '127.0.0.1', family: 4 }];
    });
    await expect(actions.runWithLocalAccess(binding, () => secureFetch(localhost, {}, { allowLoopbackOrigin: localhost, policy }))).rejects.toThrow(/revoked/);
    expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
  });
  it('does not let a detached stale async context outlive the approved operation', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let stale!: Promise<Response>;
    await actions.runWithLocalAccess(binding, () => { stale = barrier.then(() => fetchLocal(origin)); });
    release();
    await expect(stale).rejects.toThrow(/live durable approval/);
    expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
  });
  it('carries a real read-only tool approval through the durable dispatcher to the socket', async () => {
    const fixture = localAccessFixture(origin, ['http:GET']);
    let approvals = 0;
    try {
      const registry = new ToolRegistry();
      registry.register({ schema: { name: 'owned_fixture', description: 'Read owned marker', inputSchema: { type: 'object' } }, category: 'network', toolset: 'misc', mutates: false,
        execute: async () => (await fetchLocal(origin)).text(),
      });
      const execute = registry.buildExecutor({ cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: process.cwd() }),
        actionAuthority: fixture.actions, policySnapshot: fixture.policy,
        approvalEngine: new ApprovalEngine('manual', { promptUser: async () => { approvals++; return 'allow'; } }),
      });
      const result = await runWithJobExecutionContext({ ...fixture.binding, engine: fixture.engine, producer: 'test' }, () => execute({ id: 'dispatcher-read', name: 'owned_fixture', arguments: {} }));
      expect(result.error).toBeUndefined();
      expect(result.result).toBe('owned-marker');
      expect(approvals).toBe(1);
      expect({ requests, connections }).toEqual({ requests: 1, connections: 1 });
    } finally { fixture.close(); }
  });
  it('re-created authority instances cannot revive an invalidated saved grant', async () => {
    const fixture = localAccessFixture(origin, ['http:GET']);
    try {
      const saved = { ...fixture.binding };
      fixture.actions.invalidate(saved.approvalId, 'owner revoked');
      const recreated = createActionAuthority({ db: fixture.db, jobEngine: fixture.engine });
      await expect(recreated.runWithLocalAccess(saved, () => fetchLocal(origin))).rejects.toThrow(/revoked/);
      expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
    } finally { fixture.close(); }
  });
  it('checks a bound connected account live and rejects its subsequent revocation', async () => {
    const fixture = localAccessFixture(origin, ['http:GET'], 'owned-account');
    try {
      const b = fixture.binding;
      fixture.db.prepare(`INSERT INTO connected_accounts (account_id,provider_id,toolkit_id,owner_id,workspace_id,label,provider_account_ref,status,health,created_at,updated_at)
        VALUES ('owned-account','fixture','fixture','owner',?,'Owned account','owned','active','healthy',1,1)`).run(b.workspaceId);
      fixture.db.prepare(`INSERT INTO integration_job_account_bindings (job_id,provider_id,toolkit_id,account_id,owner_id,workspace_id,bound_attempt_id,bound_generation,created_at)
        VALUES (?,'fixture','fixture','owned-account','owner',?,?,?,1)`).run(b.jobId,b.workspaceId,b.attemptId,b.generation);
      await fixture.run(async () => {
        expect(await (await fetchLocal(origin)).text()).toBe('owned-marker');
        const before = { requests, connections };
        fixture.db.prepare("UPDATE connected_accounts SET status='revoked',revoked_at=1 WHERE account_id='owned-account'").run();
        await expect(fetchLocal(origin)).rejects.toThrow(/account authority/);
        expect({ requests, connections }).toEqual(before);
      });
    } finally { fixture.close(); }
  });
  it('binds an authenticated local request to its approved credential principal', async () => {
    const headers = new Headers({ authorization: 'Bearer owned-synthetic-session' });
    const fixture = localAccessFixture(origin, ['http:GET'], null, networkPrincipalDigest(headers));
    try {
      await fixture.run(async () => {
        expect(await (await secureFetch(origin, { headers }, { allowLoopbackOrigin: origin })).text()).toBe('owned-marker');
        const before = { requests, connections };
        await expect(secureFetch(origin, { headers: { authorization: 'Bearer another-synthetic-session' } }, { allowLoopbackOrigin: origin })).rejects.toThrow(/scope/);
        await expect(fetchLocal(origin)).rejects.toThrow(/scope/);
        expect({ requests, connections }).toEqual(before);
      });
    } finally { fixture.close(); }
  });
});
