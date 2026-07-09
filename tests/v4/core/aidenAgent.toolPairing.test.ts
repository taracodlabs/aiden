/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * fix/stuck-tool-row — onToolCall('before')/('after') pairing invariant.
 *
 * The trail's live "running Ns…" row is started on 'before' and only cleared
 * when the matching 'after' fires (it stops the tick + settles the row). If a
 * tool's dispatch throws in post-execute processing — or exits by any other
 * route — before emitting 'after', the row ticks forever.
 *
 * The dispatch (retry loop → 'after' emit) is now wrapped in try/finally that
 * guarantees 'after' fires EXACTLY ONCE on every exit route. When the tool ended
 * before a clean 'after', the finally synthesizes an HONEST terminal result
 * (interrupted / error) — never success.
 *
 * These tests assert, via a captured onToolCall log, that #after === #before on
 * every path (normal, throw-in-post-execute, abort, surfaceDecision break,
 * rollback break), that the happy path emits exactly one 'after' (no double from
 * the finally), and that a synthesized result carries an honest error, never
 * success.
 */
import { describe, it, expect } from 'vitest';
import {
  AidenAgent,
  type ToolExecutor,
} from '../../../core/v4/aidenAgent';
import { TurnState, type RecoveryDecision } from '../../../core/v4/turnState';
import {
  type Message,
  type ProviderAdapter,
  type ProviderCallInput,
  type ProviderCallOutput,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolSchema,
} from '../../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const USAGE = { inputTokens: 1, outputTokens: 1 };
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string): ToolCallRequest => ({ id, name, arguments: { path: `/tmp/${id}` } });
const okExecutor: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: { ok: true } });

/** A scripted provider: shift a response per .call(); when empty, stop. */
class ScriptedAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(private scripted: ProviderCallOutput[]) {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    if (this.scripted.length === 0) return { content: 'done', toolCalls: [], usage: USAGE, finishReason: 'stop' };
    return this.scripted.shift()!;
  }
}
const toolTurn = (...calls: ToolCallRequest[]): ProviderCallOutput => ({
  content: '', toolCalls: calls, usage: USAGE, finishReason: 'tool_calls',
});

/** TurnState that returns `surface` on the Nth recordToolCall (outer-loop break). */
class StubSurfacesAt extends TurnState {
  private n = 0;
  constructor(private at: number) { super(); }
  recordToolCall(): RecoveryDecision {
    if (++this.n === this.at) {
      return { kind: 'surface', surfaceCard: { title: 't', canStill: [], cannotReliably: [], fix: '' } } as unknown as RecoveryDecision;
    }
    return { kind: 'allow' } as unknown as RecoveryDecision;
  }
}

/** TurnState that returns `cooldown_with_rollback` on the Nth call (rollback break). */
class StubRollsBackAt extends TurnState {
  private n = 0;
  constructor(private at: number) { super(); }
  recordToolCall(): RecoveryDecision {
    if (++this.n === this.at) {
      return {
        kind: 'cooldown_with_rollback', toolName: 'file_write',
        rollback: { checkpoint: {} as never, blockedBy: [] },
      } as unknown as RecoveryDecision;
    }
    return { kind: 'allow' } as unknown as RecoveryDecision;
  }
  restoreInternalsFrom(): void { /* stub no-op */ }
  reapplyCooldown(): void { /* stub no-op */ }
}

interface Ev { id: string; phase: 'before' | 'after'; result?: ToolCallResult }
function makeCapture(): { events: Ev[]; onToolCall: (c: ToolCallRequest, p: 'before' | 'after', r?: ToolCallResult) => void } {
  const events: Ev[] = [];
  return { events, onToolCall: (c, p, r) => events.push({ id: c.id, phase: p, result: r }) };
}
const ids = (events: Ev[], phase: 'before' | 'after'): string[] => events.filter((e) => e.phase === phase).map((e) => e.id);

