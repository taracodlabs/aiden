/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  recordDurableToolVerification,
  runWithJobExecutionContext,
} from '../../../core/v4/daemon/jobExecutionContext';
import type { JobEngine } from '../../../core/v4/daemon/jobEngine';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';

describe('ToolRegistry durable execution identity', () => {
  it('persists and starts a mutating ToolCall before the handler executes', async () => {
    const order: string[] = [];
    const engine = {
      prepareToolCall: vi.fn(() => { order.push('prepared'); return { applied: true }; }),
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
      prepareToolCall: vi.fn(() => ({ applied: false, conflict: 'stale_fence' })),
      startToolCall: vi.fn(),
      completeToolCall: vi.fn(),
    } as unknown as JobEngine;
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'guarded_write', description: 'guarded', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'caution', mutates: true, toolset: 'misc', execute: handler,
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
});
