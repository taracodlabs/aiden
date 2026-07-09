/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * fix/daemon-zero-iterations — the iteration bound is its own field, one meaning.
 *
 * The conversation loop is bounded by `maxTurns`. A `maxTurns` of 0 (or unset)
 * must mean "use the sane default", NOT "run zero iterations" — a zero bound
 * made the daemon loop exit before the first provider call (no output, empty
 * finalContent). These tests prove: maxTurns 0 still runs the loop and produces
 * output, and an explicit maxTurns is respected (capped, not defaulted).
 */
import { describe, it, expect } from 'vitest';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { TurnState, type RecoveryDecision } from '../../../core/v4/turnState';
import {
  type Message,
  type ProviderAdapter,
  type ProviderCallInput,
  type ProviderCallOutput,
  type ToolSchema,
} from '../../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const USAGE = { inputTokens: 5, outputTokens: 7 };
const userMsg = (c: string): Message => ({ role: 'user', content: c });
const okExecutor: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: { ok: true } });

/** One stop response carrying content — the model's final answer. */
class OneReplyAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  callCount = 0;
  async call(_i: ProviderCallInput): Promise<ProviderCallOutput> {
    this.callCount++;
    return { content: 'Hello from the model.', toolCalls: [], usage: USAGE, finishReason: 'stop' };
  }
}

/** Always returns a fresh tool call — never stops. Probes the iteration cap. */
class InfiniteToolAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  callCount = 0;
  async call(_i: ProviderCallInput): Promise<ProviderCallOutput> {
    this.callCount++;
    return {
      content: '',
      toolCalls: [{ id: `c${this.callCount}`, name: 'file_read', arguments: { path: `/f${this.callCount}` } }],
      usage: USAGE, finishReason: 'tool_calls',
    };
  }
}

/** TurnState that always allows — keeps the loop free of cooldown/surface exits. */
class AllowTurnState extends TurnState {
  recordToolCall(): RecoveryDecision { return { kind: 'allow' } as unknown as RecoveryDecision; }
}

describe('AidenAgent — maxTurns is the iteration bound (fix/daemon-zero-iterations)', () => {
  it('★ maxTurns: 0 runs the loop and produces output (sentinel-0 is not zero iterations)', async () => {
    const provider = new OneReplyAdapter();
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS, maxTurns: 0 });
    const result = await agent.runConversation([userMsg('hi')]);
    // Pre-fix: maxTurns 0 → the loop exits at turnCount 0 → no provider call,
    // finalContent ''. Post-fix: 0 falls back to the default and the loop runs.
    expect(provider.callCount).toBeGreaterThan(0);          // the provider WAS called
    expect(result.turnCount).toBeGreaterThan(0);            // the loop ran
    expect(result.finalContent).toBe('Hello from the model.');
    expect(result.finishReason).toBe('stop');
  });

  it('maxTurns explicitly set is respected — caps the loop, not defaulted to 90', async () => {
    const provider = new InfiniteToolAdapter();
    const agent = new AidenAgent({
      provider, toolExecutor: okExecutor, tools: NO_TOOLS, maxTurns: 2,
      resolveMutates: () => true, turnStateFactory: () => new AllowTurnState(),
    });
    const result = await agent.runConversation([userMsg('loop forever')]);
    expect(provider.callCount).toBe(2);                     // exactly maxTurns calls
    expect(result.turnCount).toBe(2);
    expect(result.finishReason).toBe('budget_exhausted');
  });

  it('maxTurns unset falls back to the sane default (still runs)', async () => {
    const provider = new OneReplyAdapter();
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS });
    const result = await agent.runConversation([userMsg('hi')]);
    expect(result.turnCount).toBeGreaterThan(0);
    expect(result.finalContent).toBe('Hello from the model.');
  });
});
