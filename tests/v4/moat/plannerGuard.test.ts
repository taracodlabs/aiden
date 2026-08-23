import { describe, it, expect, vi } from 'vitest';
import {
  PlannerGuard,
  type PlannerGuardRegistry,
} from '../../../moat/plannerGuard';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type {
  ProviderAdapter,
  ProviderCallOutput,
  ToolSchema,
} from '../../../providers/v4/types';

// ── Test fixtures ──────────────────────────────────────────────────

const schema = (name: string, description = ''): ToolSchema => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

const handler = (name: string, toolset?: string): ToolHandler => ({
  schema: schema(name),
  category: 'read',
  mutates: false,
  toolset,
  execute: async () => ({}),
});

class MockRegistry implements PlannerGuardRegistry {
  constructor(private readonly handlers: ToolHandler[]) {}
  list(): string[] {
    return this.handlers.map((h) => h.schema.name);
  }
  get(name: string): ToolHandler | undefined {
    return this.handlers.find((h) => h.schema.name === name);
  }
  getSchemas(filterToolsets?: string[]): ToolSchema[] {
    return this.handlers
      .filter(
        (h) =>
          !filterToolsets ||
          filterToolsets.length === 0 ||
          (h.toolset && filterToolsets.includes(h.toolset)),
      )
      .map((h) => h.schema);
  }
}

const FULL_REGISTRY = new MockRegistry([
  handler('file_read', 'files'),
  handler('file_write', 'files'),
  handler('web_search', 'web'),
  handler('web_fetch', 'web'),
  handler('browser_click', 'browser'),
  handler('browser_screenshot', 'browser'),
  handler('shell_exec', 'terminal'),
  handler('execute_code', 'execute'),
  handler('memory_add', 'memory'),
  handler('memory_remove', 'memory'),
  handler('aiden_status', 'status'),
  handler('skills_list', 'skills'),
  handler('skill_view', 'skills'),
  handler('lookup_tool_schema', 'meta'),
  handler('session_search', 'sessions'),
  handler('process_spawn', 'process'),
  // v4.1.4-media: media-control bundle lives in toolset 'system'.
  // Without the media plannerGuard rule "list media sessions"
  // matched only the 'sessions' rule and filtered these out.
  handler('media_sessions', 'system'),
  handler('media_transport', 'system'),
  handler('media_key', 'system'),
  handler('now_playing', 'system'),
]);

class FakeAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(
    private readonly handler: () =>
      | Promise<ProviderCallOutput>
      | ProviderCallOutput,
  ) {}
  async call(): Promise<ProviderCallOutput> {
    return await this.handler();
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('PlannerGuard — off mode', () => {
  it('1. off mode returns all tools as selected, none excluded', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'off');
    const decision = await guard.decide('anything', []);
    // v4.1.4-media: FULL_REGISTRY grew by 4 (media_sessions,
    // media_transport, media_key, now_playing).
    expect(decision.selectedTools).toHaveLength(20);
    expect(decision.excludedTools).toEqual([]);
    expect(decision.reason).toBe('no_filter');
  });
});

