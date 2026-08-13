/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalEngine } from '../../../moat/approvalEngine';
import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { ConnectedAccountAuthority } from '../../../core/v4/integrations/connectedAccountAuthority';
import { FakeIntegrationProvider } from '../../../core/v4/integrations/fakeProvider';
import { IntegrationActionAuthority } from '../../../core/v4/integrations/integrationActionAuthority';
import { IntegrationActionSchemaAuthority } from '../../../core/v4/integrations/integrationActionSchemaAuthority';
import { IntegrationProviderRegistry } from '../../../core/v4/integrations/providerRegistry';
import { IntegrationResolver } from '../../../core/v4/integrations/integrationResolver';
import { SecretAuthority, type SecretBackend } from '../../../core/v4/integrations/secretAuthority';
import { registerIntegrationTools } from '../../../core/v4/integrations/tools';
import { IntegrationProviderError } from '../../../core/v4/integrations/types';

class TestBackend implements SecretBackend {
  readonly id = 'test';
  async protect(value: string) { return Buffer.from(value).toString('base64'); }
  async unprotect(value: string) { return Buffer.from(value, 'base64').toString('utf8'); }
  health() { return { available: true, protectedByOs: true, detail: 'test' }; }
}

let db: Database.Database;
let root: string;
let engine: JobEngine;
let provider: FakeIntegrationProvider;
let actions: IntegrationActionAuthority;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
     VALUES ('integrations',1,'test',1,1,'test')`,
  ).run();
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-integration-execution-'));
  engine = createJobEngine({ db });
  provider = new FakeIntegrationProvider();
  const registry = new IntegrationProviderRegistry();
  registry.register(provider);
  actions = new IntegrationActionAuthority({
    db,
    providers: registry,
    accounts: new ConnectedAccountAuthority({ db }),
    schemas: new IntegrationActionSchemaAuthority({ db }),
    secrets: new SecretAuthority({ db, rootDir: root, backend: new TestBackend() }),
  });
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await rm(root, { recursive: true, force: true });
});

async function connected(label = 'Primary') {
  const start = await actions.initiateConnection({
    providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a', label,
  });
  return actions.completeConnection({
    connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
  });
}

function activeJob(key: string) {
  const admission = engine.submitJob({
    entryPoint: 'test', source: 'test', sessionId: `session-${key}`, instanceId: 'integrations',
    idempotencyNamespace: 'integration-test', idempotencyKey: key, requestFingerprint: key, goal: key,
  });
  const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
  if (!lease.fenceToken || lease.generation === undefined) throw new Error('lease missing');
  engine.transitionAttempt({
    attemptId: admission.attemptId,
    expectedStateVersion: lease.stateVersion!,
    generation: lease.generation,
    fenceToken: lease.fenceToken,
    to: 'running',
    eventIdempotencyKey: `attempt-running-${key}`,
    producer: 'integration-test',
  });
  engine.transitionJob({
    jobId: admission.jobId,
    attemptId: admission.attemptId,
    generation: lease.generation,
    fenceToken: lease.fenceToken,
    expectedStateVersion: 0,
    to: 'running',
    eventIdempotencyKey: `job-running-${key}`,
    producer: 'integration-test',
  });
  return { ...admission, generation: lease.generation, fenceToken: lease.fenceToken };
}

describe('integration action schemas', () => {
  it('rejects provider configuration outside the registered provider boundary', async () => {
    await expect(actions.configureProvider({
      providerId: 'unknown', ownerId: 'owner-a', workspaceId: 'workspace-a', credential: 'must-not-store',
    })).rejects.toThrow(/not (?:registered|available)/i);
    expect(db.prepare('SELECT COUNT(*) FROM integration_secret_handles').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM integration_provider_credentials').pluck().get()).toBe(0);
  });

  it('rejects an unsafe provider authorization URL before persisting a connection session', async () => {
    vi.spyOn(provider, 'initiateConnection').mockResolvedValue({
      connectionId: 'unsafe-connection',
      state: 'pending',
      authorizationUrl: 'javascript:alert(document.domain)',
    });

    await expect(actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).rejects.toMatchObject({ category: 'invalid_input' });
    expect(db.prepare('SELECT COUNT(*) FROM integration_connection_sessions').pluck().get()).toBe(0);
  });

  it('expires a connection session before calling the provider completion boundary', async () => {
    vi.spyOn(provider, 'initiateConnection').mockResolvedValueOnce({
      connectionId: 'expired-connection', state: 'pending', expiresAt: Date.now() - 1,
    });
    const start = await actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    const complete = vi.spyOn(provider, 'completeConnection');

    await expect(actions.completeConnection({
      connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).rejects.toMatchObject({ category: 'auth_expired' });
    expect(complete).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM integration_connection_sessions WHERE connection_id=?')
      .pluck().get(start.connectionId)).toBe('expired');
  });

  it('rejects a provider completion for a different connection identity', async () => {
    const start = await actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    vi.spyOn(provider, 'completeConnection').mockResolvedValueOnce({
      connectionId: 'different-connection',
      providerAccountRef: 'provider-account',
      label: 'Different',
      scopes: [],
    });

    await expect(actions.completeConnection({
      connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).rejects.toMatchObject({ category: 'invalid_input' });
    expect(db.prepare('SELECT COUNT(*) FROM connected_accounts').pluck().get()).toBe(0);
  });

  it('does not persist the short-lived authorization URL or user code', async () => {
    const providerStart = Object.assign({
      connectionId: 'private-authorization', state: 'pending',
      authorizationUrl: 'https://example.invalid/connect?state=short-lived-private-state',
      userCode: 'PRIVATE-CODE',
    } as const, { accessToken: 'must-never-project' });
    vi.spyOn(provider, 'initiateConnection').mockResolvedValueOnce(providerStart);
    const start = await actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    expect(start.authorizationUrl).toContain('short-lived-private-state');
    expect(start.userCode).toBe('PRIVATE-CODE');
    expect((start as unknown as Record<string, unknown>).accessToken).toBeUndefined();
    expect(db.prepare(
      'SELECT authorization_url,user_code FROM integration_connection_sessions WHERE connection_id=?',
    ).get(start.connectionId)).toEqual({ authorization_url: null, user_code: null });
  });

  it('pins exact provider and schema versions and fails closed on same-version drift', async () => {
    const discovered = await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const create = discovered.actions.find((action) => action.actionId === 'create_note')!;
    expect(actions.schemas.requireExact(create)).toMatchObject({
      schemaVersion: '1', providerActionVersion: '2026-01-01', operation: 'mutation',
    });
    expect(() => actions.schemas.pin({
      ...create,
      inputSchema: { ...create.inputSchema, properties: { injected: { type: 'string' } } },
    })).toThrow(/schema drift/i);
  });

  it('rejects an unbounded provider schema before pinning or projection', async () => {
    const page = await provider.discoverActions({ toolkitId: 'projects', limit: 20 });
    vi.spyOn(provider, 'discoverActions').mockResolvedValueOnce({
      actions: [{ ...page.actions[0], inputSchema: { type: 'object', description: 'x'.repeat(70_000) } }],
    });

    await expect(actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 }))
      .rejects.toMatchObject({ category: 'invalid_input' });
  });

  it('rejects unsafe provider action identity and metadata before pinning', async () => {
    const page = await provider.discoverActions({ toolkitId: 'projects', limit: 20 });
    vi.spyOn(provider, 'discoverActions').mockResolvedValueOnce({
      actions: [{
        ...page.actions[0],
        actionId: `unsafe-${'x'.repeat(200)}`,
        label: '\u001b[31munsafe',
      }],
    });

    await expect(actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 }))
      .rejects.toMatchObject({ category: 'invalid_input' });
    expect(actions.schemas.list({ providerId: 'fake', toolkitId: 'projects' })).toEqual([]);
  });
});

describe('integration execution authority', () => {
  it('completes the deterministic multi-account read, deny, approve, reconcile and revoke flow', async () => {
    const personal = await connected('Personal');
    const work = await connected('Work');
    expect(actions.accounts.list({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    }).map(({ label }) => label)).toEqual(['Personal', 'Work']);
    expect(() => actions.accounts.resolve({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).toThrow(/select an exact account/i);

    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('complete-fake-flow');
    const context = {
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    };
    const read = await runWithJobExecutionContext(context, () => actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: personal.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'flow-read',
    }));
    expect(read).toMatchObject({ outcome: 'succeeded', content: { untrustedExternalContent: true } });
    expect(engine.proof.listEvidence(job.jobId)).toHaveLength(1);

    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const mutationArguments = {
        provider_id: 'fake', toolkit_id: 'projects', action_id: 'create_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: personal.accountId,
        input: { projectId: 'project-1', text: 'accepted once' },
    };
    const deny = registry.buildExecutor({
      cwd: root, paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'deny' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    expect((await runWithJobExecutionContext(context, () => deny({
      id: 'flow-denied', name: 'app_action', arguments: { ...mutationArguments, request_id: 'flow-denied' },
    }))).error).toMatch(/denied/i);
    expect(provider.mutationCount()).toBe(0);

    const allow = registry.buildExecutor({
      cwd: root, paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'allow' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    expect((await runWithJobExecutionContext(context, () => allow({
      id: 'flow-approved', name: 'app_action', arguments: { ...mutationArguments, request_id: 'flow-approved' },
    }))).error).toBeUndefined();
    expect(provider.mutationCount()).toBe(1);
    expect(actions.receiptFor('fake', personal.accountId, 'flow-approved')).toMatchObject({ state: 'verified' });
    await runWithJobExecutionContext(context, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: personal.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'accepted once' }, requestId: 'flow-approved',
    }));
    expect(provider.mutationCount()).toBe(1);

    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext(context, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: personal.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'lost response' }, requestId: 'flow-unknown',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    const unknown = actions.receiptFor('fake', personal.accountId, 'flow-unknown')!;
    expect(unknown.state).toBe('unknown');
    expect(provider.mutationCount()).toBe(2);
    await runWithJobExecutionContext(context, () => actions.reconcile({ receiptId: unknown.receiptId }));
    expect(provider.mutationCount()).toBe(2);

    await actions.disconnect({ accountId: personal.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a' });
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: personal.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'flow-revoked',
    })).rejects.toThrow(/revoked/i);
    expect((await actions.refreshAccount({
      accountId: work.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).health).toBe('healthy');
    expect((await actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: work.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'flow-work',
    })).outcome).toBe('succeeded');
  });

  it('keeps the first exact account selection fixed for the lifetime of a Job', async () => {
    const personal = await connected('Personal');
    const work = await connected('Work');
    const resolver = new IntegrationResolver({
      accounts: actions.accounts,
      provider: () => provider,
      discover: (input) => actions.discoverActions(input),
    });
    const job = activeJob('account-binding');
    const context = {
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    };
    await runWithJobExecutionContext(context, () => resolver.resolve({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
      accountId: personal.accountId, intent: 'list projects', maxActions: 3,
    }));

    await expect(runWithJobExecutionContext(context, () => actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: work.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'silent-account-switch',
    }))).rejects.toThrow(/already bound/i);
    expect(db.prepare(
      'SELECT account_id FROM integration_job_account_bindings WHERE job_id=? AND provider_id=? AND toolkit_id=?',
    ).pluck().get(job.jobId, 'fake', 'projects')).toBe(personal.accountId);
  });

  it('namespaces repeated model-facing request labels by durable Effect across Jobs', async () => {
    const account = await connected('Personal');
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const execute = registry.buildExecutor({
      cwd: root, paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'allow' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    const first = activeJob('request-scope-first');
    const second = activeJob('request-scope-second');
    const run = (job: ReturnType<typeof activeJob>, id: string, text: string) => runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => execute({
      id, name: 'app_action', arguments: {
        provider_id: 'fake', toolkit_id: 'projects', action_id: 'create_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: account.accountId,
        input: { projectId: 'project-1', text }, request_id: 'create-note',
      },
    }));

    expect((await run(first, 'first-call', 'first')).error).toBeUndefined();
    expect((await run(second, 'second-call', 'second')).error).toBeUndefined();
    expect(provider.mutationCount()).toBe(2);
    const receipts = db.prepare(
      "SELECT request_id,idempotency_key,effect_id FROM integration_action_receipts WHERE request_id='create-note' ORDER BY created_at,receipt_id",
    ).all() as Array<{ request_id: string; idempotency_key: string; effect_id: string }>;
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.idempotency_key)).size).toBe(2);
    expect(receipts.every((receipt) => receipt.idempotency_key === receipt.effect_id)).toBe(true);
  });

  it('recovers an already-created account when connection completion is replayed after a crash window', async () => {
    const start = await actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a', label: 'Stable',
    });
    const first = await actions.completeConnection({
      connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    db.prepare(
      "UPDATE integration_connection_sessions SET state='pending',completed_account_id=NULL WHERE connection_id=?",
    ).run(start.connectionId);

    const recovered = await actions.completeConnection({
      connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    expect(recovered.accountId).toBe(first.accountId);
    expect(actions.accounts.list({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a', includeRevoked: true,
    })).toHaveLength(1);
  });

  it('records sanitized read Evidence under the exact Job and labels external content untrusted', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('read-evidence');
    const result = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'read-1',
    }));

    expect(result).toMatchObject({
      outcome: 'succeeded',
      content: { untrustedExternalContent: true },
    });
    expect(engine.proof.listEvidence(job.jobId)).toEqual([
      expect.objectContaining({
        source: 'integration.fake.projects.list_projects',
        attemptId: job.attemptId,
        verificationResult: 'unknown',
        payload: expect.objectContaining({ accountId: account.accountId }),
      }),
    ]);
  });

  it('removes provider credentials from projected results and durable Evidence', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const secret = 'provider-secret-value';
    await actions.configureProvider({
      providerId: 'fake', ownerId: 'owner-a', workspaceId: 'workspace-a', credential: secret,
    });
    vi.spyOn(provider, 'execute').mockResolvedValueOnce({
      outcome: 'succeeded',
      result: {
        access_token: secret,
        note: `Bearer ${secret}`,
        credentialEchoUnderOrdinaryKey: secret,
        '\u001b[31munsafe-key': 'safe value',
        visible: 'safe',
      },
    });
    const job = activeJob('secret-evidence');
    const result = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'secret-evidence',
    }));

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('\u001b');
    expect(JSON.stringify(result)).toContain('[redacted]');
    expect(JSON.stringify(engine.proof.listEvidence(job.jobId))).not.toContain(secret);
    expect(JSON.stringify(engine.proof.listEvidence(job.jobId))).not.toContain('\u001b');
  });

  it('requires exact action approval before any external mutation', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const job = activeJob('denied-mutation');
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'deny' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    const before = provider.mutationCount();
    const result = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => execute({
      id: 'mutation-denied', name: 'app_action', arguments: {
        provider_id: 'fake', toolkit_id: 'projects', action_id: 'create_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: account.accountId,
        input: { projectId: 'project-1', text: 'denied' }, request_id: 'mutation-denied',
      },
    }));
    expect(result.error).toMatch(/denied by approval engine/i);
    expect(provider.mutationCount()).toBe(before);
    expect(db.prepare("SELECT state FROM integration_action_receipts WHERE request_id='mutation-denied'").get())
      .toBeUndefined();
  });

  it('commits one approved mutation, performs fresh readback and links Evidence to its Effect', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const job = activeJob('approved-mutation');
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'allow' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    const result = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => execute({
      id: 'mutation-approved', name: 'app_action', arguments: {
        provider_id: 'fake', toolkit_id: 'projects', action_id: 'create_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: account.accountId,
        input: { projectId: 'project-1', text: 'approved' }, request_id: 'mutation-approved',
      },
    }));
    expect(result.error).toBeUndefined();
    expect(provider.mutationCount()).toBe(1);
    expect(db.prepare("SELECT state FROM integration_action_receipts WHERE request_id='mutation-approved'").pluck().get())
      .toBe('verified');
    const evidence = engine.proof.listEvidence(job.jobId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      effectId: expect.any(String), coverage: 'full', verificationResult: 'verified',
      source: 'integration.fake.projects.create_note.readback',
    });
  });

  it('persists a lost response as unknown and reconciles without repeating the mutation', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('lost-response');
    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'recover me' }, requestId: 'lost-response',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(provider.mutationCount()).toBe(1);
    expect(db.prepare("SELECT state FROM integration_action_receipts WHERE request_id='lost-response'").pluck().get())
      .toBe('unknown');

    const reconcile = vi.spyOn(provider, 'reconcile');
    const reconciled = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: actions.receiptFor('fake', account.accountId, 'lost-response')!.receiptId }));
    expect(reconciled.outcome).toBe('succeeded');
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      input: { projectId: 'project-1' },
    }));
    expect(provider.mutationCount()).toBe(1);
    expect(db.prepare("SELECT state FROM integration_action_receipts WHERE request_id='lost-response'").pluck().get())
      .toBe('verified');
  });

  it('reconciles the original durable Effect and links fresh Evidence without a second dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const job = activeJob('effect-reconciliation');
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'allow' }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    provider.failNext('outcome_unknown');
    const initial = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => execute({
      id: 'effect-reconciliation', name: 'app_action', arguments: {
        provider_id: 'fake', toolkit_id: 'projects', action_id: 'create_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: account.accountId,
        input: { projectId: 'project-1', text: 'reconcile original effect' }, request_id: 'effect-reconciliation',
      },
    }));
    expect(initial.error).toMatch(/lost|unknown/i);
    const receipt = db.prepare(
      "SELECT receipt_id,effect_id FROM integration_action_receipts WHERE request_id='effect-reconciliation'",
    ).get() as { receipt_id: string; effect_id: string };
    expect(receipt.effect_id).toMatch(/^side_effect:/);
    expect(db.prepare('SELECT effect_state,reconciliation_required FROM side_effect_ledger WHERE key=?')
      .get(receipt.effect_id)).toMatchObject({ effect_state: 'unknown', reconciliation_required: 1 });

    await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: receipt.receipt_id }));

    expect(provider.mutationCount()).toBe(1);
    expect(db.prepare('SELECT effect_state,reconciliation_required FROM side_effect_ledger WHERE key=?')
      .get(receipt.effect_id)).toMatchObject({ effect_state: 'committed', reconciliation_required: 0 });
    expect(engine.listEffectReconciliations(receipt.effect_id)).toEqual([
      expect.objectContaining({ outcome: 'occurred', humanResolutionRequired: false }),
    ]);
    expect(engine.proof.listEvidence(job.jobId)).toEqual([
      expect.objectContaining({ effectId: receipt.effect_id, verificationResult: 'verified' }),
    ]);
  });

  it('does not classify a reconciliation mismatch as proof that the mutation was not applied', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('reconciliation-mismatch');
    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'mismatched readback' }, requestId: 'reconciliation-mismatch',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    const receipt = actions.receiptFor('fake', account.accountId, 'reconciliation-mismatch')!;
    vi.spyOn(provider, 'reconcile').mockResolvedValueOnce({
      outcome: 'failed', errorCategory: 'verification_failed', safeMessage: 'Fresh state did not match',
    });

    await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: receipt.receiptId }));

    expect(actions.receiptFor('fake', account.accountId, 'reconciliation-mismatch'))
      .toMatchObject({ state: 'unknown' });
    expect(provider.mutationCount()).toBe(1);
  });

  it('rejects a stale Job at the final physical provider dispatch boundary', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('job-dispatch-fence');
    const providerExecute = provider.execute.bind(provider);
    let physicalDispatch = false;
    vi.spyOn(provider, 'execute').mockImplementationOnce(async (request) => {
      engine.cancelJob({
        jobId: job.jobId, reason: 'cancel before provider transport', producer: 'integration-test',
        eventIdempotencyKey: 'cancel-before-provider-transport',
      });
      request.authorizeDispatch?.();
      physicalDispatch = true;
      return providerExecute(request);
    });

    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'must not dispatch' }, requestId: 'job-dispatch-fence',
    }))).rejects.toMatchObject({ category: 'cancelled' });
    expect(physicalDispatch).toBe(false);
    expect(provider.mutationCount()).toBe(0);
    expect(actions.receiptFor('fake', account.accountId, 'job-dispatch-fence')).toMatchObject({ state: 'failed' });
  });

  it('rejects a read result that returns after its Job loses execution authority', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('late-read-result');
    const providerExecute = provider.execute.bind(provider);
    vi.spyOn(provider, 'execute').mockImplementationOnce(async (request) => {
      const result = await providerExecute(request);
      engine.cancelJob({
        jobId: job.jobId, reason: 'cancel while read is in flight', producer: 'integration-test',
        eventIdempotencyKey: 'cancel-late-read-result',
      });
      return result;
    });

    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'late-read-result',
    }))).rejects.toMatchObject({ category: 'cancelled' });
    expect(engine.proof.listEvidence(job.jobId)).toEqual([]);
  });

  it('leaves a mutation unresolved when its provider result returns after Job authority is lost', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('late-mutation-result');
    const providerExecute = provider.execute.bind(provider);
    vi.spyOn(provider, 'execute').mockImplementationOnce(async (request) => {
      const result = await providerExecute(request);
      engine.cancelJob({
        jobId: job.jobId, reason: 'cancel while mutation is in flight', producer: 'integration-test',
        eventIdempotencyKey: 'cancel-late-mutation-result',
      });
      return result;
    });

    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'late result' }, requestId: 'late-mutation-result',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(provider.mutationCount()).toBe(1);
    expect(actions.receiptFor('fake', account.accountId, 'late-mutation-result'))
      .toMatchObject({ state: 'dispatched' });
    expect(engine.proof.listEvidence(job.jobId)).toEqual([]);
  });

  it('does not settle a reconciliation that returns after Job authority is lost', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('late-reconciliation-result');
    provider.failNext('outcome_unknown');
    const context = {
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    };
    await expect(runWithJobExecutionContext(context, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'late reconciliation' }, requestId: 'late-reconciliation-result',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    const receipt = actions.receiptFor('fake', account.accountId, 'late-reconciliation-result')!;
    const providerReconcile = provider.reconcile.bind(provider);
    vi.spyOn(provider, 'reconcile').mockImplementationOnce(async (request) => {
      const result = await providerReconcile(request);
      engine.cancelJob({
        jobId: job.jobId, reason: 'cancel while reconciliation is in flight', producer: 'integration-test',
        eventIdempotencyKey: 'cancel-late-reconciliation-result',
      });
      return result;
    });

    await expect(runWithJobExecutionContext(context, () => actions.reconcile({ receiptId: receipt.receiptId })))
      .rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(actions.receiptFor('fake', account.accountId, 'late-reconciliation-result'))
      .toMatchObject({ state: 'reconciling' });
    expect(engine.proof.listEvidence(job.jobId)).toEqual([]);
  });

  it('reopens a durable unknown receipt and reconciles it without repeating the mutation', async () => {
    db.close();
    const databasePath = path.join(root, 'integration-restart.sqlite');
    db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('integrations',1,'test',1,1,'test')`,
    ).run();
    engine = createJobEngine({ db });
    provider = new FakeIntegrationProvider();
    const initialRegistry = new IntegrationProviderRegistry();
    initialRegistry.register(provider);
    actions = new IntegrationActionAuthority({
      db,
      providers: initialRegistry,
      accounts: new ConnectedAccountAuthority({ db }),
      schemas: new IntegrationActionSchemaAuthority({ db }),
      secrets: new SecretAuthority({ db, rootDir: root, backend: new TestBackend() }),
    });

    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('restart-lost-response');
    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'survive restart' }, requestId: 'restart-lost-response',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(provider.mutationCount()).toBe(1);

    db.close();
    db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    engine = createJobEngine({ db });
    const reopenedRegistry = new IntegrationProviderRegistry();
    reopenedRegistry.register(provider);
    actions = new IntegrationActionAuthority({
      db,
      providers: reopenedRegistry,
      accounts: new ConnectedAccountAuthority({ db }),
      schemas: new IntegrationActionSchemaAuthority({ db }),
      secrets: new SecretAuthority({ db, rootDir: root, backend: new TestBackend() }),
    });
    const receipt = actions.receiptFor('fake', account.accountId, 'restart-lost-response')!;

    const reconciled = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: receipt.receiptId }));

    expect(reconciled.outcome).toBe('succeeded');
    expect(provider.mutationCount()).toBe(1);
    expect(actions.receiptFor('fake', account.accountId, 'restart-lost-response'))
      .toMatchObject({ state: 'verified' });
  });

  it('revalidates connected-account authority at the physical reconciliation boundary', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('reconcile-revoke-race');
    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'must fence reconciliation' }, requestId: 'reconcile-revoke-race',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    const receipt = actions.receiptFor('fake', account.accountId, 'reconcile-revoke-race')!;
    const providerReconcile = provider.reconcile.bind(provider);
    let physicalReconciliation = false;
    vi.spyOn(provider, 'reconcile').mockImplementationOnce(async (request) => {
      actions.accounts.revoke(account.accountId, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
      request.authorizeDispatch?.();
      physicalReconciliation = true;
      return providerReconcile(request);
    });

    await expect(runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: receipt.receiptId })))
      .rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(physicalReconciliation).toBe(false);
    expect(provider.mutationCount()).toBe(1);
    expect(actions.receiptFor('fake', account.accountId, 'reconcile-revoke-race'))
      .toMatchObject({ state: 'unknown' });
  });

  it('does not let a different Job reconcile or claim Evidence for an existing receipt', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const owner = activeJob('receipt-owner');
    provider.failNext('outcome_unknown');
    await expect(runWithJobExecutionContext({
      engine, jobId: owner.jobId, attemptId: owner.attemptId, generation: owner.generation,
      fenceToken: owner.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'owned receipt' }, requestId: 'owned-receipt',
    }))).rejects.toMatchObject({ category: 'outcome_unknown' });
    const receipt = actions.receiptFor('fake', account.accountId, 'owned-receipt')!;
    const foreign = activeJob('receipt-foreign');
    const reconcile = vi.spyOn(provider, 'reconcile');

    await expect(runWithJobExecutionContext({
      engine, jobId: foreign.jobId, attemptId: foreign.attemptId, generation: foreign.generation,
      fenceToken: foreign.fenceToken, producer: 'integration-test',
    }, () => actions.reconcile({ receiptId: receipt.receiptId })))
      .rejects.toMatchObject({ category: 'permission_denied' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(actions.receiptFor('fake', account.accountId, 'owned-receipt')).toMatchObject({ state: 'unknown' });
    expect(engine.proof.listEvidence(foreign.jobId)).toEqual([]);
  });

  it('keeps malformed post-dispatch provider results unknown and accepts an empty successful result safely', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    vi.spyOn(provider, 'execute').mockResolvedValueOnce({
      outcome: 'succeeded', result: { body: 'x'.repeat(1_000_001) },
    });
    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'oversized' }, requestId: 'oversized-result',
    })).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(actions.receiptFor('fake', account.accountId, 'oversized-result')).toMatchObject({ state: 'unknown' });

    vi.spyOn(provider, 'execute').mockResolvedValueOnce({ outcome: 'succeeded', externalRef: 'empty-result' });
    vi.spyOn(provider, 'readback').mockResolvedValueOnce({
      outcome: 'succeeded', externalRef: 'empty-result', result: { exists: true },
    });
    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'empty result' }, requestId: 'empty-result',
    })).resolves.toMatchObject({ outcome: 'succeeded', content: { verification: 'verified' } });
    expect(actions.receiptFor('fake', account.accountId, 'empty-result')).toMatchObject({ state: 'verified' });
  });

  it('blocks secret-shaped arguments and stale action schemas before provider dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: { api_key: 'must-not-pass' }, requestId: 'secret-input',
    })).rejects.toMatchObject({ category: 'invalid_input' });

    provider.driftSchema('2');
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'stale-schema',
    })).rejects.toMatchObject({ category: 'schema_drift' });
  });

  it('rejects unsafe action identity before approval preview, persistence or provider dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const registry = new ToolRegistry();
    registerIntegrationTools(registry, actions, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    const promptUser = vi.fn(async () => 'allow' as const);
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: root }),
      approvalEngine: new ApprovalEngine('manual', { promptUser }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    });
    const providerExecute = vi.spyOn(provider, 'execute');
    const result = await execute({
      id: 'unsafe-action-identity',
      name: 'app_action',
      arguments: {
        provider_id: 'fake', toolkit_id: 'projects', action_id: '\u001b[31mcreate_note',
        schema_version: '1', provider_action_version: '2026-01-01', account_id: account.accountId,
        input: { projectId: 'project-1', text: 'unsafe' }, request_id: 'unsafe-action-identity',
      },
    });
    expect(result.error).toMatch(/invalid arguments.*action identity/i);
    expect(promptUser).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(actions.receiptFor('fake', account.accountId, 'unsafe-action-identity')).toBeNull();
  });

  it('validates exact action arguments before provider dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const execute = vi.spyOn(provider, 'execute');

    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1' }, requestId: 'missing-required-field',
    })).rejects.toMatchObject({ category: 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
    expect(actions.receiptFor('fake', account.accountId, 'missing-required-field')).toBeNull();
  });

  it('records a readback mismatch as failed verification without claiming success', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const job = activeJob('readback-mismatch');
    vi.spyOn(provider, 'readback').mockResolvedValueOnce({
      outcome: 'failed', errorCategory: 'verification_failed', safeMessage: 'Fresh state did not match',
    });
    const result = await runWithJobExecutionContext({
      engine, jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, producer: 'integration-test',
    }, () => actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'must verify' }, requestId: 'readback-mismatch',
    }));

    expect(result.content.verification).toBe('failed');
    expect(engine.proof.listEvidence(job.jobId)).toEqual([
      expect.objectContaining({ verificationResult: 'failed', coverage: 'full' }),
    ]);
    expect(db.prepare(
      "SELECT state,error_category,settled_at FROM integration_action_receipts WHERE request_id='readback-mismatch'",
    ).get()).toMatchObject({ state: 'succeeded', error_category: 'verification_failed', settled_at: expect.any(Number) });
  });

  it('blocks provider outage before dispatch and normalizes account authentication expiry', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const execute = vi.spyOn(provider, 'execute');
    provider.setAvailable(false);
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'provider-outage',
    })).rejects.toMatchObject({ category: 'provider_unavailable' });
    expect(execute).not.toHaveBeenCalled();

    provider.setAvailable(true);
    provider.failNext('auth_expired');
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'auth-expired',
    })).rejects.toMatchObject({ category: 'auth_expired' });
  });

  it('persists expired and insufficient-scope account health without exposing provider errors', async () => {
    const expired = await connected('Expired');
    vi.spyOn(provider, 'refreshAccount').mockRejectedValueOnce(
      new IntegrationProviderError('auth_expired', 'private provider auth detail'),
    );
    expect(await actions.refreshAccount({
      accountId: expired.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).toMatchObject({ status: 'expired', health: 'expired' });

    const insufficient = await connected('Insufficient');
    vi.spyOn(provider, 'refreshAccount').mockRejectedValueOnce(
      new IntegrationProviderError('permission_denied', 'private scope detail'),
    );
    expect(await actions.refreshAccount({
      accountId: insufficient.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).toMatchObject({ status: 'degraded', health: 'insufficient_scope' });
  });

  it('blocks non-actionable account health before provider dispatch', async () => {
    const connecting = actions.accounts.create({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: 'Connecting', providerAccountRef: 'provider-connecting', status: 'connecting', health: 'unknown',
    });
    const insufficient = await connected('Insufficient action');
    actions.accounts.updateHealth({
      accountId: insufficient.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
      status: 'degraded', health: 'insufficient_scope',
    });
    await actions.discoverActions({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a', limit: 20,
    });
    const execute = vi.spyOn(provider, 'execute');

    for (const account of [connecting, insufficient]) {
      await expect(actions.executeRead({
        providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
        schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
        ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: `blocked-${account.accountId}`,
      })).rejects.toThrow(/not actionable|connecting|access|reconnect/i);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes read timeouts and never creates a mutation receipt before dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const timeout = Object.assign(new Error('private transport timeout'), { code: 'ETIMEDOUT' });
    vi.spyOn(provider, 'execute').mockRejectedValueOnce(timeout);
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'read-timeout',
    })).rejects.toMatchObject({ category: 'timeout', message: 'Integration timeout' });
    expect(actions.receiptFor('fake', account.accountId, 'read-timeout')).toBeNull();
  });

  it('normalizes rate limits without leaking provider payloads', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    provider.failNext('rate_limited');
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'rate-limit',
    })).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 1_000 });
  });

  it('cancels before mutation dispatch without creating a receipt or calling the provider', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const controller = new AbortController();
    controller.abort();
    const execute = vi.spyOn(provider, 'execute');

    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', signal: controller.signal,
      input: { projectId: 'project-1', text: 'cancelled' }, requestId: 'cancel-before-dispatch',
    })).rejects.toMatchObject({ category: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
    expect(actions.receiptFor('fake', account.accountId, 'cancel-before-dispatch')).toBeNull();
  });

  it('records cancellation after the mutation dispatch boundary as an unknown outcome', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    vi.spyOn(provider, 'execute').mockRejectedValueOnce(
      new IntegrationProviderError('cancelled', 'request interrupted'),
    );

    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'uncertain' }, requestId: 'cancel-after-dispatch',
    })).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(actions.receiptFor('fake', account.accountId, 'cancel-after-dispatch')).toMatchObject({ state: 'unknown' });
  });

  it('treats a transport outage after mutation dispatch as an unknown outcome', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    vi.spyOn(provider, 'execute').mockRejectedValueOnce(
      new IntegrationProviderError('provider_unavailable', 'connection dropped after dispatch'),
    );

    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'uncertain transport' }, requestId: 'transport-after-dispatch',
    })).rejects.toMatchObject({ category: 'outcome_unknown' });
    expect(actions.receiptFor('fake', account.accountId, 'transport-after-dispatch'))
      .toMatchObject({ state: 'unknown' });
  });

  it('persists revocation before provider cleanup and blocks a planned action before dispatch', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const execute = vi.spyOn(provider, 'execute');
    await actions.disconnect({ accountId: account.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a' });
    await expect(actions.executeRead({
      providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a', input: {}, requestId: 'revoked-plan',
    })).rejects.toThrow(/revoked/i);
    expect(execute).not.toHaveBeenCalled();

    const second = await connected('Cleanup failure');
    vi.spyOn(provider, 'revokeAccount').mockRejectedValueOnce(new Error('remote unavailable'));
    await expect(actions.disconnect({
      accountId: second.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).rejects.toMatchObject({ category: 'provider_unavailable', message: 'Integration provider unavailable' });
    expect(actions.accounts.require(second.accountId).status).toBe('revoked');
  });

  it('revalidates connected-account authority at the physical provider dispatch boundary', async () => {
    const account = await connected();
    await actions.discoverActions({ providerId: 'fake', toolkitId: 'projects', limit: 20 });
    const executeProvider = provider.execute.bind(provider);
    vi.spyOn(provider, 'execute').mockImplementationOnce(async (request) => {
      actions.accounts.revoke(account.accountId, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
      return executeProvider(request);
    });

    await expect(actions.executeMutation({
      providerId: 'fake', toolkitId: 'projects', actionId: 'create_note',
      schemaVersion: '1', providerActionVersion: '2026-01-01', accountId: account.accountId,
      ownerId: 'owner-a', workspaceId: 'workspace-a',
      input: { projectId: 'project-1', text: 'must not dispatch' }, requestId: 'revoke-race',
    })).rejects.toMatchObject({ category: 'account_not_found' });
    expect(provider.mutationCount()).toBe(0);
    expect(actions.receiptFor('fake', account.accountId, 'revoke-race')).toMatchObject({ state: 'failed' });
  });

  it('removes local credential and hosted-auth references when an account is disconnected', async () => {
    const start = await actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: 'Credential account',
    });
    vi.spyOn(provider, 'completeConnection').mockResolvedValueOnce({
      connectionId: start.connectionId,
      providerAccountRef: 'provider-credential-account',
      label: 'Credential account',
      scopes: ['projects:read'],
      hostedAuthRef: 'hosted-private-reference',
      secretValue: 'private-account-credential',
    });
    const account = await actions.completeConnection({
      connectionId: start.connectionId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    expect(account.secretHandle).toMatch(/^secret_/);
    expect(account.hostedAuthRef).toBe('hosted-private-reference');

    const revoked = await actions.disconnect({
      accountId: account.accountId, ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    expect(revoked).toMatchObject({ status: 'revoked', health: 'revoked', secretHandle: null, hostedAuthRef: null });
    expect(actions.secrets.exists(account.secretHandle!)).toBe(false);
    expect(JSON.stringify(db.prepare('SELECT * FROM integration_secret_handles').all()))
      .not.toContain('private-account-credential');
  });
});
