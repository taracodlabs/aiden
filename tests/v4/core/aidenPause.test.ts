/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the mid-turn PAUSE gate at the safe loop boundary. Proves the loop
 * awaits `waitForResumeIfPaused` at the SAME point steer drains (history
 * balanced, before the next provider call): /pause freezes the turn there, and
 * either /resume continues it or a Ctrl+C abort stops it cleanly. Uses the REAL
 * DuringTurnInput engine wired through the loop hook — end-to-end, deterministic
 * (no timers): the boundary signals itself so there is no wall-clock race.
 */
import { describe, it, expect } from 'vitest';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { DuringTurnInput } from '../../../cli/v4/duringTurnInput';
import type { Message } from '../../../providers/v4/types';

const userMsg = (c: string): Message => ({ role: 'user', content: c });
const execOk: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: `ran ${call.name}` });

describe('mid-turn pause gate', () => {
  it('freezes the loop at the safe boundary and resumes on /resume', async () => {
    // iter 1 → a tool call; loop hits the boundary and (paused) freezes; on
    // resume, iter 2 fires and stops.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: {} }]),
      MockProviderAdapter.stop('done'),
    ]);
    const engine = new DuringTurnInput();
    engine.requestPause();
    let atBoundary!: () => void;
    const reached = new Promise<void>((r) => { atBoundary = r; });

    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    const run = agent.runConversation([userMsg('go')], {
      waitForResumeIfPaused: async (sig) => { atBoundary(); await engine.waitWhilePaused(sig); },
    });

    await reached;                                    // loop reached the boundary + is frozen
    expect(provider.capturedInputs).toHaveLength(1);  // the 2nd provider call has NOT fired
    engine.resume();
    await run;
    expect(provider.capturedInputs).toHaveLength(2);  // resumed → 2nd provider call fired
  });

  it('a Ctrl+C abort DURING a pause stops the turn (no further provider call)', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: {} }]),
      MockProviderAdapter.stop('must not run'),
    ]);
    const engine = new DuringTurnInput();
    engine.requestPause();
    const ac = new AbortController();
    let atBoundary!: () => void;
    const reached = new Promise<void>((r) => { atBoundary = r; });

    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    const run = agent.runConversation([userMsg('go')], {
      signal: ac.signal,
      waitForResumeIfPaused: async (sig) => { atBoundary(); await engine.waitWhilePaused(sig); },
    });

    await reached;
    expect(provider.capturedInputs).toHaveLength(1);
    ac.abort();                                       // Ctrl+C while paused
    await run;
    expect(provider.capturedInputs).toHaveLength(1);  // 2nd provider call NEVER fired — turn stopped
  });

  it('a turn that is NOT paused runs straight through (hook resolves immediately)', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: {} }]),
      MockProviderAdapter.stop('done'),
    ]);
    const engine = new DuringTurnInput();                 // never paused
    const agent = new AidenAgent({ provider, tools: [], toolExecutor: execOk });
    await agent.runConversation([userMsg('go')], {
      waitForResumeIfPaused: (sig) => engine.waitWhilePaused(sig),
    });
    expect(provider.capturedInputs).toHaveLength(2);      // no freeze
  });
});
