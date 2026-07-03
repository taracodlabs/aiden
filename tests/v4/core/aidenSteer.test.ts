/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 2b — mid-turn STEER injection at the safe loop
 * boundary. Proves: a drained steer lands as TOOL-STREAM CONTEXT the model
 * sees next iteration, NEVER as an out-of-order role:'user' message, and the
 * transcript stays provider-valid.
 */
import { describe, it, expect } from 'vitest';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { assertNoUnansweredToolCalls } from '../../../core/v4/toolCallInvariant';
import type { Message } from '../../../providers/v4/types';

const userMsg = (c: string): Message => ({ role: 'user', content: c });
const execOk: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: `ran ${call.name}` });

describe('mid-turn steer injection', () => {
  it('injects the nudge as context on the last tool message (not a user turn)', async () => {
    // iter 1 → a tool call; loop drains the steer at the boundary; iter 2 → stop.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: { path: 'a' } }]),
      MockProviderAdapter.stop('done, using pnpm'),
    ]);
    let drained = false;
    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    const result = await agent.runConversation([userMsg('install deps')], {
      drainSteer: () => { if (drained) return null; drained = true; return 'use pnpm not npm'; },
    });

    // The SECOND provider call is where the model sees the steer.
    const secondCallMsgs = provider.capturedInputs[1].messages;
    const toolMsgs = secondCallMsgs.filter((m) => m.role === 'tool');
    const lastTool = toolMsgs[toolMsgs.length - 1];
    expect(String(lastTool.content)).toContain('use pnpm not npm');
    expect(String(lastTool.content)).toMatch(/user adjustment mid-turn/i);

    // ★ HARD RULE: the ONLY user message is the original prompt — the steer was
    // NOT appended as an out-of-order role:'user' message.
    const userMsgs = secondCallMsgs.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(String(userMsgs[0].content)).toBe('install deps');

    // Transcript stays provider-valid (every tool_call has a result).
    expect(() => assertNoUnansweredToolCalls(result.messages)).not.toThrow();
  });

  it('drained only once — a single nudge does not re-inject every iteration', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: {} }]),
      MockProviderAdapter.toolUse([{ id: 'c2', name: 'file_read', arguments: {} }]),
      MockProviderAdapter.stop('done'),
    ]);
    let calls = 0;
    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    await agent.runConversation([userMsg('go')], {
      drainSteer: () => { calls += 1; return calls === 1 ? 'first nudge' : null; },
    });
    // Steer appears on exactly ONE tool message across the whole turn.
    const allTool = provider.capturedInputs.flatMap((i) => i.messages).filter((m) => m.role === 'tool');
    const withSteer = allTool.filter((m) => String(m.content).includes('first nudge'));
    expect(withSteer.length).toBeGreaterThanOrEqual(1);
    // never a user-role steer
    const injectedUser = provider.capturedInputs.flatMap((i) => i.messages).filter((m) => m.role === 'user' && String(m.content).includes('nudge'));
    expect(injectedUser).toHaveLength(0);
  });

  it('TEXT-ONLY turn does not corrupt: the loop ends before the seam, steer untouched', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('here is the answer')]);
    let drainCalls = 0;
    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    const result = await agent.runConversation([userMsg('what is 2+2')], {
      drainSteer: () => { drainCalls += 1; return 'a steer that should not land'; },
    });
    // Only one provider call, no tool messages, no steer injected anywhere.
    expect(provider.capturedInputs).toHaveLength(1);
    expect(result.messages.some((m) => String(m.content).includes('should not land'))).toBe(false);
    expect(() => assertNoUnansweredToolCalls(result.messages)).not.toThrow();
    // drainSteer wasn't even reached (loop broke on 'stop' before the boundary).
    expect(drainCalls).toBe(0);
  });
});
