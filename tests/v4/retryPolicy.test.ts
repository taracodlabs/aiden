/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Pillar 1 Gap 2 — failure-class → retry policy.
 *
 * Part 1: pure policy-table units (all 16 classes + unknown mapped).
 * Part 2: agent-loop integration through the REAL dispatch choke point
 * (MockProviderAdapter + scripted executors): transient retry succeeds
 * on attempt 2, give-up without identical re-fire, permission never
 * retried, repair-once, mutating-tool guard, and ladder integration
 * (policy retries feed the breaker; combined behavior stays bounded).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  decideRecoveryAction,
  resolveRetryPolicyConfig,
  buildRetryAnnotation,
  type RetryAttemptView,
} from '../../core/v4/retryPolicy';
import { AidenAgent, type ToolExecutor } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import type { Message, ToolCallRequest, ToolSchema } from '../../providers/v4/types';
import { decideTaskVerdict } from '../../core/v4/taskVerification';

// ── Part 1 — the policy table (pure) ────────────────────────────────────

function view(over: Partial<{
  byClass: Record<string, number>; total: number; repaired: string[]; clarified: boolean;
}> = {}): RetryAttemptView {
  return {
    attemptsForClass: (c) => over.byClass?.[c] ?? 0,
    totalRetries:     () => over.total ?? 0,
    hasRepairAttempted: (k) => (over.repaired ?? []).includes(k),
    clarifyAdvised:   () => over.clarified ?? false,
  };
}

const CFG = resolveRetryPolicyConfig({});   // pure defaults, no env

describe('decideRecoveryAction — per-class policy table', () => {
  it('transient infra classes retry with exponential backoff', () => {
    for (const c of ['network', 'timeout', 'rate_limit']) {
      const d = decideRecoveryAction(c, 't', view(), CFG);
      expect(d.action).toBe('retry_with_backoff');
      expect(d.backoffMs).toBeGreaterThan(0);
    }
    // Backoff doubles per spent attempt.
    const first  = decideRecoveryAction('network', 't', view(), CFG);
    const second = decideRecoveryAction('network', 't', view({ byClass: { network: 1 }, total: 1 }), CFG);
    expect(second.backoffMs).toBe((first.backoffMs ?? 0) * 2);
  });

  it('per-class cap exhausts into a structured give_up', () => {
    const d = decideRecoveryAction('network', 't', view({ byClass: { network: 2 }, total: 2 }), CFG);
    expect(d.action).toBe('give_up');
    expect(d.reason).toMatch(/budget exhausted/);
    expect(d.reason).toMatch(/2\/2/);
  });

  it('per-turn TOTAL cap gates across classes (layered budget)', () => {
    const d = decideRecoveryAction('network', 't', view({ byClass: { network: 0 }, total: 3 }), CFG);
    expect(d.action).toBe('give_up');
    expect(d.reason).toMatch(/3\/3/);
  });

  it('MUTATING tools never runtime-retry, even on transient classes', () => {
    const d = decideRecoveryAction('network', 't', view(), CFG, { toolMutates: true });
    expect(d.action).toBe('surface');
    expect(d.reason).toMatch(/MUTATING/);
  });

  it('invalid_input: repair once, then the broken invariant stops the loop', () => {
    const first = decideRecoveryAction('invalid_input', 'my_tool', view(), CFG);
    expect(first.action).toBe('surface');
    expect(first.reason).toMatch(/repair the arguments/);
    const second = decideRecoveryAction(
      'invalid_input', 'my_tool',
      view({ repaired: ['my_tool:invalid_input'] }), CFG,
    );
    expect(second.action).toBe('give_up');
    expect(second.reason).toMatch(/invariant is broken/);
  });

  it('tool-execution classes give_up — an identical retry cannot succeed', () => {
    for (const c of ['not_found', 'dependency_missing', 'hallucination']) {
      expect(decideRecoveryAction(c, 't', view(), CFG).action).toBe('give_up');
    }
  });

  it('permission boundaries are NEVER retried around', () => {
    for (const c of ['permission', 'sandbox_violation', 'auth']) {
      const d = decideRecoveryAction(c, 't', view(), CFG);
      expect(d.action).toBe('ask_permission');
    }
  });

  it('manual_blocker clarifies once, then surfaces', () => {
    expect(decideRecoveryAction('manual_blocker', 't', view(), CFG).action).toBe('clarify');
    expect(decideRecoveryAction('manual_blocker', 't', view({ clarified: true }), CFG).action).toBe('surface');
  });

  it('stale_ref defers to the existing browser re-resolution (no double retry)', () => {
    const d = decideRecoveryAction('stale_ref', 't', view(), CFG);
    expect(d.action).toBe('surface');
    expect(d.reason).toMatch(/already re-resolved/);
  });

  it('trigger classes + other + unknown strings surface with no retry', () => {
    for (const c of ['trigger_misconfigured', 'trigger_quota', 'trigger_dead_lettered', 'other', 'brand_new_class']) {
      expect(decideRecoveryAction(c, 't', view(), CFG).action).toBe('surface');
    }
  });

  it('AIDEN_RETRY_OFF=1 zeroes every retry budget', () => {
    const cfg = resolveRetryPolicyConfig({ AIDEN_RETRY_OFF: '1' } as NodeJS.ProcessEnv);
    expect(decideRecoveryAction('network', 't', view(), cfg).action).toBe('surface');
  });

  it('annotation builder: success-after-retry and give-up shapes', () => {
    const notes = [{ attempt: 1, category: 'network', reason: 'ECONNREFUSED', backoffMs: 400 }];
    expect(buildRetryAnnotation(notes, null, true)).toMatch(/retried 1x after network; succeeded on attempt 2/);
    const giveUp = { action: 'give_up' as const, reason: 'budget exhausted' };
    expect(buildRetryAnnotation(notes, giveUp, false)).toMatch(/still failing.*give_up — budget exhausted/);
    expect(buildRetryAnnotation([], null, true)).toBeNull();
  });
});

