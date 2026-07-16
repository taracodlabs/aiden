import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { AidenAgent, type ToolExecutor } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import {
  PlannerGuard,
  type PlannerGuardRegistry,
} from '../../moat/plannerGuard';
import {
  initRuntimeToggles,
  _resetRuntimeTogglesForTests,
} from '../../core/v4/runtimeToggles';
import { HonestyEnforcement } from '../../moat/honestyEnforcement';
import { SkillTeacher } from '../../moat/skillTeacher';
import type { ToolHandler } from '../../core/v4/toolRegistry';
import type {
  Message,
  ToolCallRequest,
  ToolCallResult,
  ToolSchema,
} from '../../providers/v4/types';
import type { SkillLoader } from '../../core/v4/skillLoader';

// ── Test fixtures ─────────────────────────────────────────────────────

const userMsg = (content: string): Message => ({ role: 'user', content });

const tc = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCallRequest => ({ id, name, arguments: args });

const okExecutor: ToolExecutor = async (call) => ({
  id: call.id,
  name: call.name,
  result: { ok: true, echoed: call.arguments },
});

const schema = (name: string, toolset: string): ToolSchema => ({
  name,
  description: `${name} (${toolset})`,
  inputSchema: { type: 'object', properties: {} },
});

const handler = (name: string, toolset: string): ToolHandler => ({
  schema: schema(name, toolset),
  category: 'read',
  mutates: false,
  toolset,
  execute: async () => ({}),
});

const REGISTRY_HANDLERS: ToolHandler[] = [
  handler('file_read', 'files'),
  handler('file_write', 'files'),
  handler('web_search', 'web'),
  handler('memory_add', 'memory'),
  handler('skills_list', 'skills'),
  handler('lookup_tool_schema', 'meta'),
  handler('session_search', 'sessions'),
];

const ALL_SCHEMAS = REGISTRY_HANDLERS.map((h) => h.schema);

const registry: PlannerGuardRegistry = {
  list: () => REGISTRY_HANDLERS.map((h) => h.schema.name),
  get: (n) => REGISTRY_HANDLERS.find((h) => h.schema.name === n),
  getSchemas: () => ALL_SCHEMAS,
};

const tmpQualityPath = path.join(
  os.tmpdir(),
  `aiden-agent-moat-${Date.now()}.json`,
);

// ── Tests ──────────────────────────────────────────────────────────────

describe('AidenAgent — without moat (baseline)', () => {
  it('1. existing behavior unchanged when no moat layers wired', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'web_search', { q: 'x' })]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
    });
    const result = await agent.runConversation([userMsg('search')]);
    expect(result.finalContent).toBe('done');
    expect(result.toolCallCount).toBe(1);
    expect(result.toolCallTrace).toHaveLength(1);
    expect(result.honestyFindings).toBeUndefined();
    expect(result.skillCreated).toBeUndefined();
  });
});

