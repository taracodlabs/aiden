/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { describe, expect, it, vi } from 'vitest';

import {
  executeWithDurableToolCall,
  recordDurableResearchEvidence,
  recordDurableToolVerification,
  runWithJobExecutionContext,
} from '../../../core/v4/daemon/jobExecutionContext';
import type { JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { responseCache } from '../../../core/responseCache';
import { createActionAuthority, type ActionAuthority, type NormalizedAction, type PolicySnapshotInput } from '../../../core/v4/actionAuthority';
import { ApprovalEngine } from '../../../moat/approvalEngine';

const TEST_EFFECT_CONTRACT = {
  classification: 'reconcilable_mutation' as const,
  kind: 'fixture.write',
  retrySafety: 'reconcile_before_retry' as const,
  idempotencySupported: false,
  reconciliationSupported: true,
  verificationSupported: true,
  approvalRequirement: 'policy' as const,
  sensitiveFields: [] as string[],
  redactionRules: ['digest_arguments'],
  target: () => 'fixture-target',
};

function resourceAuthorityMock() {
  return {
    resources: {
      authorize: vi.fn(() => true),
      getBudgets: vi.fn(() => []),
      debit: vi.fn(() => ({ applied: true })),
    },
  };
}

describe('ToolRegistry durable execution identity', () => {
  it('captures fresh exact file readback and links proof to the current Effect', async () => {
    const db = new Database(':memory:');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-proof-readback-'));
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      db.prepare(
        `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
         VALUES ('instance-proof', 1, 'test', 1, 1, 'test')`,
      ).run();
      const engine = createJobEngine({ db });
      const admission = engine.submitJob({
        entryPoint: 'test', source: 'test', sessionId: 'session-proof', instanceId: 'instance-proof',
        idempotencyNamespace: 'test', idempotencyKey: 'file-proof', goal: 'write exact artifact',
      });
      const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
      const target = path.join(dir, 'approval-once.txt');
      const content = 'approval-once';

      await runWithJobExecutionContext({
        engine, jobId: admission.jobId, attemptId: admission.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
      }, () => executeWithDurableToolCall({
        toolCallId: 'write-exact', toolName: 'file_write', args: { path: target, content },
        riskTier: 'caution', mutates: true,
        effect: {
          classification: 'reconcilable_mutation', kind: 'filesystem.write', target,
          retrySafety: 'reconcile_before_retry', idempotencySupported: true,
          reconciliationSupported: true, verificationSupported: true,
          approvalRequirement: 'policy', sensitiveFields: ['content'],
          redactionRules: ['omit_sensitive_values'], trusted: true,
          reconciliationData: {
            path: target,
            expectedContentSha256: createHash('sha256').update(content).digest('hex'),
            expectedSize: Buffer.byteLength(content),
          },
        },
        execute: async () => {
          await fs.writeFile(target, content);
          return { success: true, path: target, bytes: Buffer.byteLength(content) };
        },
        isSuccessful: (result) => result.success,
      }));

      const claims = engine.proof.listClaims(admission.jobId);
      const evidence = engine.proof.listEvidence(admission.jobId);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ required: true, state: 'verified' });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        attemptId: admission.attemptId, generation: lease.generation,
        effectId: expect.any(String), source: 'filesystem.readback',
        coverage: 'full', verificationResult: 'verified', late: false,
        payload: expect.objectContaining({ path: target, exists: true, exact: true }),
      });
      const exported = engine.proof.exportJson(admission.jobId) as {
        effects: Array<{ key: string }>; evidence: Array<{ effectId: string }>;
      };
      expect(exported.evidence[0].effectId).toBe(exported.effects[0].key);

      const exerciseMismatch = async (
        key: string,
        proofTarget: string,
        actual: string | null,
      ) => {
        const next = engine.submitJob({
          entryPoint: 'test', source: 'test', sessionId: `session-${key}`, instanceId: 'instance-proof',
          idempotencyNamespace: 'test', idempotencyKey: key, goal: key,
        });
        const nextLease = engine.claimAttempt({ attemptId: next.attemptId, ownerId: 'test', ttlMs: 60_000 });
        await runWithJobExecutionContext({
          engine, jobId: next.jobId, attemptId: next.attemptId,
          generation: nextLease.generation!, fenceToken: nextLease.fenceToken!, producer: 'test',
        }, () => executeWithDurableToolCall({
          toolCallId: key, toolName: 'file_write', args: { path: proofTarget, content },
          riskTier: 'caution', mutates: true,
          effect: {
            classification: 'reconcilable_mutation', kind: 'filesystem.write', target: proofTarget,
            retrySafety: 'reconcile_before_retry', idempotencySupported: true,
            reconciliationSupported: true, verificationSupported: true,
            approvalRequirement: 'policy', sensitiveFields: ['content'], redactionRules: [], trusted: true,
            reconciliationData: {
              path: proofTarget,
              expectedContentSha256: createHash('sha256').update(content).digest('hex'),
              expectedSize: Buffer.byteLength(content),
            },
          },
          execute: async () => {
            if (actual !== null) await fs.writeFile(proofTarget, actual);
            return { success: true };
          },
          isSuccessful: (result) => result.success,
        }));
        return { next, claims: engine.proof.listClaims(next.jobId), evidence: engine.proof.listEvidence(next.jobId) };
      };

      const wrong = await exerciseMismatch('wrong-file-content', path.join(dir, 'wrong.txt'), 'different');
      expect(wrong.claims[0]?.state).toBe('failed');
      expect(wrong.evidence[0]).toMatchObject({ coverage: 'full', verificationResult: 'failed' });

      const unreadable = path.join(dir, 'capture-directory');
      await fs.mkdir(unreadable);
      const captureFailure = await exerciseMismatch('readback-capture-failure', unreadable, null);
      expect(captureFailure.claims[0]?.state).toBe('unknown');
      expect(captureFailure.evidence[0]).toMatchObject({ coverage: 'unknown', verificationResult: 'unknown' });
      expect(captureFailure.evidence[0]?.payload).toMatchObject({ exists: null, exact: null });
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists and settles waits around approval and exclusive interaction', async () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      db.prepare(
        `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
         VALUES ('instance-waits', 1, 'test', 1, 1, 'test')`,
      ).run();
      const engine = createJobEngine({ db });
      const admission = engine.submitJob({
        entryPoint: 'test', source: 'test', sessionId: 'session-waits', instanceId: 'instance-waits',
        idempotencyNamespace: 'test', idempotencyKey: 'interaction-waits', goal: 'wait durably',
      });
      const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
      engine.transitionAttempt({
        attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
        fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
      });
      engine.transitionJob({
        jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
        fenceToken: lease.fenceToken!, expectedStateVersion: 0, to: 'running',
        eventIdempotencyKey: 'job-running', producer: 'test',
      });
      const controls = createJobControlAuthority({ db, jobEngine: engine });
      const observed: string[] = [];
      const registry = new ToolRegistry();
      registry.register({
        schema: { name: 'approval_write', description: 'writes', inputSchema: { type: 'object' } },
        category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc',
        effectContract: TEST_EFFECT_CONTRACT,
        async execute() { return { ok: true }; },
      });
      registry.register({
        schema: { name: 'interactive_read', description: 'asks', inputSchema: { type: 'object' } },
        category: 'read', riskTier: 'safe', mutates: false, toolset: 'misc',
        interaction: { mode: 'exclusive_modal', decision: 'clarification', cancellation: 'cancelled' },
        async execute() {
          observed.push(...controls.waits.listPending(admission.jobId).map((wait) => wait.kind));
          return { ok: true, status: 'completed' };
        },
      });
      const execute = registry.buildExecutor({
        cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-waits' }),
        approvalEngine: new ApprovalEngine('manual', {
          promptUser: async () => {
            observed.push(...controls.waits.listPending(admission.jobId).map((wait) => wait.kind));
            return 'allow';
          },
        }),
      });
      const context = {
        engine, jobId: admission.jobId, attemptId: admission.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
        controlAuthority: controls,
      };

      expect((await runWithJobExecutionContext(context, () => execute({
        id: 'approval-call', name: 'approval_write', arguments: {},
      }))).error).toBeUndefined();
      expect((await runWithJobExecutionContext(context, () => execute({
        id: 'interaction-call', name: 'interactive_read', arguments: {},
      }))).error).toBeUndefined();

      expect(observed).toEqual(['approval', 'clarification']);
      expect(controls.waits.listPending(admission.jobId)).toEqual([]);
      expect(db.prepare('SELECT kind, state FROM job_waits ORDER BY sequence').all()).toEqual([
        { kind: 'approval', state: 'satisfied' },
        { kind: 'clarification', state: 'satisfied' },
      ]);
    } finally {
      db.close();
    }
  });

  it('links a requested Effect to the exact approval before dispatch', async () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      db.prepare(
        `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
         VALUES ('instance-effect', 1, 'test', 1, 1, 'test')`,
      ).run();
      const engine = createJobEngine({ db });
      const admission = engine.submitJob({
        entryPoint: 'test', source: 'test', sessionId: 'session-effect', instanceId: 'instance-effect',
        idempotencyNamespace: 'test', idempotencyKey: 'effect-approval', goal: 'effect approval',
      });
      const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
      engine.transitionAttempt({
        attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
        fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
      });
      engine.transitionJob({
        jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
        fenceToken: lease.fenceToken!, expectedStateVersion: 0, to: 'running',
        eventIdempotencyKey: 'job-running', producer: 'test',
      });
      const registry = new ToolRegistry();
      const handler = vi.fn(async () => ({ ok: true }));
      registry.register({
        schema: { name: 'approved_write', description: 'writes', inputSchema: { type: 'object' } },
        category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc', execute: handler,
        effectContract: { ...TEST_EFFECT_CONTRACT, sensitiveFields: ['apiKey'] },
      });
      const execute = registry.buildExecutor({
        cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
        actionAuthority: createActionAuthority({ db, jobEngine: engine }),
        approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'allow' }),
        policySnapshot: {
          trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
          toolMetadataVersion: 'test', sandboxPolicy: {}, networkPolicy: {}, pluginGrants: [],
          mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
        },
      });

      const result = await runWithJobExecutionContext({
        engine, jobId: admission.jobId, attemptId: admission.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
      }, () => execute({
        id: 'provider-effect-call', name: 'approved_write',
        arguments: { path: 'result.txt', apiKey: 'private-fixture-value' },
      }));

      expect(result.error).toBeUndefined();
      expect(handler).toHaveBeenCalledOnce();
      const binding = db.prepare(
        `SELECT a.effect_id, a.action_digest, se.action_digest AS effect_action_digest,
                se.approval_id, se.approval_state, se.effect_state
           FROM approvals a JOIN side_effect_ledger se ON se.key = a.effect_id`,
      ).get() as Record<string, unknown>;
      expect(binding).toMatchObject({
        approval_state: 'approved', effect_state: 'committed',
        action_digest: binding.effect_action_digest,
        approval_id: expect.any(String), effect_id: expect.any(String),
      });
      expect(JSON.stringify(db.prepare('SELECT * FROM side_effect_ledger').all()))
        .not.toContain('private-fixture-value');
    } finally {
      db.close();
    }
  });

  it('persists and starts a mutating ToolCall before the handler executes', async () => {
    const order: string[] = [];
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => { order.push('prepared'); return { applied: true, effectId: 'effect_1' }; }),
      startToolCall: vi.fn(() => { order.push('started'); return { applied: true }; }),
      completeToolCall: vi.fn(() => { order.push('completed'); return { applied: true }; }),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: {
        name: 'durable_write',
        description: 'writes durable state',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
      category: 'write',
      riskTier: 'caution',
      mutates: true,
      effectContract: TEST_EFFECT_CONTRACT,
      toolset: 'misc',
      async execute() {
        order.push('handler');
        return { ok: true };
      },
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });

    await runWithJobExecutionContext({
      engine,
      jobId: 'job_1',
      attemptId: 'attempt_1',
      generation: 3,
      fenceToken: 'fence_1',
      producer: 'test',
    }, () => execute({
      id: 'tool_call_1',
      name: 'durable_write',
      arguments: { value: 'exact' },
    }));

    expect(order).toEqual(['prepared', 'started', 'handler', 'completed']);
    const persistedToolCallId = `tool-call:sha256:${createHash('sha256')
      .update(['attempt_1', '3', 'tool_call_1'].join('\0'))
      .digest('hex')}`;
    expect(engine.prepareToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: persistedToolCallId,
      modelCallId: 'tool_call_1',
      jobId: 'job_1',
      attemptId: 'attempt_1',
      generation: 3,
      fenceToken: 'fence_1',
      toolName: 'durable_write',
      mutates: true,
      normalizedArgsDigest: createHash('sha256').update('{"value":"exact"}').digest('hex'),
      effect: expect.objectContaining({
        classification: 'reconcilable_mutation',
        kind: 'fixture.write',
        approvalState: 'not_required',
      }),
    }));
    expect(engine.completeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: persistedToolCallId,
      state: 'completed',
      sideEffectState: 'committed',
      resultRef: expect.stringMatching(/^tool-result:sha256:[a-f0-9]{64}$/),
    }));
  });

  it('scopes a repeated provider ToolCall id to each durable Attempt', async () => {
    const persisted = new Map<string, { attemptId: string; verification?: string }>();
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn((command: { toolCallId: string; attemptId: string }) => {
        if (persisted.has(command.toolCallId)) return { applied: false, conflict: 'illegal_transition' };
        persisted.set(command.toolCallId, { attemptId: command.attemptId });
        return { applied: true };
      }),
      startToolCall: vi.fn(() => ({ applied: true })),
      completeToolCall: vi.fn(() => ({ applied: true })),
      attachToolVerification: vi.fn((command: {
        toolCallId: string; attemptId: string; verificationRef: string;
      }) => {
        const row = persisted.get(command.toolCallId);
        if (!row || row.attemptId !== command.attemptId) return { applied: false, conflict: 'stale_fence' };
        row.verification = command.verificationRef;
        return { applied: true };
      }),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'repeatable_read', description: 'reads durable state', inputSchema: { type: 'object' } },
      category: 'read', riskTier: 'safe', mutates: false, toolset: 'misc',
      async execute() { return { ok: true }; },
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });

    for (const [jobId, attemptId] of [['job_1', 'attempt_1'], ['job_2', 'attempt_2']]) {
      await runWithJobExecutionContext({
        engine, jobId, attemptId, generation: 1, fenceToken: `fence_${attemptId}`, producer: 'test',
      }, async () => {
        await execute({ id: 'provider-reused-id', name: 'repeatable_read', arguments: {} });
        recordDurableToolVerification('provider-reused-id', { ok: true });
      });
    }

    expect(persisted).toHaveLength(2);
    expect(new Set([...persisted.values()].map((row) => row.attemptId))).toEqual(
      new Set(['attempt_1', 'attempt_2']),
    );
    expect([...persisted.values()].every((row) => row.verification?.startsWith('tool-verification:sha256:')))
      .toBe(true);
  });

  it('does not execute when durable preparation rejects a stale fence', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => ({ applied: false, conflict: 'stale_fence' })),
      startToolCall: vi.fn(),
      completeToolCall: vi.fn(),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'guarded_write', description: 'guarded', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc', execute: handler,
      effectContract: TEST_EFFECT_CONTRACT,
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });

    const result = await runWithJobExecutionContext({
      engine,
      jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      fenceToken: 'stale', producer: 'test',
    }, () => execute({ id: 'tool_call_stale', name: 'guarded_write', arguments: {} }));

    expect(handler).not.toHaveBeenCalled();
    expect(result.result).toBeNull();
    expect(result.error).toContain('stale_fence');
  });

  it('persists approval_required and denies safely when no interactive channel exists', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => ({ ok: true }));
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => { order.push('effect'); return { applied: true, effectId: 'effect_exact' }; }),
      resolveToolCallApproval: vi.fn(() => { order.push('effect-blocked'); return { applied: true }; }),
      startToolCall: vi.fn(),
      completeToolCall: vi.fn(() => ({ applied: true })),
    } as unknown as JobEngine;
    const actionAuthority = {
      request: vi.fn(() => { order.push('approval'); return ({
        approvalId: 'approval_exact', policySnapshotId: 'policy_exact',
      }); }),
      markDisplayed: vi.fn(),
    } as unknown as ActionAuthority;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'unattended_write', description: 'writes', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc', execute: handler,
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
      actionAuthority,
      policySnapshot: {
        trustLevel: 'Observer', autonomyPolicy: 'deny_without_interactive_channel', approvalMode: 'manual',
        toolMetadataVersion: 'test', sandboxPolicy: {}, networkPolicy: {}, pluginGrants: [],
        mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
      },
    });

    const result = await runWithJobExecutionContext({
      engine, jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      fenceToken: 'fence_1', producer: 'mcp',
    }, () => execute({ id: 'tool_unattended', name: 'unattended_write', arguments: {} }));

    expect(actionAuthority.request).toHaveBeenCalledOnce();
    expect(actionAuthority.request).toHaveBeenCalledWith(expect.objectContaining({ effectId: 'effect_exact' }));
    expect(order).toEqual(['effect', 'approval', 'effect-blocked']);
    expect(actionAuthority.markDisplayed).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toContain('approval_exact');
  });

  it('records verified read-only shell execution without a mutation Effect', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => ({ applied: true })),
      startToolCall: vi.fn(() => ({ applied: true })),
      completeToolCall: vi.fn(() => ({ applied: true })),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'shell_exec', description: 'shell', inputSchema: { type: 'object' } },
      category: 'execute', riskTier: 'caution', mutates: true, toolset: 'terminal', execute: handler,
      effectContract: TEST_EFFECT_CONTRACT,
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });

    const result = await runWithJobExecutionContext({
      engine, jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      fenceToken: 'fence_1', producer: 'test',
    }, () => execute({ id: 'tool_read_shell', name: 'shell_exec', arguments: { command: 'rg --files' } }));

    expect(result.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(engine.prepareToolCall).toHaveBeenCalledWith(expect.objectContaining({
      mutates: false,
      effect: undefined,
    }));
  });

  it('retains an unknown Effect when a mutating handler throws', async () => {
    const updates: Array<{ phase: string; timing?: { terminalClassification?: string } }> = [];
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => ({ applied: true, effectId: 'effect_failure' })),
      startToolCall: vi.fn(() => ({ applied: true })),
      completeToolCall: vi.fn(() => ({ applied: true })),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'failing_write', description: 'fails', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc',
      effectContract: TEST_EFFECT_CONTRACT,
      async execute() { throw new Error('fixture failure'); },
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });

    const result = await runWithJobExecutionContext({
      engine, jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      fenceToken: 'fence_1', producer: 'test',
    }, () => execute(
      { id: 'tool_failure', name: 'failing_write', arguments: {} },
      undefined,
      (update) => updates.push(update),
    ));

    expect(result.error).toBe('fixture failure');
    expect(engine.completeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', sideEffectState: 'unknown',
    }));
    expect(updates.at(-1)).toMatchObject({
      phase: 'terminal', timing: { terminalClassification: 'unknown' },
    });
  });

  it('recomputes policy and action identity immediately before execution', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => ({ applied: true })),
      resolveToolCallApproval: vi.fn(() => ({ applied: true })),
      startToolCall: vi.fn(),
      completeToolCall: vi.fn(() => ({ applied: true })),
    } as unknown as JobEngine;
    const policy: PolicySnapshotInput = {
      trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
      toolMetadataVersion: 'test', sandboxPolicy: {}, networkPolicy: {}, pluginGrants: [],
      mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
    };
    let approvedAction: NormalizedAction | undefined;
    const actionAuthority = {
      request: vi.fn((command: { normalized: NormalizedAction }) => {
        approvedAction = command.normalized;
        return {
          approvalId: 'approval_policy',
          policySnapshotId: command.normalized.policySnapshot.policySnapshotId,
        };
      }),
      markDisplayed: vi.fn(),
      decide: vi.fn(),
      authorizeExecution: vi.fn((command: { actionDigest: string; policySnapshotId: string }) => ({
        authorized: command.actionDigest === approvedAction?.actionDigest
          && command.policySnapshotId === approvedAction?.policySnapshot.policySnapshotId,
        reason: 'approved action changed or binding mismatch',
      })),
    } as unknown as ActionAuthority;
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => {
        policy.trustLevel = 'Observer';
        return 'allow';
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'policy_bound_write', description: 'writes', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc', execute: handler,
      effectContract: TEST_EFFECT_CONTRACT,
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
      actionAuthority,
      approvalEngine,
      policySnapshot: policy,
    });

    const result = await runWithJobExecutionContext({
      engine, jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      fenceToken: 'fence_1', producer: 'test',
    }, () => execute({ id: 'tool_policy', name: 'policy_bound_write', arguments: { path: 'result.txt' } }));

    expect(actionAuthority.authorizeExecution).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toContain('binding mismatch');
  });

  it('binds a cached read to the current durable ToolCall before verification', async () => {
    responseCache.clear();
    const order: string[] = [];
    const engine = {
      ...resourceAuthorityMock(),
      prepareToolCall: vi.fn(() => { order.push('prepared'); return { applied: true }; }),
      startToolCall: vi.fn(() => { order.push('started'); return { applied: true }; }),
      completeToolCall: vi.fn(() => { order.push('completed'); return { applied: true }; }),
      attachToolVerification: vi.fn(() => ({ applied: true })),
    } as unknown as JobEngine;
    const handler = vi.fn(async () => 'physical result');
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'fetch_url', description: 'fetches', inputSchema: { type: 'object' } },
      category: 'network', riskTier: 'safe', mutates: false, toolset: 'web', execute: handler,
    });
    responseCache.set('fetch_url', { url: 'https://example.test/feed' }, 'cached result');
    const execute = registry.buildExecutor({ cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-cache-identity' }) });

    let result;
    await runWithJobExecutionContext({
      engine, jobId: 'job_cache', attemptId: 'attempt_cache', generation: 1,
      fenceToken: 'fence_cache', producer: 'test',
    }, async () => {
      result = await execute({
        id: 'cached-call', name: 'fetch_url', arguments: { url: 'https://example.test/feed' },
      });
      recordDurableToolVerification('cached-call', { source: 'cache', verified: true });
    });

    expect(result).toMatchObject({ result: 'cached result' });
    expect(handler).not.toHaveBeenCalled();
    expect(order).toEqual(['prepared', 'started', 'completed']);
    expect(engine.attachToolVerification).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt_cache', generation: 1, fenceToken: 'fence_cache',
    }));
    responseCache.clear();
  });

  it('records bounded research Evidence once per normalized source', async () => {
    const recordEvidence = vi.fn(() => ({ evidenceId: 'evidence-research' }));
    const engine = {
      proof: { recordEvidence },
    } as unknown as JobEngine;

    await runWithJobExecutionContext({
      engine, jobId: 'job_research', attemptId: 'attempt_research', generation: 2,
      fenceToken: 'fence_research', producer: 'test',
    }, () => {
      recordDurableResearchEvidence({
        toolCallId: 'fetch-one',
        toolName: 'fetch_url',
        args: { url: 'https://example.test/article?token=secret' },
        result: {
          success: true,
          status: 200,
          body: 'A bounded source excerpt with Authorization: Bearer private-value',
        },
      });
      recordDurableResearchEvidence({
        toolCallId: 'fetch-two',
        toolName: 'fetch_page',
        args: { url: 'https://example.test/article?token=secret' },
        result: { success: true, content: 'same normalized source' },
      });
    });

    expect(recordEvidence).toHaveBeenCalledOnce();
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_research', attemptId: 'attempt_research', generation: 2,
      fenceToken: 'fence_research', effectId: null,
      source: 'research.fetch_url', coverage: 'partial', verificationResult: 'unknown',
      payload: expect.objectContaining({
        source: 'https://example.test/article',
        toolCallId: 'fetch-one',
      }),
    }));
    const payload = recordEvidence.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('private-value');
  });

  it('checks every browser upload path against the active Job capability boundary', async () => {
    const handler = vi.fn(async () => ({ success: true }));
    const authorize = vi.fn((resource: { kind: string; value: string }) =>
      resource.kind !== 'path' || !resource.value.endsWith('foreign.txt'));
    const engine = {
      resources: {
        authorize,
        getBudgets: vi.fn(() => []),
        debit: vi.fn(() => ({ applied: true })),
      },
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'browser_upload', description: 'upload', inputSchema: { type: 'object' } },
      category: 'browser', riskTier: 'dangerous', mutates: true, toolset: 'browser', execute: handler,
    });
    const execute = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-job-identity' }),
    });
    const result = await runWithJobExecutionContext({
      engine, jobId: 'job_upload', attemptId: 'attempt_upload', generation: 1,
      fenceToken: 'fence_upload', producer: 'test',
    }, () => execute({
      id: 'tool_upload', name: 'browser_upload',
      arguments: { selector: '#file', paths: ['approved.txt', 'foreign.txt'] },
    }));
    expect(result.error).toBe('Path is outside this Job capability boundary');
    expect(handler).not.toHaveBeenCalled();
    expect(authorize.mock.calls.filter(([resource]) => resource.kind === 'path')).toHaveLength(2);
  });
});
