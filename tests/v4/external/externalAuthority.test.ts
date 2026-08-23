/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createExternalAuthority } from '../../../core/v4/external/externalAuthority';

describe('shared external identity and remote-task authority', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('binds trust to one canonical endpoint and fails closed on key rotation', () => {
    const authority = createExternalAuthority({ db });
    const first = authority.observeIdentity({
      kind: 'a2a',
      endpoint: 'https://agents.example.test/a2a/',
      displayName: 'Repository reader',
      identityKeyDigest: 'a'.repeat(64),
      now: 10,
    });
    expect(first.canonicalEndpoint).toBe('https://agents.example.test/a2a');
    expect(first.trustState).toBe('unverified');

    const verified = authority.setTrust({
      externalIdentityId: first.externalIdentityId,
      expectedStateVersion: first.stateVersion,
      to: 'verified_key',
      expectedIdentityKeyDigest: 'a'.repeat(64),
      now: 20,
    });
    expect(verified.trustState).toBe('verified_key');

    const rotated = authority.observeIdentity({
      kind: 'a2a',
      endpoint: 'https://agents.example.test/a2a',
      displayName: 'Repository reader',
      identityKeyDigest: 'b'.repeat(64),
      now: 30,
    });
    expect(rotated.trustState).toBe('changed');
    expect(authority.canUseMutation(rotated.externalIdentityId)).toBe(false);
  });

  it('persists capability drift and requires review when mutation authority changes', () => {
    const authority = createExternalAuthority({ db });
    const identity = authority.observeIdentity({
      kind: 'mcp', endpoint: 'https://mcp.example.test/service', displayName: 'Files', now: 1,
    });
    const trusted = authority.setTrust({
      externalIdentityId: identity.externalIdentityId,
      expectedStateVersion: identity.stateVersion,
      to: 'verified_endpoint',
      now: 2,
    });

    const readOnly = authority.recordCapabilities({
      externalIdentityId: trusted.externalIdentityId,
      protocol: 'mcp',
      protocolVersion: '2025-11-25',
      capabilityDigest: '1'.repeat(64),
      readCapabilityDigest: '2'.repeat(64),
      mutationCapabilityDigest: '3'.repeat(64),
      capabilities: { tools: ['read_file'] },
      idempotencyKey: 'caps:1',
      now: 3,
    });
    expect(readOnly.changeClass).toBe('initial');
    expect(readOnly.reviewRequired).toBe(true);
    const accepted = authority.acceptCapabilities({
      capabilitySnapshotId: readOnly.capabilitySnapshotId,
      expectedStateVersion: readOnly.stateVersion,
      acceptedBy: 'local-user',
      now: 4,
    });
    expect(accepted.reviewRequired).toBe(false);
    expect(authority.canUseMutation(identity.externalIdentityId)).toBe(true);

    const duplicate = authority.recordCapabilities({
      externalIdentityId: trusted.externalIdentityId,
      protocol: 'mcp', protocolVersion: '2025-11-25', capabilityDigest: '1'.repeat(64),
      readCapabilityDigest: '2'.repeat(64), mutationCapabilityDigest: '3'.repeat(64),
      capabilities: { tools: ['read_file'] }, idempotencyKey: 'caps:1', now: 5,
    });
    expect(duplicate.capabilitySnapshotId).toBe(readOnly.capabilitySnapshotId);

    const drift = authority.recordCapabilities({
      externalIdentityId: trusted.externalIdentityId,
      protocol: 'mcp', protocolVersion: '2025-11-25', capabilityDigest: '4'.repeat(64),
      readCapabilityDigest: '2'.repeat(64), mutationCapabilityDigest: '5'.repeat(64),
      capabilities: { tools: ['read_file', 'write_file'] }, idempotencyKey: 'caps:2', now: 6,
    });
    expect(drift.changeClass).toBe('mutation');
    expect(drift.reviewRequired).toBe(true);
    expect(authority.canUseMutation(identity.externalIdentityId)).toBe(false);
  });

  it('rejects oversized identity and capability metadata before durable storage', () => {
    const authority = createExternalAuthority({ db });
    expect(() => authority.observeIdentity({
      kind: 'mcp', endpoint: `https://mcp.example.test/${'x'.repeat(2_100)}`,
      displayName: 'Bounded endpoint', now: 1,
    })).toThrow(/endpoint.*limit/i);
    expect(() => authority.observeIdentity({
      kind: 'mcp', endpoint: 'https://mcp.example.test/service',
      displayName: 'x'.repeat(300), now: 1,
    })).toThrow(/display name.*limit/i);

    const identity = authority.observeIdentity({
      kind: 'mcp', endpoint: 'https://mcp.example.test/service', displayName: 'Files', now: 2,
    });
    expect(() => authority.recordCapabilities({
      externalIdentityId: identity.externalIdentityId,
      protocol: 'mcp', protocolVersion: '2025-11-25',
      capabilityDigest: '1'.repeat(64), readCapabilityDigest: '2'.repeat(64),
      mutationCapabilityDigest: '3'.repeat(64),
      capabilities: { untrusted: 'x'.repeat(1_100_000) },
      idempotencyKey: 'caps:oversized', now: 3,
    })).toThrow(/capability metadata.*limit/i);
  });

  it('keeps remote observations subordinate to exact local Job authority', () => {
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('instance-external',1,'localhost',1,1,'4.20.0')`,
    ).run();
    const engine = createJobEngine({ db });
    const admitted = engine.submitJob({
      entryPoint: 'a2a', source: 'external-authority-test', sessionId: 'session-external',
      instanceId: 'instance-external', idempotencyNamespace: 'a2a-test',
      idempotencyKey: 'local-job', requestFingerprint: 'local-job-v1', goal: 'Read the repository',
    });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'external-test', ttlMs: 30_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) {
      throw new Error('Expected the local test Attempt lease');
    }
    const authority = engine.external;
    const observedIdentity = authority.observeIdentity({
      kind: 'a2a', endpoint: 'https://agent.example.test/a2a', displayName: 'Reader', now: 1,
    });
    const identity = authority.setTrust({
      externalIdentityId: observedIdentity.externalIdentityId,
      expectedStateVersion: observedIdentity.stateVersion,
      to: 'verified_endpoint',
      now: 2,
    });
    const advertised = authority.recordCapabilities({
      externalIdentityId: identity.externalIdentityId,
      protocol: 'a2a', protocolVersion: '1.0',
      capabilityDigest: 'c'.repeat(64), readCapabilityDigest: 'd'.repeat(64),
      mutationCapabilityDigest: 'e'.repeat(64), capabilities: { skills: ['read'] },
      idempotencyKey: 'a2a-caps:one', now: 2,
    });
    const capabilities = authority.acceptCapabilities({
      capabilitySnapshotId: advertised.capabilitySnapshotId,
      expectedStateVersion: advertised.stateVersion,
      acceptedBy: 'local-user', now: 2,
    });
    const task = authority.admitRemoteTask({
      externalIdentityId: identity.externalIdentityId,
      capabilitySnapshotId: capabilities.capabilitySnapshotId,
      capabilityDigest: capabilities.capabilityDigest,
      protocolVersion: '1.0',
      binding: 'JSONRPC',
      parentJobId: admitted.jobId,
      localJobId: admitted.jobId,
      localAttemptId: admitted.attemptId,
      localGeneration: lease.generation,
      localFenceToken: lease.fenceToken,
      requestDigest: 'a'.repeat(64),
      idempotencyKey: 'remote:one',
      now: 3,
    });
    const bound = authority.bindRemoteIdentity({
      remoteTaskRecordId: task.remoteTaskRecordId,
      expectedStateVersion: task.stateVersion,
      localAttemptId: admitted.attemptId,
      localGeneration: lease.generation,
      localFenceToken: lease.fenceToken,
      remoteTaskId: 'remote-42',
      remoteContextId: 'context-9',
      remoteMessageId: 'message-7',
      now: 4,
    });
    const observed = authority.observeRemoteState({
      remoteTaskRecordId: bound.remoteTaskRecordId,
      expectedStateVersion: bound.stateVersion,
      localAttemptId: admitted.attemptId,
      localGeneration: lease.generation,
      localFenceToken: lease.fenceToken,
      state: 'completed_observed',
      remoteEventId: 'event-complete',
      payloadDigest: 'b'.repeat(64),
      now: 5,
    });
    expect(observed.state).toBe('completed_observed');
    expect(observed.locallyVerified).toBe(false);

    expect(engine.cancelJob({
      jobId: admitted.jobId,
      reason: 'test cancellation',
      producer: 'external-authority-test',
      eventIdempotencyKey: 'cancel-before-remote-verify',
    }).applied).toBe(true);
    expect(() => authority.markLocallyVerified({
      remoteTaskRecordId: observed.remoteTaskRecordId,
      expectedStateVersion: observed.stateVersion,
      localAttemptId: admitted.attemptId,
      localGeneration: lease.generation,
      localFenceToken: lease.fenceToken!,
      verificationId: 'verification-1',
      evidenceIds: ['evidence-1'],
      now: 6,
    })).toThrow(/local attempt authority/i);
  });
});