describe('PlannerGuard — rule_based', () => {
  it('2. file keywords select files toolset (+ core)', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('please read this file', []);
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('file_write');
    // Core always-on tools present (those that exist):
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.selectedTools).toContain('lookup_tool_schema');
    expect(decision.selectedTools).toContain('session_search');
    expect(decision.selectedTools).not.toContain('browser_click');
    expect(decision.reason).toBe('rule_match');
  });

  it('3. web keywords select web toolset', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search the web for typescript', []);
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.selectedTools).toContain('web_fetch');
    expect(decision.selectedTools).not.toContain('shell_exec');
  });

  it('4. multiple keywords union toolsets', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search the web then save the file', []);
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.selectedTools).toContain('file_write');
  });

  it('5. always includes core tools even on file-only intent', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('write this file', []);
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.selectedTools).toContain('lookup_tool_schema');
    expect(decision.selectedTools).toContain('session_search');
  });

  it('6. no rule match returns full tool inventory (Phase 16g)', async () => {
    // Phase 16g: pre-16g returned only CORE_TOOL_NAMES (3 tools), which
    // broke fuzzy multi-step intents like "play me a song on youtube"
    // — model couldn't see browser/web/shell tools and had no pathway
    // to chain. Now pattern (no per-turn narrowing on
    // fuzzy intents).
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('hi there friend', []);
    // ALL registered tools surfaced.
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.excludedTools).toEqual([]);
    expect(decision.reason).toBe('no_rule_match_open');
  });

  it('7. skill-required toolsets become active after activateToolsets()', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    // Phase 16g: with the open-fallback, "hello" alone returns all
    // tools — activation is hard to distinguish from open-fallback.
    // Use a message that triggers a NON-browser rule (memory) so the
    // narrow path is exercised, then check activation adds browser
    // tools on top.
    guard.activateToolsets(['browser']);
    const decision = await guard.decide('remember this', []);
    // 'remember' triggers the memory rule → narrow path active.
    // Activation adds browser to matchedToolsets, so browser tools
    // are also included alongside the memory tools.
    expect(decision.selectedTools).toContain('browser_click');
    expect(decision.selectedTools).toContain('memory_add');
    expect(decision.reason).toBe('rule_match');
  });

  it('8. empty user message returns full inventory too (Phase 16g)', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('', []);
    // Empty message also has no keyword matches → full inventory.
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('web_search');
    expect(decision.reason).toBe('no_rule_match_open');
  });

  it('8a. explicit keyword intent still narrows correctly (Phase 16g)', async () => {
    // Counter-test: Phase 16g should NOT regress the narrow path. A
    // message that explicitly mentions one domain still gets narrowed.
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search the web for npm news', []);
    expect(decision.selectedTools).toContain('web_search');
    // Browser stays excluded because the user said "search the web",
    // not "open the browser".
    expect(decision.excludedTools).toContain('browser_click');
    expect(decision.reason).toBe('rule_match');
  });

  it('9. multi-tool message: union of all matched toolsets', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide(
      'open browser, run a python script, save to a file, and remember the result',
      [],
    );
    expect(decision.selectedTools).toContain('browser_click');
    expect(decision.selectedTools).toContain('execute_code');
    expect(decision.selectedTools).toContain('file_write');
    expect(decision.selectedTools).toContain('memory_add');
  });

  it('10. decide returns excludedTools alongside selectedTools', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('write this file', []);
    const allNames = FULL_REGISTRY.list();
    const selectedSet = new Set(decision.selectedTools);
    const excludedSet = new Set(decision.excludedTools);
    // Selected ∪ Excluded = full registry; intersection empty.
    for (const n of allNames) {
      expect(selectedSet.has(n) || excludedSet.has(n)).toBe(true);
    }
    for (const n of decision.selectedTools) {
      expect(excludedSet.has(n)).toBe(false);
    }
  });
});

