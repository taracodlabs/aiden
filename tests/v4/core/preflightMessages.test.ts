/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase 5 — unified provider preflight (`preflightMessages`).
 *
 * These are pure-function tests: the return value IS the wire shape that flows
 * into every provider (main, fallback, vision, distiller, merger, sub-agent,
 * compression, auxiliary), because the preflight runs once at the single
 * adapter seam (providers/v4/preflightAdapter.ts).
 *
 * Golden rule under test throughout: repair STRUCTURE, never fabricate a FACT.
 * A missing tool result becomes an honest "result unavailable" stub — NEVER a
 * fake success.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  preflightMessages,
  PreflightRepairError,
  INVALID_TOOL_CALL_NAME,
} from '../../../core/v4/toolCallInvariant';
import type { Message, ToolCallRequest } from '../../../providers/v4/types';

// ── builders ────────────────────────────────────────────────────────────────
function asst(calls: Array<Partial<ToolCallRequest>> = [], content = ''): Message {
  return {
    role:      'assistant',
    content,
    toolCalls: calls.length === 0 ? undefined : (calls as ToolCallRequest[]),
  };
}
function toolResult(toolCallId: string, content = 'ok'): Message {
  return { role: 'tool', toolCallId, content };
}
const SYSTEM: Message = { role: 'system', content: 'you are aiden' };
const USER:   Message = { role: 'user',   content: 'do a thing' };

/** Parse a tool message's JSON content (the stub shape). */
function body(m: Message): Record<string, unknown> {
  return JSON.parse((m as { content: string }).content);
}

// ═══════════════════════════════════════════════════════════════════════════

describe('preflightMessages — the golden rule (honest stub, never a fake success)', () => {
  it('missing tool result mid-history → injects an HONEST unavailable stub', () => {
    const msgs = [
      SYSTEM,
      USER,
      asst([{ id: 'call_1', name: 'read_file', arguments: {} }]),
      // no tool result for call_1
      { role: 'user', content: 'and again' } as Message,
    ];
    const out = preflightMessages(msgs);
    const stub = out.find((m) => m.role === 'tool' && (m as { toolCallId: string }).toolCallId === 'call_1');
    expect(stub).toBeDefined();
    const parsed = body(stub!);
    expect(parsed.ok).toBe(false);          // NOT a success
    expect(parsed.blocked).toBe(false);
    expect(parsed.reason).toBe('result_unavailable');
    // never claims the tool ran successfully
    expect(parsed.ok).not.toBe(true);
  });
});

describe('preflightMessages — structural repairs', () => {
  it('duplicate tool_call_id → dedupe (keep first)', () => {
    const msgs = [
      SYSTEM, USER,
      asst([
        { id: 'dup', name: 'a', arguments: {} },
        { id: 'dup', name: 'b', arguments: {} },
      ]),
      toolResult('dup'),
    ];
    const out = preflightMessages(msgs);
    const a = out.find((m) => m.role === 'assistant')!;
    expect((a.toolCalls ?? []).map((c) => c.id)).toEqual(['dup']);
    expect((a.toolCalls ?? [])[0].name).toBe('a');   // first kept
  });

  it('orphan tool result (no matching call) → drop', () => {
    const msgs = [SYSTEM, USER, toolResult('ghost'), { role: 'assistant', content: 'hi' } as Message];
    const out = preflightMessages(msgs);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('empty toolCalls: [] → drop the key', () => {
    const msgs = [SYSTEM, USER, { role: 'assistant', content: 'done', toolCalls: [] } as unknown as Message];
    const out = preflightMessages(msgs);
    const a = out.find((m) => m.role === 'assistant')!;
    expect('toolCalls' in a).toBe(false);
  });

  it('empty tool name → invalid_tool_call sentinel (kept, not dropped)', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: '', arguments: {} }]),
      toolResult('c1'),
    ];
    const out = preflightMessages(msgs);
    const a = out.find((m) => m.role === 'assistant')!;
    expect((a.toolCalls ?? [])[0].name).toBe(INVALID_TOOL_CALL_NAME);
    // its result must NOT be orphaned by the rename
    expect(out.some((m) => m.role === 'tool' && (m as { toolCallId: string }).toolCallId === 'c1')).toBe(true);
  });

  it('malformed JSON-string args → repaired to {}', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'f', arguments: 'not json' as unknown as Record<string, unknown> }]),
      toolResult('c1'),
    ];
    const out = preflightMessages(msgs);
    expect((out.find((m) => m.role === 'assistant')!.toolCalls ?? [])[0].arguments).toEqual({});
  });

  it('valid JSON-string args → parsed into an object', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'f', arguments: '{"path":"x"}' as unknown as Record<string, unknown> }]),
      toolResult('c1'),
    ];
    const out = preflightMessages(msgs);
    expect((out.find((m) => m.role === 'assistant')!.toolCalls ?? [])[0].arguments).toEqual({ path: 'x' });
  });

  it('invalid role → dropped', () => {
    const msgs = [SYSTEM, { role: 'function', content: 'junk' } as unknown as Message, USER];
    const out = preflightMessages(msgs);
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('tool→user transition → insert an empty assistant placeholder', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'f', arguments: {} }]),
      toolResult('c1'),
      { role: 'user', content: 'next' } as Message,
    ];
    const out = preflightMessages(msgs);
    const toolIdx = out.findIndex((m) => m.role === 'tool');
    expect(out[toolIdx + 1].role).toBe('assistant');
    expect((out[toolIdx + 1] as { content: string }).content).toBe('');
  });
});

