/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.11 Slice 1 — clarify tool (mechanism) tests.
 *
 * Covers: answer round-trip, options passthrough (≤4 cap), headless
 * degrade (no callback → "unavailable, proceed", never hangs), cancel
 * (callback returns null → "cancelled, proceed"), REPL-only contexts
 * (excluded from the daemon catalog), and the subagent blocklist match.
 */
import { describe, it, expect, vi } from 'vitest';

import { makeClarifyTool } from '../../../tools/v4/clarify/clarifyTool';
import { ToolRegistry, type ToolContext } from '../../../core/v4/toolRegistry';
import { SUBAGENT_BLOCKED_TOOL_NAMES } from '../../../core/v4/subagent/childBuilder';

const tool = makeClarifyTool();

/** Minimal ToolContext — only `clarify` matters to this tool. */
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: '/tmp', paths: {} as any, ...over };
}

describe('clarify tool — answer round-trip', () => {
  it('returns the user answer when the callback resolves', async () => {
    const clarify = vi.fn(async () => 'use the staging bucket');
    const r = await tool.execute({ question: 'Which bucket?' }, ctx({ clarify })) as any;
    expect(clarify).toHaveBeenCalledWith('Which bucket?', undefined);
    expect(r).toEqual({ ok: true, status: 'answered', answer: 'use the staging bucket' });
  });

  it('passes through ≤4 options and drops the rest', async () => {
    const clarify = vi.fn(async () => 'b');
    await tool.execute(
      { question: 'Pick one', options: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ctx({ clarify }),
    );
    expect(clarify).toHaveBeenCalledWith('Pick one', ['a', 'b', 'c', 'd']);
  });

  it('filters non-string / blank options', async () => {
    const clarify = vi.fn(async () => 'x');
    await tool.execute(
      { question: 'Q', options: ['a', '', '  ', 7, null, 'b'] as any },
      ctx({ clarify }),
    );
    expect(clarify).toHaveBeenCalledWith('Q', ['a', 'b']);
  });
});

describe('clarify tool — degrade paths (never hang)', () => {
  it('headless / no callback → unavailable, proceed', async () => {
    const r = await tool.execute({ question: 'Which env?' }, ctx()) as any;
    expect(r.ok).toBe(false);
    expect(r.status).toBe('unavailable');
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/reasonable default/i);
  });

  it('user cancellation forbids inventing the required value', async () => {
    const clarify = vi.fn(async () => null);
    const r = await tool.execute({ question: 'Which env?' }, ctx({ clarify })) as any;
    expect(r.ok).toBe(false);
    expect(r.status).toBe('cancelled');
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/do not invent/i);
    expect(r.note).toMatch(/explicitly authorizes/i);
  });

  it('empty answer is treated as cancelled', async () => {
    const clarify = vi.fn(async () => '   ');
    const r = await tool.execute({ question: 'Q' }, ctx({ clarify })) as any;
    expect(r.status).toBe('cancelled');
  });

  it('missing question → invalid (no callback invoked)', async () => {
    const clarify = vi.fn(async () => 'x');
    const r = await tool.execute({ question: '   ' }, ctx({ clarify })) as any;
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid');
    expect(clarify).not.toHaveBeenCalled();
  });
});

describe('clarify tool — scope guards', () => {
  it('is REPL-only — excluded from the daemon catalog', () => {
    const reg = new ToolRegistry();
    reg.register(tool);
    expect(reg.getSchemas(undefined, 'repl').map((s) => s.name)).toContain('clarify');
    expect(reg.getSchemas(undefined, 'daemon').map((s) => s.name)).not.toContain('clarify');
  });

  it('the registered name is in the subagent blocklist (children cannot ask)', () => {
    expect(tool.schema.name).toBe('clarify');
    expect(SUBAGENT_BLOCKED_TOOL_NAMES.has(tool.schema.name)).toBe(true);
  });
});
