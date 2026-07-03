/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.4 SLICE 1 — toolCallInvariant pure-function tests.
 *
 * No mocks. Asserts on the actual error / message shapes the dispatch
 * boundary and providers see. Discipline anchor: snapshot of the
 * return value IS the wire shape that flows into the provider (per
 * Phase B Q1 contract — the function is pure and provider-agnostic).
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoUnansweredToolCalls,
  synthesizeBlockedToolResult,
  fillRemainingAsBlocked,
  OrphanToolCallError,
} from '../../../core/v4/toolCallInvariant';
import type { Message, ToolCallRequest } from '../../../providers/v4/types';

function asst(id: string, calls: Array<{ id: string; name: string }> = []): Message {
  return {
    role:      'assistant',
    content:   '',
    toolCalls: calls.length === 0 ? undefined : calls.map((c) => ({ ...c, arguments: {} })),
  };
}
function toolResult(toolCallId: string, content = 'ok'): Message {
  return { role: 'tool', toolCallId, content };
}
const SYSTEM: Message = { role: 'system', content: 'you are aiden' };
const USER:   Message = { role: 'user',   content: 'do a thing' };

// ── v4.12.1 Pillar 4 Slice 1 — interrupt leaves a VALID transcript ──────
//
// Mirrors the aidenAgent abort path: on a mid-batch cancel, the call being
// dispatched gets an 'interrupted' result and every remaining call gets a
// 'skipped' result — so an interrupted turn never leaves a tool_call without
// a matching tool_result (which would provider-error the NEXT turn).
describe('interrupt mid-batch → every tool_call still gets a result', () => {
  it('a 3-call batch cancelled at index 1 leaves zero orphans', () => {
    const calls: ToolCallRequest[] = [
      { id: 'c0', name: 'file_read',  arguments: {} },
      { id: 'c1', name: 'file_write', arguments: {} },
      { id: 'c2', name: 'shell_exec', arguments: {} },
    ];
    // c0 already ran; the user aborts as c1 is about to dispatch.
    const buf: Message[] = [toolResult('c0')];
    buf.push(synthesizeBlockedToolResult(calls[1], 'cancelled', { variant: 'interrupted' }));
    fillRemainingAsBlocked(buf, calls, 2, 'cancelled', 'skipped');

    const history: Message[] = [
      USER,
      asst('a', calls.map((c) => ({ id: c.id, name: c.name }))),
      ...buf,
    ];
    // Every tool_call id has a matching tool_result → no OrphanToolCallError.
    expect(() => assertNoUnansweredToolCalls(history)).not.toThrow();
    expect(buf.map((m) => m.toolCallId).sort()).toEqual(['c0', 'c1', 'c2']);
  });
});

// ── assertNoUnansweredToolCalls ───────────────────────────────────────

describe('assertNoUnansweredToolCalls — clean cases (no throw)', () => {
  it('accepts an empty message list', () => {
    expect(() => assertNoUnansweredToolCalls([])).not.toThrow();
  });

  it('accepts a history with no assistant tool calls', () => {
    expect(() => assertNoUnansweredToolCalls([SYSTEM, USER])).not.toThrow();
  });

  it('accepts an assistant with empty/undefined toolCalls field', () => {
    expect(() => assertNoUnansweredToolCalls([SYSTEM, USER, asst('a', [])])).not.toThrow();
  });

  it('accepts a single assistant tool_call with matching tool result', () => {
    expect(() => assertNoUnansweredToolCalls([
      USER,
      asst('a', [{ id: 'call-1', name: 'file_write' }]),
      toolResult('call-1'),
    ])).not.toThrow();
  });

  it('accepts N assistant tool_calls each with a matching tool result in any order', () => {
    expect(() => assertNoUnansweredToolCalls([
      USER,
      asst('a', [
        { id: 'call-1', name: 'file_write' },
        { id: 'call-2', name: 'shell_exec' },
        { id: 'call-3', name: 'file_read' },
      ]),
      // Order intentionally not 1,2,3 to prove order-independence.
      toolResult('call-3'),
      toolResult('call-1'),
      toolResult('call-2'),
    ])).not.toThrow();
  });

  it('accepts multiple assistant turns each with their own balanced tool_calls', () => {
    expect(() => assertNoUnansweredToolCalls([
      USER,
      asst('a1', [{ id: 'turn1-call', name: 'file_write' }]),
      toolResult('turn1-call'),
      asst('a2', [{ id: 'turn2-call', name: 'shell_exec' }]),
      toolResult('turn2-call'),
    ])).not.toThrow();
  });
});

