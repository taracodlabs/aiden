import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { AidenAgent, type ToolExecutor } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import {
  PlannerGuard,
  type PlannerGuardRegistry,
} from '../../moat/plannerGuard';
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
});

describe('AidenAgent — HonestyEnforcement wiring', () => {
  it('4. failed claims rewritten in finalContent', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('I saved the file to disk.'),
    ]);
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: ALL_SCHEMAS,
      honestyEnforcement: honesty,
    });
    const result = await agent.runConversation([userMsg('save the file')]);
    expect(result.honestyFindings).toBeDefined();
    expect(result.honestyFindings![0].found).toBe(false);
    expect(result.finalContent).toContain("I shouldn't claim");
  });

  it('5. honest claim passes through unchanged', async () => {
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
    });
    const result = await agent.runConversation([userMsg('save the file')]);
    expect(result.finalContent).toBe('I saved the file to disk.');
    expect(result.honestyFindings).toBeUndefined();
  });

  it('6. memory verified=false detected and rewritten', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'memory_add', { fact: 'x' })]),
      MockProviderAdapter.stop('I remembered that fact.'),
    ]);
    // Tool returns a result with verified=false.
    const memExecutor: ToolExecutor = async (call) => ({
      id: call.id,
      name: call.name,
      result: { verified: false, reason: 'duplicate' },
    });
    const honesty = new HonestyEnforcement('enforce');
    const agent = new AidenAgent({
      provider,
      toolExecutor: memExecutor,
      tools: ALL_SCHEMAS,
      honestyEnforcement: honesty,
      resolveVerifiedFlag: (r) => {
        const v = (r.result as { verified?: boolean })?.verified;
        return typeof v === 'boolean' ? v : undefined;
      },
    });
    const result = await agent.runConversation([
      userMsg('remember my color is purple'),
    ]);
    expect(result.toolCallTrace[0].verified).toBe(false);
    expect(result.honestyFindings).toBeDefined();
    expect(result.honestyFindings![0].reason).toBe('memory_verified_false');
    expect(result.finalContent).toContain('NOT VERIFIED');
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

  it('8. skillTeacherCallbacks.promptUser fires correctly in tier_3', async () => {
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
    await agent.runConversation([
      userMsg('research the topic and save the findings to a note'),
      userMsg('continue please'),
    ]);
    expect(promptUser).toHaveBeenCalledOnce();
    expect(skillManager.execute).toHaveBeenCalledOnce();
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