describe('AidenAgent — PlannerGuard wiring', () => {
  // v4.6 Phase 2M — PlannerGuard's per-turn narrowing is opt-in
  // (default OFF). Tests that assert narrowed behaviour explicitly
  // initialise the runtime toggles singleton with `planner_guard: ON`
  // via env. Reset between cases so other test files see the default.
  beforeEach(() => {
    process.env.AIDEN_PLANNER_GUARD = '1';
    _resetRuntimeTogglesForTests();
    initRuntimeToggles({ env: process.env });
  });
  afterEach(() => {
    delete process.env.AIDEN_PLANNER_GUARD;
    _resetRuntimeTogglesForTests();
  });

  it('2. tools narrowed before loop based on user message', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
    });
    await agent.runConversation([userMsg('please write this file')]);
    // Inspect the tools the provider received — must NOT include web_search.
    const toolsSeen = provider.capturedInputs[0].tools.map((t) => t.name);
    expect(toolsSeen).toContain('file_write');
    expect(toolsSeen).toContain('skills_list'); // core
    expect(toolsSeen).not.toContain('web_search');
    expect(toolsSeen).not.toContain('memory_add');
  });

  it('3. onPlannerGuardDecision callback fires with the decision', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const onDecision = vi.fn();
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
      onPlannerGuardDecision: onDecision,
    });
    await agent.runConversation([userMsg('search the web')]);
    expect(onDecision).toHaveBeenCalledOnce();
    const decision = onDecision.mock.calls[0][0];
    expect(decision.selectedTools).toContain('web_search');
  });

  it('3a. agent resets PlannerGuard.activeToolsets per runConversation (Phase 16f Task 5)', async () => {
    // Prove no carryover: a skill that activated the `web` toolset in
    // a prior turn should not force web_search into a totally
    // unrelated next turn ("remember concise answers"). Without the
    // reset, activeToolsets persists across runConversation calls.
    const guard = new PlannerGuard(registry, 'rule_based');
    // Pre-condition: with web activated, guard would include web_search
    // even on an unrelated message.
    guard.activateToolsets(['web']);
    expect(
      (await guard.decide('hello', [])).selectedTools,
    ).toContain('web_search');

    // Now a fresh runConversation. Agent must clear activation before
    // calling decide; new turn's selection should NOT include web tools
    // because "remember concise answers" doesn't trigger web rules.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('saved'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
    });
    await agent.runConversation([
      userMsg('remember that I prefer concise answers'),
    ]);
    const toolsSeen = provider.capturedInputs[0].tools.map((t) => t.name);
    expect(toolsSeen).not.toContain('web_search');
    // memory_add IS expected — "remember" matches the memory rule.
    expect(toolsSeen).toContain('memory_add');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// v4.6 Phase 2M — PlannerGuard opt-in toggle
// ──────────────────────────────────────────────────────────────────────────

describe('AidenAgent — PlannerGuard opt-in toggle (v4.6 Phase 2M)', () => {
  beforeEach(() => {
    // Make sure no prior test left the env / singleton dirty.
    delete process.env.AIDEN_PLANNER_GUARD;
    _resetRuntimeTogglesForTests();
  });
  afterEach(() => {
    delete process.env.AIDEN_PLANNER_GUARD;
    _resetRuntimeTogglesForTests();
  });

  it('A. default OFF: narrowTools returns full this.tools even when plannerGuard wired', async () => {
    // No env, no slash command. Default state of planner_guard is OFF.
    initRuntimeToggles({ env: process.env });
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
    });
    // User message that would normally narrow to ONLY file tools.
    await agent.runConversation([userMsg('please write this file')]);
    const toolsSeen = provider.capturedInputs[0].tools.map((t) => t.name);
    // With toggle OFF, full catalog flows through — web_search remains
    // visible to the model despite the file-only intent.
    expect(toolsSeen).toContain('file_write');
    expect(toolsSeen).toContain('web_search');
    expect(toolsSeen).toContain('memory_add');
  });

  it('B. AIDEN_PLANNER_GUARD=1 in env: narrowing engages', async () => {
    process.env.AIDEN_PLANNER_GUARD = '1';
    initRuntimeToggles({ env: process.env });
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
    });
    await agent.runConversation([userMsg('please write this file')]);
    const toolsSeen = provider.capturedInputs[0].tools.map((t) => t.name);
    expect(toolsSeen).toContain('file_write');
    expect(toolsSeen).not.toContain('web_search');
  });

  it('C. live flip via runtimeToggles.set: turn 1 OFF, turn 2 ON narrows', async () => {
    initRuntimeToggles({ env: process.env });
    // Two-turn scripted provider — both turns are simple `stop` responses.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('one'),
      MockProviderAdapter.stop('two'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
    });

    // Turn 1: toggle OFF (default) — full catalog.
    await agent.runConversation([userMsg('please write this file')]);
    const turn1Tools = provider.capturedInputs[0].tools.map((t) => t.name);
    expect(turn1Tools).toContain('web_search');

    // Flip the toggle mid-session (simulates /planner-guard on).
    const { getRuntimeToggles } = await import('../../core/v4/runtimeToggles');
    await getRuntimeToggles().set('planner_guard', true, { persist: false });

    // Turn 2: toggle ON — narrowing engages on the next call.
    await agent.runConversation([userMsg('please write this file')]);
    const turn2Tools = provider.capturedInputs[1].tools.map((t) => t.name);
    expect(turn2Tools).toContain('file_write');
    expect(turn2Tools).not.toContain('web_search');
  });

  it('D. no plannerGuard wired: still no-op regardless of toggle', async () => {
    process.env.AIDEN_PLANNER_GUARD = '1';
    initRuntimeToggles({ env: process.env });
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    // No plannerGuard option passed.
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
    });
    await agent.runConversation([userMsg('please write this file')]);
    const toolsSeen = provider.capturedInputs[0].tools.map((t) => t.name);
    // Full catalog — no plannerGuard wired, so the toggle is moot
    // (narrowTools returns this.tools because !this.plannerGuard).
    expect(toolsSeen).toContain('file_write');
    expect(toolsSeen).toContain('web_search');
  });
});