describe('preflightMessages — interrupt / suicide-loop', () => {
  it('interrupted-but-answered tail (tool result present) passes through unchanged', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'f', arguments: {} }]),
      toolResult('c1', 'interrupted'),
    ];
    const out = preflightMessages(msgs);
    expect(out).toEqual(msgs);          // no repair — already valid
  });

  it('process killed after assistant tool_call, before result → strip the dangling tail (no reissue loop)', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'danger', name: 'rm_rf', arguments: { path: '/' } }]),   // no result — killed mid-tool
    ];
    const out = preflightMessages(msgs);
    // the dangling call is stripped, NOT answered with a stub (which would keep
    // inviting a reissue). The empty assistant message is dropped entirely.
    expect(out.some((m) => m.role === 'assistant' && (m.toolCalls ?? []).length > 0)).toBe(false);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('tail assistant with text + one dangling call → keep the text, strip only the call', () => {
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'danger', name: 'rm_rf', arguments: {} }], 'let me clean up'),
    ];
    const out = preflightMessages(msgs);
    const last = out[out.length - 1];
    expect(last.role).toBe('assistant');
    expect((last as { content: string }).content).toBe('let me clean up');
    expect('toolCalls' in last).toBe(false);
  });
});

describe('preflightMessages — blocked tool still gets a result', () => {
  it('an appended "blocked" result satisfies the call → no unavailable stub injected', () => {
    const blocked: Message = {
      role: 'tool',
      toolCallId: 'c1',
      content: JSON.stringify({ ok: false, blocked: true, reason: 'user_denied' }),
    };
    const msgs = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'shell', arguments: {} }]),
      blocked,
      { role: 'user', content: 'ok' } as Message,
    ];
    const out = preflightMessages(msgs);
    const results = out.filter((m) => m.role === 'tool' && (m as { toolCallId: string }).toolCallId === 'c1');
    expect(results.length).toBe(1);                 // the blocked result, not doubled with a stub
    expect(body(results[0]).blocked).toBe(true);    // preserved, not overwritten
  });
});

describe('preflightMessages — strict mode + idempotency', () => {
  it('strict mode throws PreflightRepairError listing the repairs', () => {
    const msgs = [SYSTEM, USER, asst([{ id: 'c1', name: 'f', arguments: {} }])];  // dangling tail
    expect(() => preflightMessages(msgs, { strict: true })).toThrow(PreflightRepairError);
  });

  it('a warn sink receives one message per repair (production path does not throw)', () => {
    const warnings: string[] = [];
    const msgs = [SYSTEM, USER, toolResult('ghost')];   // orphan
    const out = preflightMessages(msgs, { onWarn: (m) => warnings.push(m) });
    expect(warnings.length).toBeGreaterThan(0);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('routes repair warnings to the supplied sink without touching console.warn', () => {
    const warnings: string[] = [];
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dirty = [
      asst([{ id: 'call-1', name: 'read_file', arguments: {} }]),
      toolResult('call-1'),
      { role: 'user', content: 'continue' } as Message,
    ];
    const out = preflightMessages(dirty, { onWarn: (message) => warnings.push(message) });
    expect(warnings).toEqual([
      'inserted an assistant placeholder between a tool result and a user message',
    ]);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(out.at(-1)?.role).toBe('user');
    consoleWarn.mockRestore();
  });

  it('idempotent — a second pass over clean output is a no-op (no repairs, equal shape)', () => {
    const dirty = [
      SYSTEM, USER,
      asst([
        { id: 'dup', name: '', arguments: 'bad' as unknown as Record<string, unknown> },
        { id: 'dup', name: 'b', arguments: {} },
        { id: 'x', name: 'y', arguments: {} },
      ]),
      toolResult('dup'),
      toolResult('ghost'),
      { role: 'user', content: 'again' } as Message,
    ];
    const once  = preflightMessages(dirty);
    const twice = preflightMessages(once, { strict: true });   // strict: throws if ANY repair needed
    expect(twice).toEqual(once);
  });

  it('a clean transcript is returned unchanged', () => {
    const clean = [
      SYSTEM, USER,
      asst([{ id: 'c1', name: 'f', arguments: { a: 1 } }]),
      toolResult('c1'),
      { role: 'assistant', content: 'done' } as Message,
    ];
    expect(preflightMessages(clean, { strict: true })).toEqual(clean);
  });
});