describe('PlannerGuard — llm_classified', () => {
  it('11. parses JSON array response and selects subset', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '["file_read","web_search"]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('something', []);
    expect(decision.reason).toBe('llm_classification');
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('web_search');
    // Core tools always added.
    expect(decision.selectedTools).toContain('skills_list');
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('12. malformed LLM response falls back to rule_based', async () => {
    const adapter = new FakeAdapter(() => ({
      content: 'this is not json at all',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('write this file', []);
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('file_write');
  });

  it('13. timeout falls back to rule_based', async () => {
    // Adapter that never resolves.
    const adapter = new FakeAdapter(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    // Use fake timers to skip the 4s wait.
    vi.useFakeTimers();
    const promise = guard.decide('search the web', []);
    await vi.advanceTimersByTimeAsync(5000);
    const decision = await promise;
    vi.useRealTimers();
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('web_search');
  });

  it('14. setMode mid-session changes behavior', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '["file_read"]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based', adapter);
    let decision = await guard.decide('search web', []);
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('web_search');
    guard.setMode('llm_classified');
    decision = await guard.decide('search web', []);
    expect(decision.reason).toBe('llm_classification');
    expect(decision.selectedTools).toContain('file_read');
  });

  it('15. llm_classified empty array falls back to rule_based', async () => {
    const adapter = new FakeAdapter(() => ({
      content: '[]',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const guard = new PlannerGuard(FULL_REGISTRY, 'llm_classified', adapter);
    const decision = await guard.decide('please save my file', []);
    expect(decision.reason).toBe('fallback');
    expect(decision.selectedTools).toContain('file_write');
  });

  // ── v4.1.4-media — plannerGuard media-control rule ─────────────────
  //
  // Visual-smoke regression: "list media sessions" matched only the
  // existing 'sessions' rule (via the bare word "sessions") which
  // narrowed the surface to toolset 'sessions'. media_sessions lives
  // in toolset 'system' so it got filtered out, and the model
  // honestly reported it as unavailable. These guards make sure the
  // media rule fires on natural media-control language and that
  // UNION semantics keep both surfaces visible on combined phrases.

  it('16. "pause spotify" exposes media_transport (media rule fires)', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('pause spotify', []);
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('media_transport');
    expect(decision.selectedTools).toContain('media_key');
    expect(decision.selectedTools).toContain('media_sessions');
  });

  it('17. "list media sessions" exposes BOTH media_sessions AND session_search (UNION)', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('list media sessions', []);
    expect(decision.reason).toBe('rule_match');
    // Media rule contribution.
    expect(decision.selectedTools).toContain('media_sessions');
    // Sessions rule still fires too — the keyword UNION means the
    // model can see both surfaces and pick the right one.
    expect(decision.selectedTools).toContain('session_search');
  });

  it('18. "play me a song" matches the media rule', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('play me a song', []);
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('media_transport');
  });

  it('19. "skip this track" matches the media rule', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('skip this track', []);
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('media_transport');
  });

  it('20. "search my past sessions" does NOT trigger the media rule alone', async () => {
    const guard = new PlannerGuard(FULL_REGISTRY, 'rule_based');
    const decision = await guard.decide('search my past sessions', []);
    // The sessions rule fires; the media rule should NOT, because no
    // media-vocabulary token is present. media_transport must NOT be
    // in the selection.
    expect(decision.selectedTools).toContain('session_search');
    expect(decision.selectedTools).not.toContain('media_transport');
  });
});

// ── v4.6 Phase 1 — sub-agent toolset rule ──────────────────────────────────

describe('PlannerGuard — subagent rule (v4.6 Phase 1)', () => {
  // Dedicated registry with the two real sub-agent tools so the
  // narrowed-list assertions don't depend on FULL_REGISTRY's count.
  // 'web' toolset added so the "spawn a child to read files" test can
  // verify UNION semantics across rules.
  const SUBAGENT_REGISTRY = new MockRegistry([
    handler('file_read',        'files'),
    handler('file_write',       'files'),
    handler('web_search',       'web'),
    handler('shell_exec',       'terminal'),
    handler('spawn_sub_agent',  'subagent'),
    handler('subagent_fanout',  'subagent'),
    handler('skills_list',      'skills'),
    handler('lookup_tool_schema', 'meta'),
    handler('session_search',   'sessions'),
  ]);

  it('21. "spawn" keyword selects subagent toolset', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const decision = await guard.decide('please spawn a sub-agent', []);
    expect(decision.selectedTools).toContain('spawn_sub_agent');
    expect(decision.selectedTools).toContain('subagent_fanout');
  });

  it('22. "delegate" keyword selects subagent toolset', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const decision = await guard.decide('delegate this task to a worker', []);
    expect(decision.selectedTools).toContain('spawn_sub_agent');
    expect(decision.selectedTools).toContain('subagent_fanout');
  });

  it('23. "subagent" / "sub-agent" keyword variants both match', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const d1 = await guard.decide('use the subagent system', []);
    const d2 = await guard.decide('build a sub-agent for this', []);
    expect(d1.selectedTools).toContain('spawn_sub_agent');
    expect(d2.selectedTools).toContain('spawn_sub_agent');
  });

  it('24. "fanout" / "fan out" keyword variants both match', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const d1 = await guard.decide('fanout this query across providers', []);
    const d2 = await guard.decide('fan out the work', []);
    expect(d1.selectedTools).toContain('subagent_fanout');
    expect(d2.selectedTools).toContain('subagent_fanout');
  });

  it('25. "parallel" keyword triggers subagent toolset', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const decision = await guard.decide('run these in parallel', []);
    expect(decision.selectedTools).toContain('spawn_sub_agent');
  });

  it('26. message with NO subagent keyword does NOT surface subagent tools when another rule fires', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    // Triggers the 'files' rule; nothing in the subagent vocabulary.
    const decision = await guard.decide('read my README.md file', []);
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).not.toContain('spawn_sub_agent');
    expect(decision.selectedTools).not.toContain('subagent_fanout');
  });

  it('27. UNION semantics — "spawn a child to read files" matches BOTH subagent and files', async () => {
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const decision = await guard.decide('spawn a child to read files', []);
    // 'spawn' → subagent rule; 'read' + 'files' → files rule.
    expect(decision.selectedTools).toContain('spawn_sub_agent');
    expect(decision.selectedTools).toContain('subagent_fanout');
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.selectedTools).toContain('file_write');
  });

  it('28. integration — Dispatch 2H bug repro: spawn-intent message reaches model', async () => {
    // Pre-fix: PlannerGuard's narrowed selection excluded spawn_sub_agent
    // because no rule mapped to the 'subagent' toolset. The model could
    // see the schema via lookup_tool_schema but failed to invoke the tool
    // because the provider's tool list (post-narrow) didn't include it.
    //
    // Post-fix: the user's exact message from Dispatch 2H now reaches the
    // model with the spawn tool in the narrowed catalog. Both subagent
    // tools surface together (they share the same toolset) plus the
    // files-rule tools (UNION semantics from the 'file' keyword).
    const guard = new PlannerGuard(SUBAGENT_REGISTRY, 'rule_based');
    const decision = await guard.decide(
      'Use spawn_sub_agent to count the number of TypeScript files in core/',
      [],
    );
    expect(decision.selectedTools).toContain('spawn_sub_agent');
    expect(decision.selectedTools).toContain('subagent_fanout');
    // Files rule also fires (file/files keyword present).
    expect(decision.selectedTools).toContain('file_read');
    expect(decision.reason).toBe('rule_match');
  });

});