/**
 * v4.7.0 Phase 2.5 — wiring tests for the outcome-based verifier.
 *
 * Asserts the integration between AidenAgent.runConversation and
 * HonestyEnforcement.check at the post-loop scan site
 * (aidenAgent.ts:712-727). Three invariants:
 *
 *   - finalContent remains clean when enforce mode finds unverified outcomes
 *   - findings are captured into honestyFindings regardless of mode
 *     (off mode short-circuits before this point)
 *   - loopResult.messages history is NEVER mutated by the verifier
 *     (the v4.6.x correctedResponse path that mutated message[].content
 *     is gone)
 */
describe('AidenAgent — HonestyEnforcement wiring', () => {
  // The verifier only fires the mutation_errored event for tools whose
  // resolveMutates returns true. For the wiring tests, mark file_write
  // and memory_add as mutating.
  const mutatingTools = new Set(['file_write', 'memory_add', 'memory_replace', 'memory_remove']);
  const resolveMutates = (name: string): boolean | undefined =>
    mutatingTools.has(name) ? true : false;

  it('4. clean turn (no errors): no findings, no footer, finalContent unchanged', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'file_write', {})]),
      MockProviderAdapter.stop('I saved the file to disk.'),
    ]);
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      honestyEnforcement: honesty,
      resolveMutates,
    });
    const result = await agent.runConversation([userMsg('save the file')]);
    expect(result.finalContent).toBe('I saved the file to disk.');
    expect(result.honestyFindings).toHaveLength(0);
  });

  it('5. mutating tool errored: structured findings returned, content and history untouched', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'file_write', {})]),
      MockProviderAdapter.stop('I saved the file.'),
    ]);
    const erroringExecutor: ToolExecutor = async (call) => ({
      id:     call.id,
      name:   call.name,
      result: null,
      error:  'EACCES: permission denied',
    });
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor: erroringExecutor,
      tools: ALL_SCHEMAS,
      honestyEnforcement: honesty,
      resolveMutates,
    });
    const result = await agent.runConversation([userMsg('save the file')]);

    expect(result.finalContent).toBe('I saved the file.');
    expect(result.finalContent).not.toContain('Verifier');

    expect(result.honestyFindings).toBeDefined();
    expect(result.honestyFindings).toHaveLength(1);
    expect(result.honestyFindings![0].reason).toBe('tool_errored');

    // CRITICAL invariant: neither caller-visible content nor history is
    // mutated by presentation prose.
    const lastAssistant = [...result.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && (!m.toolCalls || m.toolCalls.length === 0));
    expect(lastAssistant?.content).toBe('I saved the file.');
  });

  it('6. memory_add verified=false: structured finding returned with clean content', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'memory_add', { fact: 'x' })]),
      MockProviderAdapter.stop('I remembered that fact.'),
    ]);
    const memExecutor: ToolExecutor = async (call) => ({
      id:     call.id,
      name:   call.name,
      result: { verified: false, reason: 'duplicate' },
    });
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor:        memExecutor,
      tools:               ALL_SCHEMAS,
      honestyEnforcement:  honesty,
      resolveMutates,
      resolveVerifiedFlag: (r) => {
        const v = (r.result as { verified?: boolean })?.verified;
        return typeof v === 'boolean' ? v : undefined;
      },
    });
    const result = await agent.runConversation([
      userMsg('remember my color is purple'),
    ]);
    expect(result.toolCallTrace[0].verified).toBe(false);
    expect(result.honestyFindings).toHaveLength(1);
    expect(result.honestyFindings![0].reason).toBe('memory_verified_false');

    expect(result.finalContent).toBe('I remembered that fact.');
    expect(result.finalContent).not.toContain('Verifier');
  });

  it('7. detect mode: findings captured but no footer appended', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'file_write', {})]),
      MockProviderAdapter.stop('I saved.'),
    ]);
    const erroringExecutor: ToolExecutor = async (call) => ({
      id: call.id, name: call.name, result: null, error: 'fail',
    });
    const honesty = new HonestyEnforcement('detect');
    const agent = new AidenAgent({
      provider,
      toolExecutor:       erroringExecutor,
      tools:              ALL_SCHEMAS,
      honestyEnforcement: honesty,
      resolveMutates,
    });
    const result = await agent.runConversation([userMsg('x')]);

    // finalContent is the raw model output — no footer in detect mode.
    expect(result.finalContent).toBe('I saved.');
    // But the finding is still captured for telemetry.
    expect(result.honestyFindings).toHaveLength(1);
    expect(result.honestyFindings![0].reason).toBe('tool_errored');
  });

  it('8. model claims action with no tool fired: no finding (no false refusal)', async () => {
    // The v4.6.x verifier would have flagged "model said saved, no
    // file_write fired" as no_tool_call. The new verifier records
    // OUTCOMES only — silence on missing tools. This test guards
    // against regression to the false-refusal behaviour.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('I saved the file to disk.'),
    ]);
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      honestyEnforcement: honesty,
      resolveMutates,
    });
    const result = await agent.runConversation([userMsg('save the file')]);
    expect(result.finalContent).toBe('I saved the file to disk.');
    expect(result.honestyFindings).toHaveLength(0);
  });
});