describe('AidenAgent — onToolCall before/after pairing (fix/stuck-tool-row)', () => {
  it('normal completion: exactly one after per before, carrying the real result', async () => {
    const cap = makeCapture();
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([toolTurn(tc('c1', 'file_read'))]),
      toolExecutor: okExecutor, tools: NO_TOOLS, onToolCall: cap.onToolCall,
    });
    await agent.runConversation([userMsg('read a file')]);
    expect(ids(cap.events, 'before')).toEqual(['c1']);
    expect(ids(cap.events, 'after')).toEqual(['c1']);          // exactly one — no double from the finally
    const after = cap.events.find((e) => e.phase === 'after')!;
    expect(after.result?.error).toBeUndefined();               // real success result, not synthesized
    expect((after.result as { success?: unknown })?.success).toBeUndefined();
  });

  it('★ THROW in post-execute: after still fires (once) with an HONEST error result — never success', async () => {
    const cap = makeCapture();
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([toolTurn(tc('c1', 'file_read'))]),
      toolExecutor: okExecutor, tools: NO_TOOLS, resolveMutates: () => true, onToolCall: cap.onToolCall,
      // Throws inside toolCallTrace.push (post-execute) — between the retry loop
      // and the real 'after' emit. Pre-fix this orphaned the row forever.
      resolveVerifiedFlag: () => { throw new Error('boom in post-execute'); },
    });
    await agent.runConversation([userMsg('read a file')]).catch(() => { /* the throw may surface here */ });
    expect(ids(cap.events, 'before')).toEqual(['c1']);
    expect(ids(cap.events, 'after')).toEqual(['c1']);          // paired — the finally fired it exactly once
    const after = cap.events.find((e) => e.phase === 'after')!;
    expect(after.result?.error).toBeTruthy();                  // honest terminal…
    expect((after.result as { success?: unknown })?.success).toBeUndefined();  // …never success
    expect(after.result?.result).toBeNull();
  });

  it('exactly-once: the finally never double-emits after a clean run (two tools)', async () => {
    const cap = makeCapture();
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([toolTurn(tc('c1', 'file_write'), tc('c2', 'file_write'))]),
      toolExecutor: okExecutor, tools: NO_TOOLS, resolveMutates: () => true, onToolCall: cap.onToolCall,
    });
    await agent.runConversation([userMsg('write two files')]);
    expect(ids(cap.events, 'before')).toEqual(['c1', 'c2']);
    expect(ids(cap.events, 'after')).toEqual(['c1', 'c2']);    // exactly one after each — no extra from the finally
  });

  it('abort mid-turn: every before is paired with an after', async () => {
    const cap = makeCapture();
    const ctrl = new AbortController();
    const abortingExecutor: ToolExecutor = async (call) => {
      if (call.id === 'c1') ctrl.abort();
      return { id: call.id, name: call.name, result: { ok: true } };
    };
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([toolTurn(tc('c1', 'file_write'), tc('c2', 'file_write'))]),
      toolExecutor: abortingExecutor, tools: NO_TOOLS, resolveMutates: () => true, onToolCall: cap.onToolCall,
    });
    await agent.runConversation([userMsg('do two things')], { signal: ctrl.signal }).catch(() => { /* interrupted */ });
    expect(ids(cap.events, 'after').sort()).toEqual(ids(cap.events, 'before').sort());
    expect(ids(cap.events, 'before').length).toBeGreaterThan(0);
  });

  it('surfaceDecision outer-loop break: every before is paired with an after', async () => {
    const cap = makeCapture();
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([toolTurn(tc('c1', 'file_write'), tc('c2', 'file_write'), tc('c3', 'file_write'))]),
      toolExecutor: okExecutor, tools: NO_TOOLS, resolveMutates: () => true, onToolCall: cap.onToolCall,
      turnStateFactory: () => new StubSurfacesAt(2),
    });
    await agent.runConversation([userMsg('do three things')]).catch(() => { /* surfaced */ });
    expect(ids(cap.events, 'after').sort()).toEqual(ids(cap.events, 'before').sort());
    expect(ids(cap.events, 'before').length).toBeGreaterThan(0);
  });

  it('rollback (cooldown_with_rollback) break: every before is paired with an after', async () => {
    const cap = makeCapture();
    const agent = new AidenAgent({
      provider: new ScriptedAdapter([
        toolTurn(tc('c1', 'file_write'), tc('c2', 'file_write')),
        { content: 'done', toolCalls: [], usage: USAGE, finishReason: 'stop' },
      ]),
      toolExecutor: okExecutor, tools: NO_TOOLS, resolveMutates: () => true, onToolCall: cap.onToolCall,
      turnStateFactory: () => new StubRollsBackAt(1),
    });
    await agent.runConversation([userMsg('do things')]).catch(() => { /* rolled back */ });
    expect(ids(cap.events, 'after').sort()).toEqual(ids(cap.events, 'before').sort());
    expect(ids(cap.events, 'before').length).toBeGreaterThan(0);
  });
});
