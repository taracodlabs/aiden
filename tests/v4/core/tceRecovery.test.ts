/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/core/tceRecovery.test.ts — v4.1.6 spike integration.
 *
 * End-to-end recovery scenarios with a real AidenAgent + synthetic
 * looping mock provider. Asserts:
 *
 *   1. Default off (AIDEN_TCE unset): zero behavioural change. Loop
 *      runs until maxTurns / mock terminates. No system messages
 *      injected. No tool_loop finishReason.
 *
 *   2. Flag on, no loop: realistic tool sequence completes normally,
 *      no recovery fires. False-positive guard.
 *
 *   3. Flag on, hint stage: 5 identical-signature calls → corrective
 *      system message lands in conversation history before the next
 *      provider call.
 *
 *   4. Flag on, cooldown stage: 8 same-name (diff args) calls →
 *      tool excluded from `tools` schema on subsequent provider calls.
 *
 *   5. Flag on, surface stage: 11 same-name calls → turn ends with
 *      finishReason='tool_loop' and a populated toolLoopCard.
 *
 *   6. Surface card includes earlier-successful tools in `canStill`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { Message, ToolCallRequest, ToolCallResult, ToolSchema } from '../../../providers/v4/types';
import { LoopingMockProvider } from '../_helpers/loopingMockProvider';

// Stub tool registry — only schemas matter for filtering tests.
const STUB_TOOLS: ToolSchema[] = [
  { name: 'skill_view',   description: 'view a skill',     inputSchema: {} },
  { name: 'web_search',   description: 'search the web',   inputSchema: {} },
  { name: 'fetch_page',   description: 'fetch a URL',      inputSchema: {} },
  { name: 'execute_code', description: 'run python',      inputSchema: {} },
];

// Stub executor — returns a benign result so the agent loop keeps
// going. Doesn't matter what the result IS for these tests; what
// matters is which tools the mock provider chose to call.
const STUB_EXECUTOR = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
  id:     call.id,
  name:   call.name,
  result: { ok: true },
});

// v4.13 — cooldown/surface gate on LOOP-LIKE streaks (identical args or
// consecutive FAILURES); varied-args streaks that keep succeeding are
// legitimate bulk work. The name-streak tests below drive a FAILING
// loop — the real stuck-loop shape those stages exist for.
const FAILING_EXECUTOR = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
  id:     call.id,
  name:   call.name,
  result: { success: false, error: 'simulated stuck-loop failure (stub)' },
});