// ── Part 2 — agent-loop integration (real choke point) ─────────────────

const NO_TOOLS: ToolSchema[] = [];
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id, name, arguments: args });

const SAVED = { ...process.env };
beforeEach(() => { process.env.AIDEN_TCE = '1'; });
afterEach(() => {
  for (const k of ['AIDEN_TCE', 'AIDEN_RETRY_MAX_TOTAL', 'AIDEN_RETRY_NETWORK']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('agent-loop retry integration', () => {
  it('transient network failure → runtime retry with backoff → success on attempt 2; trace + message show the retry; task verdict completes', async () => {
    let calls = 0;
    const flakyExecutor: ToolExecutor = async (call) => {
      calls += 1;
      if (calls === 1) {
        return { id: call.id, name: call.name, result: { success: false, error: 'ECONNREFUSED: connection refused' } };
      }
      return { id: call.id, name: call.name, result: { success: true, data: 'fetched' } };
    };
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 'fetch_url', { url: 'http://x' })]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: flakyExecutor, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('get it')]);

    // ONE model tool call, TWO executor attempts (the retry).
    expect(calls).toBe(2);
    const entry = result.toolCallTrace.find((t) => t.name === 'fetch_url')!;
    expect(entry.retries).toBeDefined();
    expect(entry.retries![0].category).toBe('network');
    expect(entry.retries![0].backoffMs).toBeGreaterThan(0);
    // Verifier saw the FINAL (successful) attempt.
    expect(entry.verification?.ok).toBe(true);
    // Model-visible annotation on the tool message.
    const toolMsg = result.messages.find((m) => m.role === 'tool' && /recovery/.test(String(m.content)));
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toMatch(/succeeded on attempt 2/);
    // Gap 1 integration: the verdict policy sees a clean final outcome.
    expect(decideTaskVerdict(result.toolCallTrace).verdict).toBe('completed');
  }, 20_000);

  it('not_found: NO runtime retry (identical attempt cannot differ) — one execution per model call, give_up annotated, evidence shows what was tried', async () => {
    let calls = 0;
    const notFoundExecutor: ToolExecutor = async (call) => {
      calls += 1;
      return { id: call.id, name: call.name, result: { success: false, error: 'ENOENT: no such file or directory' } };
    };
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 'file_read', { path: 'missing.txt' })]),
      MockProviderAdapter.toolUse([tc('2', 'file_read', { path: 'missing.txt' })]),   // model repeats identically
      MockProviderAdapter.stop('giving up'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: notFoundExecutor, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('read it')]);

    // Exactly one execution per model call — zero runtime re-fires.
    expect(calls).toBe(2);
    const msgs = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(msgs.some((c) => /give_up/.test(c) && /not found/.test(c))).toBe(true);
    const entries = result.toolCallTrace.filter((t) => t.name === 'file_read');
    expect(entries.every((e) => e.retries === undefined)).toBe(true);
    expect(entries.every((e) => e.classification?.category === 'not_found')).toBe(true);
  }, 20_000);

  it('permission failure: zero retries, ask_permission surfaced', async () => {
    let calls = 0;
    const deniedExecutor: ToolExecutor = async (call) => {
      calls += 1;
      return { id: call.id, name: call.name, result: { success: false, error: 'EACCES: permission denied' } };
    };
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 'file_write', { path: '/etc/x' })]),
      MockProviderAdapter.stop('cannot'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: deniedExecutor, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('write it')]);

    expect(calls).toBe(1);
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg!.content)).toMatch(/ask_permission/);
    expect(String(toolMsg!.content)).toMatch(/never retried around/);
  }, 20_000);

  it('repair-once: first invalid_input asks for repaired args; second identical failure surfaces the broken invariant', async () => {
    const badArgsExecutor: ToolExecutor = async (call) => ({
      id: call.id, name: call.name,
      result: { success: false, error: 'invalid argument: missing required field "path"' },
    });
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 'file_write', {})]),
      MockProviderAdapter.toolUse([tc('2', 'file_write', {})]),
      MockProviderAdapter.stop('stuck'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: badArgsExecutor, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('write it')]);

    const msgs = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(msgs[0]).toMatch(/repair the arguments/);
    expect(msgs[1]).toMatch(/invariant is broken/);
  }, 20_000);

  it('ladder integration: policy retries feed the breaker; endless identical transient failures stay bounded by the ladder hard stop', async () => {
    process.env.AIDEN_RETRY_MAX_TOTAL = '2';
    process.env.AIDEN_RETRY_NETWORK   = '2';
    let calls = 0;
    const alwaysNetworkFail: ToolExecutor = async (call) => {
      calls += 1;
      return { id: call.id, name: call.name, result: { success: false, error: 'ECONNREFUSED: connection refused' } };
    };
    // Model repeats the identical call far past the ladder's surface stop.
    const script = Array.from({ length: 14 }, (_, i) =>
      MockProviderAdapter.toolUse([tc(String(i + 1), 'fetch_url', { url: 'http://x' })]));
    script.push(MockProviderAdapter.stop('never reached'));
    const provider = new MockProviderAdapter(script);
    const agent = new AidenAgent({ provider, toolExecutor: alwaysNetworkFail, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('fetch forever')]);

    // The breaker surfaced the loop (tool_loop) — combined model calls +
    // policy retries never exceed the ladder's stop.
    expect(result.finishReason).toBe('tool_loop');
    expect(calls).toBeLessThanOrEqual(13);
    // Retries actually happened (attempts counted toward the ladder).
    const withRetries = result.toolCallTrace.filter((t) => (t.retries?.length ?? 0) > 0);
    expect(withRetries.length).toBeGreaterThan(0);
  }, 30_000);
});
