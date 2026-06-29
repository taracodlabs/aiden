/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/aidenAgent.abort.test.ts — v4.6 prep dispatch.
 *
 * Guards the AidenAgent abort-plumbing prerequisite added to support
 * Phase 1 of the v4.6 sub-agent subsystem. See:
 *   - docs/v4.6/phase-1-design.md §7.1 (prerequisite)
 *   - docs/v4.6/phase-1-design.md §11.0 (test plan for this dispatch)
 *
 * Six cases:
 *   1. Signature accepts `signal` (compile + null pass).
 *   2. Pre-iteration abort → finishReason: 'interrupted'.
 *   3. Pre-tool-call abort → 'interrupted' + remaining tool calls
 *      NOT dispatched.
 *   4. In-flight HTTP cancel → 'interrupted', NOT 'error'.
 *   5. Existing callers unaffected (no-signal path is unchanged).
 *   6. Type-level union check — finishReason has the 5 expected values.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AidenAgent,
  AidenAgentResult,
  ToolExecutor,
} from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
  ToolSchema,
} from '../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string): ToolCallRequest => ({
  id, name, arguments: {},
});
const okExecutor: ToolExecutor = async (call) => ({
  id:     call.id,
  name:   call.name,
  result: { ok: true },
});

/**
 * Provider that abort-aware: when `input.signal.aborted` is true on
 * entry, throws an AbortError immediately (no scripted response). When
 * a controller is provided via the constructor, awaits one tick before
 * checking — gives the test a chance to abort mid-flight.
 */
class AbortAwareProvider implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  private callCount = 0;
  public readonly capturedInputs: ProviderCallInput[] = [];

  constructor(
    private scripted: ProviderCallOutput[],
    /** When set, the test triggers this controller's abort mid-call
     *  (simulating in-flight HTTP cancellation). */
    private midCallAbortController?: AbortController,
  ) {}

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.capturedInputs.push({ ...input, messages: [...input.messages] });
    if (input.signal?.aborted) {
      const err = new Error('AbortError');
      err.name = 'AbortError';
      throw err;
    }
    // Simulate an in-flight HTTP call: wait briefly, check signal,
    // then return. If the test aborts during this wait, we throw
    // AbortError to mimic what fetch() would do.
    if (this.midCallAbortController) {
      this.midCallAbortController.abort();  // trigger immediately
      await new Promise((r) => setTimeout(r, 5));
      if (input.signal?.aborted) {
        const err = new Error('AbortError');
        err.name = 'AbortError';
        throw err;
      }
    }
    if (this.callCount >= this.scripted.length) {
      throw new Error(`AbortAwareProvider: out of scripted responses`);
    }
    return this.scripted[this.callCount++];
  }
}