describe('AidenAgent — SkillTeacher wiring', () => {
  it('7. observation called after loop, proposal triggers skill_manage', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([
        tc('1', 'file_read', {}),
        tc('2', 'web_search', {}),
        tc('3', 'web_search', {}),
        tc('4', 'memory_add', {}),
        tc('5', 'file_write', {}),
      ]),
      MockProviderAdapter.stop('done'),
    ]);
    const skillManager = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    const teacher = new SkillTeacher(
      {} as SkillLoader,
      skillManager,
      'tier_4_auto',
      tmpQualityPath,
      (n) => REGISTRY_HANDLERS.find((h) => h.schema.name === n),
    );
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      skillTeacher: teacher,
      resolveToolset: (n) =>
        REGISTRY_HANDLERS.find((h) => h.schema.name === n)?.toolset,
    });
    // Phase 16b.2: SkillTeacher no longer proposes on the first turn,
    // so the test history is two user messages — turn 2 is when
    // proposals can fire.
    const result = await agent.runConversation([
      userMsg('research the topic and save the findings to a note'),
      userMsg('continue please'),
    ]);
    expect(result.skillCreated).toBeDefined();
    expect(skillManager.execute).toHaveBeenCalledOnce();
  });

  it('8. skillTeacherCallbacks.promptUser wiring surfaces proposal to caller (v4.1.6 Polish 2)', async () => {
    // v4.1.6 Polish 2 — architectural pull-out.
    //
    // BEFORE: when `promptUser` callback was wired, the agent loop
    // synchronously called `handleProposal` (which invoked promptUser
    // and then skillManager.execute) IN-LINE before returning. This
    // fired the inquirer prompt mid-render, clobbering the agent reply
    // (visual smoke regression).
    //
    // AFTER: the agent detects a wired promptUser, sets
    // `result.skillProposal` to the proposal, and SKIPS the inline
    // handleProposal call. The caller (chatSession) renders the reply
    // first, then drives the prompt/save flow via
    // `callbacks.handleSkillProposal`.
    //
    // Contract:
    //   - promptUser is NOT called by the agent
    //   - skillManager.execute is NOT called by the agent
    //   - result.skillProposal IS defined (surfaced for the caller)
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([
        tc('1', 'file_read', {}),
        tc('2', 'web_search', {}),
        tc('3', 'web_search', {}),
        tc('4', 'memory_add', {}),
        tc('5', 'file_write', {}),
      ]),
      MockProviderAdapter.stop('done'),
    ]);
    const skillManager = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    const teacher = new SkillTeacher(
      {} as SkillLoader,
      skillManager,
      'tier_3_propose',
      tmpQualityPath,
      (n) => REGISTRY_HANDLERS.find((h) => h.schema.name === n),
    );
    const promptUser = vi.fn().mockResolvedValue(true);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      skillTeacher: teacher,
      skillTeacherCallbacks: { promptUser },
      resolveToolset: (n) =>
        REGISTRY_HANDLERS.find((h) => h.schema.name === n)?.toolset,
    });
    const result = await agent.runConversation([
      userMsg('research the topic and save the findings to a note'),
      userMsg('continue please'),
    ]);
    // promptUser stays untouched — the caller drives that flow now.
    expect(promptUser).not.toHaveBeenCalled();
    // skillManager.execute is deferred until the caller decides to save.
    expect(skillManager.execute).not.toHaveBeenCalled();
    // The proposal IS surfaced for chatSession's post-render handler.
    expect(result.skillProposal).toBeDefined();
  });
});

