/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.4 SLICE 1 — orphan tool_call_id regression coverage.
 *
 * THE PROOF-OF-LIFE TEST CLASS. Covers both broken-by-design sites:
 *   • surfaceDecision mid-batch break (the actual user-facing bug)
 *   • abort-signal mid-batch break (lower-exposure twin)
 *
 * Discipline anchors (per v4.9.4 dispatch + carried lessons):
 *   • Real AidenAgent constructor + real runConversation invocation.
 *     ./toolCallInvariant is the only thing under test alongside, NOT
 *     mocked. (v4.9.1 mock-blindness lesson.)
 *   • Two assertions per test: (1) the returned result.messages is
 *     invariant-clean, (2) a SECOND runConversation pass fed the first
 *     turn's messages as prefix also stays clean and provider-call-able.
 *     Without the second pass we'd only prove "fill happened this turn",
 *     not "fill prevents the 400 downstream" — which is the actual
 *     user-facing failure mode.
 *   • Abort path explicitly asserts the synthetic results LANDED in
 *     result.messages — the explicit messages.push(...turnToolMessages)
 *     inside the abort branch is sneaky and we want a test that fails
 *     if someone deletes it.
 */
import { describe, it, expect } from 'vitest';
import {
  AidenAgent,
  type ToolExecutor,
} from '../../../core/v4/aidenAgent';
import {
  assertNoUnansweredToolCalls,
  OrphanToolCallError,
} from '../../../core/v4/toolCallInvariant';
import { TurnState, type RecoveryDecision } from '../../../core/v4/turnState';
import {
  type Message,
  type ProviderAdapter,
  type ProviderCallInput,
  type ProviderCallOutput,
  type ToolCallRequest,
  type ToolSchema,
} from '../../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string): ToolCallRequest => ({
  id, name, arguments: { path: `/tmp/${id}` },
});

const okExecutor: ToolExecutor = async (call) => ({
  id: call.id, name: call.name, result: { ok: true },
});

// ── Stub TurnState ────────────────────────────────────────────────────
//
// AUDIT (per Phase B Q2): runTurnLoop reads these TurnState methods
// beyond recordToolCall:
//   isEnabled()                         — TCE gate
//   advanceIteration()                  — per-iteration tick
//   getCooledDownTools()                — schema filter
//   captureCheckpoint(messages, n)      — rollback support
//   markMutationOnLiveCheckpoint(name)  — rollback safety
//   restoreInternalsFrom(checkpoint)    — rollback (not reached in surface path)
//   reapplyCooldown(name)               — rollback (not reached in surface path)
//   getDiagnosticSnapshot()             — feeds buildRecoveryReport
//                                        when surface fires
//
// Surface scenario doesn't drive rollback paths, and the snapshot only
// feeds an informational card the test doesn't assert on. Inherited
// implementations are safe for everything except recordToolCall, which
// we override deterministically.

/**
 * Returns kind:'allow' for the first N-1 calls and kind:'surface' on
 * the Nth — drives the exact "surface fires mid-batch leaving the
 * trailing call un-dispatched" shape that was the original bug.
 */
class StubTurnStateSurfacesAt extends TurnState {
  private recorded = 0;
  constructor(private surfaceAt: number) { super(); }
  recordToolCall(): RecoveryDecision {
    this.recorded++;
    if (this.recorded === this.surfaceAt) {
      return {
        kind: 'surface',
        surfaceCard: {
          title:          'Stub loop surface (v4.9.4 regression test)',
          canStill:       [],
          cannotReliably: [],
          fix:            '',
        },
      };
    }
    return { kind: 'allow' };
  }
}

// ── Capturing provider adapter ───────────────────────────────────────

class CapturingAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  callCount = 0;
  /** Snapshot of every input.messages handed to .call(). */
  readonly capturedMessages: Message[][] = [];
  /**
   * Scripted responses. Each call shifts the front; if empty,
   * terminates with {content:'done', toolCalls:[]}.
   */
  constructor(private scripted: ProviderCallOutput[]) {}
  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    // Deep-ish snapshot — copy each message so later mutations to
    // messages[] don't leak back into the captured shape.
    this.capturedMessages.push(input.messages.map((m) => ({ ...m })));
    this.callCount++;
    if (this.scripted.length === 0) {
      return { content: 'done', toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
    }
    return this.scripted.shift()!;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('AidenAgent — surfaceDecision orphan prevention (v4.9.4 Slice 1)', () => {
  it('FILLS synthetic blocked-tool-result for un-dispatched calls when surface fires mid-batch', async () => {
    // Provider emits 3 tool calls. StubTurnState surfaces at call 2.
    // PRE-FIX: result.messages has assistant with 3 toolCalls but only
    // 2 tool results → orphan. POST-FIX: synthetic 3rd result landed.
    const adapter = new CapturingAdapter([
      {
        content:   '',
        toolCalls: [tc('call-1', 'file_write'), tc('call-2', 'file_write'), tc('call-3', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const agent = new AidenAgent({
      provider:         adapter,
      toolExecutor:     okExecutor,
      tools:            NO_TOOLS,
      turnStateFactory: () => new StubTurnStateSurfacesAt(2),
    });

    const result = await agent.runConversation([userMsg('do 3 things')]);

    // ── Assertion 1: persisted history is invariant-clean.
    //    Pre-fix this throws OrphanToolCallError; the fix removes it.
    expect(() => assertNoUnansweredToolCalls(result.messages)).not.toThrow();

    // ── Assertion 2: every messages[] sent to the provider this turn
    //    is invariant-clean (one call here; the loop is the regression
    //    shape so it holds for any number of calls).
    for (const captured of adapter.capturedMessages) {
      expect(() => assertNoUnansweredToolCalls(captured)).not.toThrow();
    }

    // ── Assertion 3: the synthetic result for call-3 is present in
    //    history with the expected shape. Distinguishes "the fill
    //    fired with the right reason" from "something else accidentally
    //    answered the id".
    const toolMsgs = result.messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    const call3Result = toolMsgs.find((m) => m.toolCallId === 'call-3');
    expect(call3Result).toBeDefined();
    const parsed = JSON.parse(call3Result!.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toBe('tool_loop_surface');
  });

  it('RESUMED HISTORY: a second runConversation pass with the first turn output as prefix completes without preflight throw', async () => {
    // This is the assertion that catches the actual user-facing bug.
    // The orphan from turn 1 only crashes the provider on turn 2 (or
    // whenever the history is replayed). The fix must survive this
    // round-trip — not just look clean in turn-1 output.
    const adapter1 = new CapturingAdapter([
      {
        content:   '',
        toolCalls: [tc('call-1', 'file_write'), tc('call-2', 'file_write'), tc('call-3', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const agent1 = new AidenAgent({
      provider:         adapter1,
      toolExecutor:     okExecutor,
      tools:            NO_TOOLS,
      turnStateFactory: () => new StubTurnStateSurfacesAt(2),
    });
    const r1 = await agent1.runConversation([userMsg('do 3 things')]);

    // Now turn 2 — feed r1's history back in (as if SessionManager
    // resumed the session). Provider returns a clean stop response.
    const adapter2 = new CapturingAdapter([
      { content: 'done after recovery', toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
    ]);
    const agent2 = new AidenAgent({
      provider:         adapter2,
      toolExecutor:     okExecutor,
      tools:            NO_TOOLS,
      // Fresh TurnState — no stub, real production logic. The point
      // of turn 2 is to confirm the resumed history survives the
      // preflight invariant; we don't need to surface again.
    });
    const r2 = await agent2.runConversation([...r1.messages, userMsg('what now')]);

    // The preflight at the top of callProvider would have THROWN
    // OrphanToolCallError if r1.messages still carried an orphan.
    // r2 completing successfully proves the invariant held end-to-end.
    expect(r2.finishReason).toBe('stop');
    expect(r2.finalContent).toBe('done after recovery');
    // And the provider received only clean messages[].
    for (const captured of adapter2.capturedMessages) {
      expect(() => assertNoUnansweredToolCalls(captured)).not.toThrow();
    }
  });
});

describe('AidenAgent — abort-signal orphan prevention (v4.9.4 Slice 1)', () => {
  /**
   * AbortingAdapter — first .call() succeeds with 3 tool calls; the
   * test aborts the signal BEFORE the second .call() would happen.
   * The abort fires inside the dispatch loop's per-tool check, leaving
   * an interrupted turn.
   *
   * To trigger the abort at the right moment, we override toolExecutor
   * to abort the controller on the first call's dispatch — so by the
   * time the loop checks the signal for call 2, it's aborted.
   */
  it('FILLS synthetic results for the interrupted call + skipped remainder when signal fires mid-batch', async () => {
    const ctrl = new AbortController();
    const adapter = new CapturingAdapter([
      {
        content:   '',
        toolCalls: [tc('call-1', 'file_write'), tc('call-2', 'file_write'), tc('call-3', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const abortingExecutor: ToolExecutor = async (call) => {
      // After dispatching the FIRST call, fire the abort so the loop's
      // pre-tool-call check at the TOP of the next iteration trips on
      // its way to call 2.
      if (call.id === 'call-1') ctrl.abort();
      return { id: call.id, name: call.name, result: { ok: true } };
    };
    const agent = new AidenAgent({
      provider:     adapter,
      toolExecutor: abortingExecutor,
      tools:        NO_TOOLS,
      // v4.11 — file_write is mutating, so it stays on the SEQUENTIAL
      // dispatch path (not the parallel read-only batch). Without this,
      // unknown tools default to read-only → all 3 pre-execute via
      // Promise.all, the abort fires mid-batch, and call-1's real result
      // gets overwritten with a synthetic 'interrupted'. Mark mutating to
      // exercise the path this test is actually about: call-1 keeps its
      // result, call-2 interrupted, call-3 skipped.
      resolveMutates: () => true,
    });

    const result = await agent.runConversation(
      [userMsg('do 3 things')],
      { signal: ctrl.signal },
    );

    expect(result.finishReason).toBe('interrupted');

    // ── Assertion 1: persisted history is invariant-clean. This
    //    requires the EXPLICIT messages.push(...turnToolMessages)
    //    inside the abort branch — without it, the synthetic
    //    results we synthesised get discarded along with the
    //    orphans, and this throws.
    expect(() => assertNoUnansweredToolCalls(result.messages)).not.toThrow();

    // ── Assertion 2: synthetic results actually LANDED for both
    //    the interrupted call (call-2) AND the skipped call (call-3).
    //    call-1 has a real (ok) result; call-2 has variant 'interrupted';
    //    call-3 has variant 'skipped'. Distinguishes "synthesized" from
    //    "synthesized + pushed".
    const toolMsgs = result.messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    const call1 = toolMsgs.find((m) => m.toolCallId === 'call-1');
    const call2 = toolMsgs.find((m) => m.toolCallId === 'call-2');
    const call3 = toolMsgs.find((m) => m.toolCallId === 'call-3');
    expect(call1).toBeDefined();
    expect(call2).toBeDefined();
    expect(call3).toBeDefined();

    // call-1 has real success content from okExecutor (not JSON-blocked).
    expect(call1!.content).not.toContain('"blocked":true');

    // call-2 is the call we were ABOUT to dispatch → 'interrupted' variant
    const call2Parsed = JSON.parse(call2!.content);
    expect(call2Parsed.blocked).toBe(true);
    expect(call2Parsed.reason).toBe('cancelled');
    expect(call2Parsed.message).toContain('interrupted before execution');

    // call-3 was never reached → 'skipped' variant
    const call3Parsed = JSON.parse(call3!.content);
    expect(call3Parsed.blocked).toBe(true);
    expect(call3Parsed.reason).toBe('cancelled');
    expect(call3Parsed.message).toContain('skipped because the turn was cancelled');
  });

  it('RESUMED HISTORY: a second runConversation pass with the aborted turn output as prefix completes cleanly', async () => {
    const ctrl = new AbortController();
    const adapter1 = new CapturingAdapter([
      {
        content:   '',
        toolCalls: [tc('call-1', 'file_write'), tc('call-2', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const abortingExecutor: ToolExecutor = async (call) => {
      if (call.id === 'call-1') ctrl.abort();
      return { id: call.id, name: call.name, result: { ok: true } };
    };
    const agent1 = new AidenAgent({
      provider:     adapter1,
      toolExecutor: abortingExecutor,
      tools:        NO_TOOLS,
    });
    const r1 = await agent1.runConversation(
      [userMsg('do 2 things')],
      { signal: ctrl.signal },
    );
    expect(r1.finishReason).toBe('interrupted');

    // Turn 2 against fresh agent + non-aborted signal.
    const adapter2 = new CapturingAdapter([
      { content: 'done after recovery', toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
    ]);
    const agent2 = new AidenAgent({
      provider:     adapter2,
      toolExecutor: okExecutor,
      tools:        NO_TOOLS,
    });
    const r2 = await agent2.runConversation([...r1.messages, userMsg('continue')]);

    // Same as the surface case: if the orphan had survived, preflight
    // would have thrown synchronously. r2 completing proves the fix.
    expect(r2.finishReason).toBe('stop');
    for (const captured of adapter2.capturedMessages) {
      expect(() => assertNoUnansweredToolCalls(captured)).not.toThrow();
    }
  });
});