describe('AidenAgent abort plumbing (v4.6 prep)', () => {
  // ──────────────────────────────────────────────────────────────────
  // Case 1 — Signature accepts signal (compile + null pass)
  // ──────────────────────────────────────────────────────────────────
  it('1. accepts signal option without aborting normal flow', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hello'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    const ctrl = new AbortController();
    const result = await agent.runConversation([userMsg('hi')], {
      signal: ctrl.signal,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toBe('hello');
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 2 — Pre-iteration abort
  // ──────────────────────────────────────────────────────────────────
  it('2. pre-iteration abort yields finishReason "interrupted"', async () => {
    // Pre-abort the controller so the first iteration-top check trips.
    const ctrl = new AbortController();
    ctrl.abort();

    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('should not be returned'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    const result = await agent.runConversation([userMsg('hi')], {
      signal: ctrl.signal,
    });

    expect(result.finishReason).toBe('interrupted');
    expect(result.finalContent).toBe('');
    // Provider should never have been called.
    expect(provider.capturedInputs).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 3 — Pre-tool-call abort: remaining tool calls NOT dispatched
  // ──────────────────────────────────────────────────────────────────
  it('3. pre-tool-call abort skips remaining tool calls in batch', async () => {
    const ctrl = new AbortController();
    let toolCallsDispatched = 0;
    const trackingExecutor: ToolExecutor = async (call) => {
      toolCallsDispatched += 1;
      // After the first dispatch starts, abort the signal so the
      // second tool call in the batch gets skipped by the pre-tool
      // abort check.
      ctrl.abort();
      return { id: call.id, name: call.name, result: { ok: true } };
    };
    // Provider scripts a single iteration with TWO tool calls; the
    // abort fires after the first dispatch, so the second must not
    // be invoked.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('c1', 't1'), tc('c2', 't2')]),
      // Second iteration's response — should never be requested
      // because we break out after the for-of detects interruption.
      MockProviderAdapter.stop('should not be reached'),
    ]);
    // v4.11 — consecutive READ-ONLY tool calls now pre-execute together
    // via Promise.all before the per-call abort check (see
    // aidenAgent.parallel.test.ts), so an abort fired mid-batch can't stop
    // a sibling read-only call that already started — harmless, no side
    // effects. The abort-skip guarantee that matters is for MUTATING
    // tools, which stay on the sequential dispatch path. Mark these tools
    // mutating so this test exercises that path: tool 1 runs + aborts,
    // tool 2 is skipped by the pre-tool check.
    const agent = new AidenAgent({
      provider,
      toolExecutor: trackingExecutor,
      tools:        NO_TOOLS,
      resolveMutates: () => true,
    });

    const result = await agent.runConversation([userMsg('go')], {
      signal: ctrl.signal,
    });

    expect(result.finishReason).toBe('interrupted');
    expect(toolCallsDispatched).toBe(1);   // first mutating call ran; 2nd skipped by pre-tool abort
    expect(provider.capturedInputs).toHaveLength(1);  // no 2nd iteration
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 4 — In-flight HTTP cancel → 'interrupted' not 'error'
  // ──────────────────────────────────────────────────────────────────
  it('4. in-flight HTTP abort surfaces as "interrupted", not "error"', async () => {
    const ctrl = new AbortController();
    // AbortAwareProvider triggers ctrl.abort() during the call and
    // then throws AbortError when its post-await signal check trips.
    const provider = new AbortAwareProvider([], ctrl);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    const result = await agent.runConversation([userMsg('hi')], {
      signal: ctrl.signal,
    });

    expect(result.finishReason).toBe('interrupted');
    expect(result.finalContent).toBe('');
    // The AbortError MUST NOT propagate up as a thrown exception, and
    // it MUST NOT trigger the fallback / error path. finishReason
    // distinguishes this from 'error'.
    expect(result.finishReason).not.toBe('error');
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 5 — Existing callers (no signal) work unchanged
  // ──────────────────────────────────────────────────────────────────
  it('5a. no-signal call behaves exactly as before', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('still works'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    // No options object at all — backward compatible.
    const result = await agent.runConversation([userMsg('hello')]);

    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toBe('still works');
  });

  it('5b. options object without signal also works unchanged', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('still works two'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    // Options provided, but no signal field — same as before.
    const onDelta = vi.fn();
    const result = await agent.runConversation([userMsg('hello')], {
      onDelta,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toBe('still works two');
  });

  it('5c. non-aborted signal is silently ignored on the happy path', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('happy with idle signal'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });

    const ctrl = new AbortController();  // never aborted
    const result = await agent.runConversation([userMsg('hi')], {
      signal: ctrl.signal,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toBe('happy with idle signal');
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 6 — Type-level union check
  // ──────────────────────────────────────────────────────────────────
  it('6. finishReason union has the 5 expected values + interrupted', () => {
    // Compile-time assertion: every literal must be assignable to the
    // `finishReason` field. TS will fail the build if any literal
    // is removed from or renamed in the public union.
    const reasons: Array<AidenAgentResult['finishReason']> = [
      'stop',
      'budget_exhausted',
      'error',
      'tool_loop',
      'interrupted',
    ];
    expect(reasons).toHaveLength(5);
    expect(reasons).toContain('interrupted');
    // Negative compile assertion: a clearly bogus value must NOT
    // satisfy the union. We verify this via @ts-expect-error.
    // @ts-expect-error — 'aborted' is not a member of finishReason
    const bogus: AidenAgentResult['finishReason'] = 'aborted';
    expect(bogus).toBe('aborted');  // runtime is a noop; the comment is the test
  });
});