describe('TCE end-to-end recovery (v4.1.6 spike)', () => {
  beforeEach(() => {
    delete process.env.AIDEN_TCE;
  });

  afterEach(() => {
    delete process.env.AIDEN_TCE;
  });

  it('opt-out via AIDEN_TCE=0: zero recovery — loop runs until mock terminates', async () => {
    // v4.2 Phase 6 — TCE is ON by default; explicit `=0` opts out
    // and produces the pre-v4.2 behavior asserted below. Renamed
    // from "default off" to reflect the new semantics.
    process.env.AIDEN_TCE = '0';
    const provider = new LoopingMockProvider({
      mode:       'same-signature',
      loopTool:   'skill_view',
      loopCount:  15,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: STUB_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'analyse stocks' }] as Message[],
    );
    // 15 looping turns + 1 terminal = 16 calls.
    expect(provider.callCount).toBe(16);
    // Finished normally — no tool_loop.
    expect(result.finishReason).toBe('stop');
    expect(result.toolLoopCard).toBeUndefined();
    // No `[tce]` system messages injected.
    const tceMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[tce]'),
    );
    expect(tceMsgs).toHaveLength(0);
  });

  it('v4.2 Phase 6 — default ON: TCE active when env var unset', async () => {
    // Default-on sentinel for Phase 6 flip. With no env var set,
    // TCE should be active — a same-signature loop should reach
    // the HINT stage at iteration 5 (signature streak threshold).
    delete process.env.AIDEN_TCE;
    const provider = new LoopingMockProvider({
      mode:       'same-signature',
      loopTool:   'skill_view',
      loopCount:  15,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: STUB_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'analyse stocks' }] as Message[],
    );
    // With TCE on, at least one [tce] corrective system message
    // must have landed in history (HINT at signature streak 5).
    const tceMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[tce]'),
    );
    expect(tceMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('flag on, mock doesn\'t loop: no recovery fires (false-positive guard)', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:       'mixed',  // diverse tools, no long loop
      loopTool:   'skill_view',
      loopCount:  3,        // only 3 mixed calls then terminal
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: STUB_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'do mixed work' }] as Message[],
    );
    expect(result.finishReason).toBe('stop');
    expect(result.toolLoopCard).toBeUndefined();
    // No `[tce]` system messages.
    const tceMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[tce]'),
    );
    expect(tceMsgs).toHaveLength(0);
  });

  it('flag on, same-signature loop: hint system message injected at 5', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:       'same-signature',
      loopTool:   'skill_view',
      staticArgs: { name: 'nse-scanner' },
      loopCount:  6, // 6 identical calls + terminal — should hit hint at 5
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: STUB_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'find a skill' }] as Message[],
    );
    // Hint message must have landed in messages.
    const hintMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' &&
             m.content.startsWith('[tce]') && /reconsider/i.test(m.content),
    );
    expect(hintMsgs.length).toBeGreaterThanOrEqual(1);
    expect(hintMsgs[0]!.content).toMatch(/skill_view/);
    expect(hintMsgs[0]!.content).toMatch(/5 times/);
  });

  it('flag on, same-name-diff-args loop: cooldown excludes tool from schemas at 8', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:          'same-name-diff-args',
      loopTool:      'skill_view',
      loopCount:     9,
      honorCooldown: true, // terminates as soon as cooldown filters skill_view
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'explore skills' }] as Message[],
    );
    // v4.2 Phase 4 — cooldown stage now emits either a plain
    // "disabled" cooldown message OR a "Rolled back" message
    // (depending on rollback eligibility). Substantive behavior is
    // the same: the looping tool is cooled down and a corrective
    // system message lands in history. Accept either phrasing.
    const cdMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' &&
             m.content.startsWith('[tce]') &&
             (m.content.includes('disabled') || m.content.includes('Rolled back')),
    );
    expect(cdMsgs.length).toBeGreaterThanOrEqual(1);
    expect(cdMsgs[0]!.content).toMatch(/skill_view/);
    // Provider's most-recent call should have seen `skill_view` filtered
    // from the schemas. The mock terminates immediately when
    // `honorCooldown` is true and the tool disappears.
    expect(provider.lastToolNames).not.toContain('skill_view');
  });

  it('flag on, sustained loop: surface stage ends turn with tool_loop finishReason', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:          'same-name-diff-args',
      loopTool:      'skill_view',
      loopCount:     15, // way beyond surface threshold
      honorCooldown: false, // keep looping even after cooldown
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'be stuck' }] as Message[],
    );
    expect(result.finishReason).toBe('tool_loop');
    expect(result.toolLoopCard).toBeDefined();
    expect(result.toolLoopCard!.title).toMatch(/Stuck on repeated tool calls/i);
    expect(result.toolLoopCard!.cannotReliably[0]).toMatch(/skill_view/);
    // finalContent is empty on tool_loop — the card IS the surface.
    expect(result.finalContent).toBe('');
  });

  it('surface card lists earlier successful tools in canStill', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:          'mixed', // 3 distinct tools then loop
      loopTool:      'skill_view',
      loopCount:     15,
      honorCooldown: false,
    });
    // v4.2 Phase 4 — declare every tool as mutating so rollback is
    // never eligible and the surface stage fires deterministically.
    // This preserves the test's original intent (assert surface card
    // contents) without coupling it to Phase 4 rollback semantics.
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 30,
      resolveMutates: () => true,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'mixed then loop' }] as Message[],
    );
    expect(result.finishReason).toBe('tool_loop');
    expect(result.toolLoopCard).toBeDefined();
    const canStillText = result.toolLoopCard!.canStill.join('\n');
    // The 3 unique tools should be referenced in `canStill`.
    expect(canStillText).toMatch(/web_search/);
    expect(canStillText).toMatch(/fetch_page/);
    expect(canStillText).toMatch(/execute_code/);
    // The looping tool should NOT be in `canStill` (it's in cannotReliably).
    expect(canStillText).not.toMatch(/`skill_view`/);
  });

  it('honorCooldown=true confirms cooldown survives provider re-prompting', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode:          'same-name-diff-args',
      loopTool:      'skill_view',
      loopCount:     20,
      honorCooldown: true,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 30,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'sustained skill probe' }] as Message[],
    );
    // After cooldown, mock returns terminal text → finishReason === 'stop'.
    // Surface should NOT fire because cooldown took the tool away early.
    expect(result.finishReason).toBe('stop');
    // v4.2 Phase 4 — cooldown system message can be either the plain
    // "disabled" form (Phase 1 behavior) OR the "Rolled back" form
    // (Phase 4 with restorable checkpoint). Substantive contract is
    // the same: a corrective `[tce]` system message lands in history.
    const cdMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' &&
             m.content.startsWith('[tce]') &&
             (m.content.includes('disabled') || m.content.includes('Rolled back')),
    );
    expect(cdMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
