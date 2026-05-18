/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/core/toolRegistry.contexts.test.ts — v4.6 Phase 1.
 *
 * Guards the `contexts` field on ToolHandler + the optional
 * `context` parameter on `getSchemas`. Q6 enforcement lives here:
 * spawn_sub_agent registers with `contexts: ['repl']` and must be
 * excluded from daemon agents' tool catalogs.
 *
 * Six cases:
 *   1. Tool with no contexts → visible in both REPL + daemon (backward compat)
 *   2. Tool with contexts: ['repl'] → visible in REPL only, NOT daemon
 *   3. Tool with contexts: ['daemon'] → visible in daemon only, NOT REPL
 *   4. Tool with contexts: ['repl', 'daemon'] → visible in both
 *   5. getSchemas with no context arg → all tools (full backward compat)
 *   6. Toolset filter + context filter → AND semantics (both must match)
 *
 * Plus: assert the live `spawn_sub_agent` stub is REPL-only.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolHandler, ExecutionContext } from '../../../core/v4/toolRegistry';
import { makeSpawnSubAgentStub } from '../../../tools/v4/subagent/spawnSubAgentTool';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTool(
  name:     string,
  toolset:  string,
  contexts?: ExecutionContext[],
): ToolHandler {
  return {
    schema: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute:  async () => ({ ok: true }),
    category: 'read',
    mutates:  false,
    toolset,
    ...(contexts ? { contexts } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ToolRegistry context filter (v4.6 Phase 1)', () => {

  // ──────────────────────────────────────────────────────────────────────
  // Case 1 — Tool with no contexts → visible in both REPL + daemon
  // ──────────────────────────────────────────────────────────────────────
  it('1. tool with no contexts field is visible in BOTH repl + daemon (backward compat)', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('legacy_tool', 'web'));  // no contexts field
    const replNames = reg.getSchemas(undefined, 'repl').map((t) => t.name);
    const daemonNames = reg.getSchemas(undefined, 'daemon').map((t) => t.name);
    expect(replNames).toContain('legacy_tool');
    expect(daemonNames).toContain('legacy_tool');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 2 — Tool with contexts: ['repl'] → repl only
  // ──────────────────────────────────────────────────────────────────────
  it('2. tool with contexts: ["repl"] is visible in repl but NOT daemon', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('repl_only', 'subagent', ['repl']));
    const replNames = reg.getSchemas(undefined, 'repl').map((t) => t.name);
    const daemonNames = reg.getSchemas(undefined, 'daemon').map((t) => t.name);
    expect(replNames).toContain('repl_only');
    expect(daemonNames).not.toContain('repl_only');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 3 — Tool with contexts: ['daemon'] → daemon only
  // ──────────────────────────────────────────────────────────────────────
  it('3. tool with contexts: ["daemon"] is visible in daemon but NOT repl', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('daemon_only', 'triggers', ['daemon']));
    const replNames = reg.getSchemas(undefined, 'repl').map((t) => t.name);
    const daemonNames = reg.getSchemas(undefined, 'daemon').map((t) => t.name);
    expect(replNames).not.toContain('daemon_only');
    expect(daemonNames).toContain('daemon_only');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 4 — Tool with both contexts explicitly → both
  // ──────────────────────────────────────────────────────────────────────
  it('4. tool with contexts: ["repl", "daemon"] is visible in both (explicit form)', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('explicit_both', 'web', ['repl', 'daemon']));
    const replNames = reg.getSchemas(undefined, 'repl').map((t) => t.name);
    const daemonNames = reg.getSchemas(undefined, 'daemon').map((t) => t.name);
    expect(replNames).toContain('explicit_both');
    expect(daemonNames).toContain('explicit_both');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 5 — getSchemas with no context arg returns ALL tools
  // ──────────────────────────────────────────────────────────────────────
  it('5. getSchemas() with no context argument returns ALL tools (full backward compat)', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('legacy', 'web'));
    reg.register(makeTool('repl_only', 'subagent', ['repl']));
    reg.register(makeTool('daemon_only', 'triggers', ['daemon']));
    const all = reg.getSchemas().map((t) => t.name);
    expect(all).toContain('legacy');
    expect(all).toContain('repl_only');
    expect(all).toContain('daemon_only');
    // Same when toolset filter is omitted but context is also omitted.
    expect(reg.getSchemas(undefined).map((t) => t.name)).toEqual(all);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 6 — Toolset filter + context filter = AND semantics
  // ──────────────────────────────────────────────────────────────────────
  it('6. toolset filter AND context filter are combined (intersection)', () => {
    const reg = new ToolRegistry();
    // Two web tools: one repl-only, one default (both).
    reg.register(makeTool('web_repl_only',   'web', ['repl']));
    reg.register(makeTool('web_both',        'web'));
    // A subagent tool that's repl-only.
    reg.register(makeTool('subagent_repl',   'subagent', ['repl']));
    // A subagent tool that's daemon-only.
    reg.register(makeTool('subagent_daemon', 'subagent', ['daemon']));

    // toolsets=['web'] + context='repl' → both web tools (both
    // pass the repl filter; the toolset filter is the gate).
    const webRepl = reg.getSchemas(['web'], 'repl').map((t) => t.name);
    expect(webRepl.sort()).toEqual(['web_both', 'web_repl_only']);

    // toolsets=['web'] + context='daemon' → only web_both
    // (web_repl_only is excluded by the daemon filter).
    const webDaemon = reg.getSchemas(['web'], 'daemon').map((t) => t.name);
    expect(webDaemon).toEqual(['web_both']);

    // toolsets=['subagent'] + context='daemon' → only subagent_daemon.
    const subDaemon = reg.getSchemas(['subagent'], 'daemon').map((t) => t.name);
    expect(subDaemon).toEqual(['subagent_daemon']);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Live integration — spawn_sub_agent stub is REPL-only
  // ──────────────────────────────────────────────────────────────────────
  it('7. live spawn_sub_agent stub registers with contexts: ["repl"] and is excluded from daemon', () => {
    const reg = new ToolRegistry();
    reg.register(makeSpawnSubAgentStub());
    // REPL catalog: present.
    const repl = reg.getSchemas(undefined, 'repl').map((t) => t.name);
    expect(repl).toContain('spawn_sub_agent');
    // Daemon catalog: excluded.
    const daemon = reg.getSchemas(undefined, 'daemon').map((t) => t.name);
    expect(daemon).not.toContain('spawn_sub_agent');
    // No context filter: present (so /tools and MCP still surface it).
    const all = reg.getSchemas().map((t) => t.name);
    expect(all).toContain('spawn_sub_agent');
  });
});
