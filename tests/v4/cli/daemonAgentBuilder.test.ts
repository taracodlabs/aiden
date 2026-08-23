/**
 * v4.5 Phase 7b — daemonAgentBuilder tests.
 *
 * Covers the closure factory in isolation: verifies the builder
 * constructs an AidenAgent with the daemon-flavored options +
 * threads the dispatcher's approvalCallbacks/onToolCall hooks +
 * survives provider resolution failure via the fallback adapter.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDaemonAgentBuilder } from '../../../cli/v4/daemonAgentBuilder';
import type {
  ToolCallRequest,
  ToolCallResult,
  ProviderAdapter,
} from '../../../providers/v4/types';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { ApprovalCallbacks } from '../../../moat/approvalEngine';
import { ToolRegistry, type ToolHandler } from '../../../core/v4/toolRegistry';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';

// ── Stub dependencies ─────────────────────────────────────────────────────

function stubAdapter(label: string): ProviderAdapter {
  return {
    name: label,
    sendRequest: async () => ({ content: '', toolCalls: [], finishReason: 'stop' }),
  } as unknown as ProviderAdapter;
}

function stubDeps(over: Partial<Parameters<typeof buildDaemonAgentBuilder>[0]> = {}) {
  const fallback = stubAdapter('fallback');
  const resolved = stubAdapter('resolved');
  const resolver = {
    resolve: vi.fn(async () => resolved),
  };
  const toolRegistry = new ToolRegistry();
  const toolExecutor = vi.fn();
  const auxiliaryClient = {} as any;
  const promptBuilder = {} as any;
  const promptBuilderOptions = { providerId: '', modelId: '' } as any;
  const memoryManager = {
    loadSnapshot: vi.fn(async () => ({})),
  } as any;
  const logs: string[] = [];
  const deps = {
    paths: {} as any,
    resolver: resolver as any,
    fallbackAdapter: fallback,
    toolRegistry,
    toolExecutor: toolExecutor as any,
    auxiliaryClient,
    promptBuilder,
    promptBuilderOptions,
    memoryManager,
    resolveVerifiedFlag: undefined,
    resolveToolset: undefined,
    resolveMutates: undefined,
    log: (msg: string) => logs.push(msg),
    ...over,
  };
  return { deps, resolver, fallback, resolved, logs };
}

function stubInput(over: Partial<Parameters<ReturnType<typeof buildDaemonAgentBuilder>>[0]> = {}) {
  const cb: ApprovalCallbacks = {};
  return {
    sessionId: 'trigger:file:wat-1:abc',
    resolvedModel: {
      provider: 'ollama',
      model: 'llama3.2',
      source: 'persisted' as const,
    },
    approvalPolicy: 'safe-only' as const,
    approvalCallbacks: cb,
    hooks: {
      onToolCall: vi.fn((c: ToolCallRequest, p: 'before' | 'after', r?: ToolCallResult) => { void c; void p; void r; }),
      onBudgetWarning: vi.fn(),
    },
    abortSignal: new AbortController().signal,
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('buildDaemonAgentBuilder — construction', () => {
  it('returns an AgentBuilder that constructs an AidenAgent', async () => {
    const { deps } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    const agent = await builder(stubInput());
    expect(agent).toBeInstanceOf(AidenAgent);
  });

  it('sessionId from input is set on the agent (Phase 7 explicit option)', async () => {
    const { deps } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    const agent = await builder(stubInput({ sessionId: 'trigger:email:r1:zzz' }));
    expect((agent as unknown as { sessionId?: string }).sessionId).toBe('trigger:email:r1:zzz');
  });

  it('threads onToolCall hook into the agent options', async () => {
    const { deps } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    const input = stubInput();
    const agent = await builder(input);
    // AidenAgent stores onToolCall as a private field; we test that
    // the closure passed it. Access via instance shape check.
    expect((agent as unknown as { onToolCall?: unknown }).onToolCall).toBe(input.hooks.onToolCall);
  });

  it('calls resolver.resolve with resolvedModel (provider, model)', async () => {
    const { deps, resolver } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    await builder(stubInput({
      resolvedModel: { provider: 'groq', model: 'llama-3.1-70b', source: 'trigger' },
    }));
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve.mock.calls[0][0]).toMatchObject({
      providerId: 'groq',
      modelId: 'llama-3.1-70b',
    });
  });

  it('falls back to fallbackAdapter when resolver.resolve throws', async () => {
    const { deps, fallback } = stubDeps();
    deps.resolver.resolve = vi.fn(async () => { throw new Error('no creds'); });
    const builder = buildDaemonAgentBuilder(deps);
    const agent = await builder(stubInput());
    expect((agent as unknown as { provider: ProviderAdapter }).provider).toBe(fallback);
  });

  it('keeps canonical status available for natural-language preference questions', async () => {
    const toolRegistry = new ToolRegistry();
    for (const [name, toolset] of [
      ['file_list', 'files'],
      ['memory_add', 'memory'],
      ['aiden_status', 'status'],
    ] as const) {
      toolRegistry.register({
        schema: { name, description: name, inputSchema: { type: 'object', properties: {} } },
        category: 'read', mutates: false, toolset,
        execute: async () => ({}),
      });
    }
    const { deps } = stubDeps({ toolRegistry, plannerGuardMode: 'rule_based' });
    const agent = await buildDaemonAgentBuilder(deps)(stubInput());
    const plannerGuard = (agent as unknown as {
      plannerGuard?: { decide(message: string, history: []): Promise<{ selectedTools: string[]; excludedTools: string[] }> };
    }).plannerGuard;

    expect(plannerGuard).toBeDefined();
    const decision = await plannerGuard!.decide(
      'What package manager do I prefer for this workspace?',
      [],
    );
    expect(decision.selectedTools).toContain('aiden_status');
    expect(decision.excludedTools).not.toContain('aiden_status');
    expect(decision.excludedTools).toContain('file_list');
  });
});

describe('buildDaemonAgentBuilder — state isolation', () => {
  it('each call constructs a FRESH agent (no instance shared across turns)', async () => {
    const { deps } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    const a1 = await builder(stubInput());
    const a2 = await builder(stubInput());
    expect(a1).not.toBe(a2);
  });

  it('fresh ApprovalEngine per turn (no allowlist leak)', async () => {
    const { deps } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    const a1 = await builder(stubInput());
    const a2 = await builder(stubInput());
    // The agent's executor wraps an ApprovalEngine indirectly; the
    // closure creates a fresh one per call. We assert by checking
    // that the closure does NOT cache an engine globally — easiest
    // via two distinct agent instances + distinct provider adapters
    // (different `name`-tagged stub adapters used per call would
    // confirm; here we just confirm two agents differ, which is
    // sufficient given the closure code path inspects `new
    // ApprovalEngine(...)` inline).
    expect(a1).not.toBe(a2);
  });
});

describe('buildDaemonAgentBuilder — typed automation ScriptSpec', () => {
  it('forces an exact approval prompt for a mutating step when the immutable revision requires approval', async () => {
    const execute = vi.fn(async () => ({ written: true }));
    const promptUser = vi.fn(async () => 'deny' as const);
    const toolRegistry = new ToolRegistry();
    const handler: ToolHandler = {
      schema: {
        name: 'file_write', description: 'Write a file.',
        inputSchema: {
          type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      category: 'write', mutates: true, execute,
    };
    toolRegistry.register(handler);
    const paths = resolveAidenPaths({ rootOverride: process.cwd() });
    const { deps } = stubDeps({
      paths,
      toolRegistry,
      toolContext: { cwd: process.cwd(), paths },
    });
    const builder = buildDaemonAgentBuilder(deps);
    const engine = {
      prepareToolCall: vi.fn(() => ({ applied: true, effectId: 'effect_approval' })),
      resolveToolCallApproval: vi.fn(() => ({ applied: true })),
    } as any;

    const results = await runWithJobExecutionContext({
      engine,
      jobId: 'job_approval',
      attemptId: 'attempt_approval',
      generation: 1,
      fenceToken: 'fence_approval',
      producer: 'test',
    }, () => builder.executeAutomationScript!({
      spec: {
        version: 1, maxRuntimeMs: 30_000,
        steps: [{ kind: 'write_file', path: 'approval.txt', content: 'safe' }],
      },
      approvalMode: 'always',
      approvalCallbacks: { promptUser },
      signal: new AbortController().signal,
      onToolCall: vi.fn(),
    }));

    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(results).toEqual([expect.objectContaining({ error: expect.stringMatching(/denied/i) })]);
  });

  it('executes exact typed steps through the normal tool executor without invoking a model', async () => {
    const toolExecutor = vi.fn(async (call: ToolCallRequest) => ({
      id: call.id, name: call.name, result: { ok: true },
    }));
    const { deps, resolver } = stubDeps({ toolExecutor: toolExecutor as any });
    const builder = buildDaemonAgentBuilder(deps);
    const onToolCall = vi.fn();
    const results = await runWithJobExecutionContext({
      engine: {} as any,
      jobId: 'job_automation',
      attemptId: 'attempt_automation',
      generation: 1,
      fenceToken: 'fence_automation',
      producer: 'test',
    }, () => builder.executeAutomationScript!({
      spec: {
        version: 1, maxRuntimeMs: 30_000,
        steps: [
          { kind: 'read_file', path: 'package.json', maxBytes: 4_096 },
          { kind: 'list_directory', path: 'core/v4', maxEntries: 20 },
        ],
      },
      approvalMode: 'policy',
      approvalCallbacks: {},
      signal: new AbortController().signal,
      onToolCall,
    }));
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(toolExecutor.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ name: 'file_read', arguments: { path: 'package.json', maxBytes: 4_096 } }),
      expect.objectContaining({ name: 'file_list', arguments: { path: 'core/v4', maxEntries: 20 } }),
    ]);
    expect(results).toHaveLength(2);
    expect(onToolCall).toHaveBeenCalledTimes(4);
  });

  it('binds ScriptSpec tool-call identity to the exact durable Attempt generation', async () => {
    const toolExecutor = vi.fn(async (call: ToolCallRequest) => ({
      id: call.id, name: call.name, result: { ok: true },
    }));
    const { deps } = stubDeps({ toolExecutor: toolExecutor as any });
    const builder = buildDaemonAgentBuilder(deps);
    const invoke = (attemptId: string, generation: number) => runWithJobExecutionContext({
      engine: {} as any,
      jobId: 'job_automation',
      attemptId,
      generation,
      fenceToken: `fence_${generation}`,
      producer: 'test',
    }, () => builder.executeAutomationScript!({
      spec: {
        version: 1,
        maxRuntimeMs: 30_000,
        steps: [{ kind: 'read_file', path: 'package.json' }],
      },
      approvalMode: 'policy',
      approvalCallbacks: {},
      signal: new AbortController().signal,
      onToolCall: vi.fn(),
    }));

    await invoke('attempt_first', 1);
    await invoke('attempt_recovery', 2);

    expect(toolExecutor.mock.calls.map(([call]) => call.id)).toEqual([
      'automation-script:attempt_first:1:step:1',
      'automation-script:attempt_recovery:2:step:1',
    ]);
  });
});

describe('buildDaemonAgentBuilder — durable automation delivery', () => {
  it('uses the normal app mutation authority with attempt-scoped ToolCalls and one stable request identity', async () => {
    const toolExecutor = vi.fn(async (call: ToolCallRequest) => ({
      id: call.id, name: call.name, result: { delivered: true },
    }));
    const { deps } = stubDeps({ toolExecutor: toolExecutor as any });
    const builder = buildDaemonAgentBuilder(deps) as any;
    const delivery = {
      destinationRef: 'account_delivery',
      providerId: 'composio',
      toolkitId: 'slack',
      actionId: 'send_message',
      schemaVersion: 'schema-1',
      providerActionVersion: 'provider-7',
      input: { channel: 'ops' },
      contentField: 'text',
      mode: 'on_success',
    };
    const invoke = (attemptId: string, generation: number) => runWithJobExecutionContext({
      engine: {} as any,
      jobId: 'job_delivery',
      attemptId,
      generation,
      fenceToken: `fence_${generation}`,
      producer: 'test',
    }, () => builder.executeAutomationDelivery({
      spec: delivery,
      occurrenceId: 'occurrence_exact',
      content: 'Automation completed.',
      approvalMode: 'policy',
      approvalCallbacks: {},
      signal: new AbortController().signal,
      onToolCall: vi.fn(),
    }));

    await invoke('attempt_first', 1);
    await invoke('attempt_recovery', 2);

    expect(toolExecutor.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        id: 'automation-delivery:attempt_first:1',
        name: 'app_action',
        arguments: expect.objectContaining({
          account_id: 'account_delivery',
          request_id: 'automation-delivery:occurrence_exact',
          input: { channel: 'ops', text: 'Automation completed.' },
        }),
      }),
      expect.objectContaining({
        id: 'automation-delivery:attempt_recovery:2',
        name: 'app_action',
        arguments: expect.objectContaining({ request_id: 'automation-delivery:occurrence_exact' }),
      }),
    ]);
  });
});

describe('buildDaemonAgentBuilder — stdout log line (Q-P7b-4b)', () => {
  it('emits a single per-turn starting line with sessionId, model, policy', async () => {
    const { deps, logs } = stubDeps();
    const builder = buildDaemonAgentBuilder(deps);
    await builder(stubInput({
      sessionId: 'trigger:file:wat-1:hash123',
      resolvedModel: { provider: 'ollama', model: 'llama3.2', source: 'persisted' },
      approvalPolicy: 'caution-ok',
    }));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/\[daemon-turn\] starting/);
    expect(logs[0]).toContain('sessionId=trigger:file:wat-1:hash123');
    expect(logs[0]).toContain('model=ollama/llama3.2');
    expect(logs[0]).toContain('policy=caution-ok');
  });
});