describe('PlannerGuard — product authority routing', () => {
  const PRODUCT_REGISTRY = new MockRegistry([
    handler('automation_status', 'automation'),
    handler('automation_manage', 'automation'),
    handler('aiden_status', 'status'),
    handler('memory_add', 'memory'),
    handler('skill_view', 'skills'),
    handler('skills_list', 'skills'),
    handler('lookup_tool_schema', 'meta'),
    handler('session_search', 'sessions'),
  ]);

  it('routes ordinary scheduling to Reliable Automations', async () => {
    const decision = await new PlannerGuard(PRODUCT_REGISTRY, 'rule_based')
      .decide('Remind me every weekday at 9 AM to review support tickets');
    expect(decision.selectedTools).toContain('automation_status');
    expect(decision.selectedTools).toContain('automation_manage');
  });

  it('keeps explicit Windows Task Scheduler requests on the skill path', async () => {
    const decision = await new PlannerGuard(PRODUCT_REGISTRY, 'rule_based')
      .decide('Use Windows Task Scheduler to create a scheduled task');
    expect(decision.selectedTools).toContain('skill_view');
  });

  it('routes remembered-preference questions to canonical Learning status', async () => {
    const decision = await new PlannerGuard(PRODUCT_REGISTRY, 'rule_based')
      .decide('What preferences do you remember about me?');
    expect(decision.selectedTools).toContain('aiden_status');
    expect(decision.selectedTools).toContain('memory_add');
  });

  it('routes natural-language prefer questions to canonical Learning status', async () => {
    const decision = await new PlannerGuard(PRODUCT_REGISTRY, 'rule_based')
      .decide('What package manager do I prefer for this workspace?');
    expect(decision.reason).toBe('rule_match');
    expect(decision.selectedTools).toContain('aiden_status');
    expect(decision.excludedTools).not.toContain('aiden_status');
  });

  it('routes managed Skill Intelligence questions to canonical status', async () => {
    const decision = await new PlannerGuard(PRODUCT_REGISTRY, 'rule_based')
      .decide('Which skill candidates need attention?');
    expect(decision.selectedTools).toContain('aiden_status');
    expect(decision.selectedTools).toContain('skill_view');
  });
});