describe('AidenAgent — moat composition', () => {
  it('9. all three layers compose without interference', async () => {
    // PlannerGuard narrows tools, agent calls tools, Honesty inspects,
    // SkillTeacher proposes — and they all coexist.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([
        tc('1', 'file_read', {}),
        tc('2', 'file_write', {}),
        tc('3', 'memory_add', {}),
        tc('4', 'memory_add', {}),
        tc('5', 'file_write', {}),
      ]),
      MockProviderAdapter.stop('I saved the file to disk.'),
    ]);
    const guard = new PlannerGuard(registry, 'rule_based');
    const honesty = new HonestyEnforcement('enforce');
    const skillManager = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    const teacher = new SkillTeacher(
      {} as SkillLoader,
      skillManager,
      'tier_4_auto',
      tmpQualityPath,
      (n) => REGISTRY_HANDLERS.find((h) => h.schema.name === n),
    );
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      plannerGuard: guard,
      honestyEnforcement: honesty,
      skillTeacher: teacher,
      resolveToolset: (n) =>
        REGISTRY_HANDLERS.find((h) => h.schema.name === n)?.toolset,
    });
    const result = await agent.runConversation([
      userMsg('save the file then remember the path for later'),
      userMsg('keep going please'),
    ]);
    // Honesty: file_write fired → "I saved the file to disk." passes.
    expect(result.finalContent).toBe('I saved the file to disk.');
    // SkillTeacher: 5 calls + 2 toolsets (files+memory) → proposal → created.
    expect(result.skillCreated).toBeDefined();
    // Trace populated.
    expect(result.toolCallTrace).toHaveLength(5);
  });

  it('10. toolCallTrace shape matches the executed calls in order', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([
        tc('a', 'file_read', { x: 1 }),
        tc('b', 'web_search', { q: 'y' }),
      ]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
    });
    const result = await agent.runConversation([userMsg('do things')]);
    expect(result.toolCallTrace).toHaveLength(2);
    expect(result.toolCallTrace[0].name).toBe('file_read');
    expect(result.toolCallTrace[1].name).toBe('web_search');
    expect(result.toolCallTrace[0].error).toBeUndefined();
  });
});