describe('assertNoUnansweredToolCalls — orphan cases (throws OrphanToolCallError)', () => {
  it('throws when a single tool_call has no matching tool result', () => {
    expect(() => assertNoUnansweredToolCalls([
      USER,
      asst('a', [{ id: 'orphan-id', name: 'file_write' }]),
    ])).toThrow(OrphanToolCallError);
  });

  it('throws listing the orphan id + tool name in the error message (load-bearing for debugging)', () => {
    let caught: OrphanToolCallError | null = null;
    try {
      assertNoUnansweredToolCalls([
        USER,
        asst('a', [{ id: 'call_LEAKED', name: 'file_write' }]),
      ]);
    } catch (e) {
      caught = e as OrphanToolCallError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.name).toBe('OrphanToolCallError');
    expect(caught!.orphans).toHaveLength(1);
    expect(caught!.orphans[0].toolCallId).toBe('call_LEAKED');
    expect(caught!.orphans[0].toolName).toBe('file_write');
    expect(caught!.message).toContain('file_write#call_LEAKED');
    // The hint pointing at the bug class must be in the message —
    // future debuggers shouldn't have to guess what kind of bug this is.
    expect(caught!.message).toContain('synthesizeBlockedToolResult');
  });

  it('collects ALL orphans in a single throw (not throw-on-first)', () => {
    let caught: OrphanToolCallError | null = null;
    try {
      assertNoUnansweredToolCalls([
        USER,
        asst('a', [
          { id: 'orphan-1', name: 'file_write' },
          { id: 'ok-1',     name: 'shell_exec' },
          { id: 'orphan-2', name: 'file_read' },
        ]),
        toolResult('ok-1'),
      ]);
    } catch (e) {
      caught = e as OrphanToolCallError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.orphans).toHaveLength(2);
    expect(caught!.orphans.map((o) => o.toolCallId).sort()).toEqual(['orphan-1', 'orphan-2']);
  });

  it('throws on partial-batch orphan (the exact v4.9.4 bug shape — surface decision after call 2 of 3)', () => {
    // This is the historical wire-shape failure: assistant emits 3
    // tool_calls, dispatch fills results for 1 and 2, surface fires,
    // call 3 never gets a tool result, persisted history carries the
    // orphan, next provider call → 400.
    let caught: OrphanToolCallError | null = null;
    try {
      assertNoUnansweredToolCalls([
        USER,
        asst('a', [
          { id: 'call-1', name: 'file_write' },
          { id: 'call-2', name: 'file_write' },
          { id: 'call-3', name: 'file_write' },
        ]),
        toolResult('call-1'),
        toolResult('call-2'),
      ]);
    } catch (e) {
      caught = e as OrphanToolCallError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.orphans).toEqual([{ toolCallId: 'call-3', toolName: 'file_write' }]);
  });
});

// ── synthesizeBlockedToolResult ──────────────────────────────────────

describe('synthesizeBlockedToolResult — shape contract', () => {
  function call(id: string, name = 'file_write'): ToolCallRequest {
    return { id, name, arguments: {} };
  }

  it('produces a {role:"tool"} Message carrying the call id', () => {
    const m = synthesizeBlockedToolResult(call('call-x'), 'tool_loop_surface');
    expect(m.role).toBe('tool');
    if (m.role === 'tool') {
      expect(m.toolCallId).toBe('call-x');
    }
  });

  it('content is JSON-parseable with the documented blocked-shape', () => {
    const m = synthesizeBlockedToolResult(call('call-y'), 'cancelled');
    expect(m.role).toBe('tool');
    if (m.role === 'tool') {
      const parsed = JSON.parse(m.content);
      expect(parsed.ok).toBe(false);
      expect(parsed.blocked).toBe(true);
      expect(parsed.reason).toBe('cancelled');
      expect(typeof parsed.message).toBe('string');
    }
  });

  it('variant "interrupted" emits the "interrupted before execution" wording', () => {
    const m = synthesizeBlockedToolResult(call('c'), 'cancelled', { variant: 'interrupted' });
    if (m.role === 'tool') {
      const parsed = JSON.parse(m.content);
      expect(parsed.message).toContain('interrupted before execution');
    }
  });

  it('variant "skipped" (default) emits the "skipped because the turn was cancelled" wording', () => {
    const m = synthesizeBlockedToolResult(call('c'), 'cancelled');  // default
    if (m.role === 'tool') {
      const parsed = JSON.parse(m.content);
      expect(parsed.message).toContain('skipped because the turn was cancelled');
    }
  });

  it('reason "tool_loop_surface" produces the expected reason field', () => {
    const m = synthesizeBlockedToolResult(call('c'), 'tool_loop_surface');
    if (m.role === 'tool') {
      const parsed = JSON.parse(m.content);
      expect(parsed.reason).toBe('tool_loop_surface');
    }
  });

  it('two synthetic results with identical inputs are byte-identical (purity)', () => {
    const m1 = synthesizeBlockedToolResult(call('c'), 'cancelled', { variant: 'interrupted' });
    const m2 = synthesizeBlockedToolResult(call('c'), 'cancelled', { variant: 'interrupted' });
    expect(m1).toEqual(m2);
  });
});

// ── fillRemainingAsBlocked ───────────────────────────────────────────

describe('fillRemainingAsBlocked', () => {
  const calls: ToolCallRequest[] = [
    { id: 'call-1', name: 'file_write', arguments: {} },
    { id: 'call-2', name: 'file_write', arguments: {} },
    { id: 'call-3', name: 'file_write', arguments: {} },
  ];

  it('pushes synthetic results from startIdx onward (mutates buf in place)', () => {
    const buf: Message[] = [];
    fillRemainingAsBlocked(buf, calls, 1, 'tool_loop_surface');
    expect(buf).toHaveLength(2);
    expect(buf[0].role).toBe('tool');
    if (buf[0].role === 'tool') expect(buf[0].toolCallId).toBe('call-2');
    if (buf[1].role === 'tool') expect(buf[1].toolCallId).toBe('call-3');
  });

  it('appends to an existing buf (does not replace)', () => {
    const buf: Message[] = [{ role: 'tool', toolCallId: 'pre-existing', content: 'ok' }];
    fillRemainingAsBlocked(buf, calls, 2, 'cancelled');
    expect(buf).toHaveLength(2);
    if (buf[0].role === 'tool') expect(buf[0].toolCallId).toBe('pre-existing');
    if (buf[1].role === 'tool') expect(buf[1].toolCallId).toBe('call-3');
  });

  it('startIdx === calls.length is a no-op (last call already dispatched)', () => {
    const buf: Message[] = [];
    fillRemainingAsBlocked(buf, calls, calls.length, 'tool_loop_surface');
    expect(buf).toEqual([]);
  });

  it('honors the variant parameter for every filled entry', () => {
    const buf: Message[] = [];
    fillRemainingAsBlocked(buf, calls, 0, 'cancelled', 'skipped');
    for (const m of buf) {
      if (m.role === 'tool') {
        const parsed = JSON.parse(m.content);
        expect(parsed.message).toContain('skipped because the turn was cancelled');
      }
    }
  });
});

// ── Integration of all three: simulate the actual bug shape ──────────

describe('toolCallInvariant — end-to-end simulation of the v4.9.4 bug fix', () => {
  it('PRE-FIX shape throws; POST-FIX shape (filled) passes', () => {
    // The assistant emits 3 tool calls; dispatch ran 1 and 2; surface
    // fired before call 3 dispatched.
    const calls: ToolCallRequest[] = [
      { id: 'call-1', name: 'file_write', arguments: {} },
      { id: 'call-2', name: 'file_write', arguments: {} },
      { id: 'call-3', name: 'file_write', arguments: {} },
    ];
    const preFix: Message[] = [
      USER,
      asst('a', calls),
      toolResult('call-1'),
      toolResult('call-2'),
      // (call-3 result missing — THE BUG)
    ];
    expect(() => assertNoUnansweredToolCalls(preFix)).toThrow(OrphanToolCallError);

    // POST-FIX: aidenAgent runs fillRemainingAsBlocked(buf, calls, 2, 'tool_loop_surface')
    // before the break. Reconstructing the post-fix history:
    const postFix: Message[] = [...preFix];
    const tail: Message[] = [];
    fillRemainingAsBlocked(tail, calls, 2, 'tool_loop_surface');
    postFix.push(...tail);
    expect(() => assertNoUnansweredToolCalls(postFix)).not.toThrow();
  });
});
