import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CliCallbacks, type PromptApi } from '../../../cli/v4/callbacks';
import { Display, type LiveActivityRowHandle, type ToolRowHandle } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { ToolCallRequest, ToolCallResult } from '../../../providers/v4/types';

function makeDisplay(): Display {
  const out = new Writable({
    write(_chunk, _encoding, done) { done(); },
  }) as unknown as NodeJS.WriteStream;
  return new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out });
}

function makeTtyDisplay(): { display: Display; output: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); },
  }) as unknown as NodeJS.WriteStream;
  Object.defineProperty(out, 'isTTY', { value: true });
  return {
    display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }),
    output: () => chunks.join(''),
  };
}

function makeTtyDisplayWithFrames(): { display: Display; frames: string[] } {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, done) { frames.push(chunk.toString()); done(); },
  }) as unknown as NodeJS.WriteStream;
  Object.defineProperty(out, 'isTTY', { value: true });
  return {
    display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }),
    frames,
  };
}

function makeRow(): ToolRowHandle {
  return {
    ok: vi.fn(), fail: vi.fn(), degraded: vi.fn(), retry: vi.fn(),
    blocked: vi.fn(), emptyRetry: vi.fn(), emptyFail: vi.fn(), cancel: vi.fn(),
    dismiss: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    isActive: vi.fn(() => true),
  };
}

function call(id: string, name: string): ToolCallRequest {
  return { id, name, arguments: {} };
}

function result(id: string, name: string, payload: unknown): ToolCallResult {
  return { id, name, result: payload };
}

function makeTurnRow(): LiveActivityRowHandle {
  return {
    refresh: vi.fn(), setVerb: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    stop: vi.fn(), invalidateLayout: vi.fn(), isActive: vi.fn(() => true),
  };
}

const resolveBuiltInInteraction = (name: string) =>
  name === 'clarify'
    ? { mode: 'exclusive_modal' as const, decision: 'clarification', cancellation: 'cancelled' as const }
    : name === 'plan_approval'
      ? { mode: 'exclusive_modal' as const, decision: 'batch_approval', cancellation: 'cancelled' as const }
      : undefined;

describe('central CLI activity lifecycle', () => {
  it('replaces each timer frame with one atomic terminal write', () => {
    vi.useFakeTimers();
    try {
      const { display, frames } = makeTtyDisplayWithFrames();
      const row = display.toolRow('file_operations', { path: 'report.md' });
      const afterStart = frames.length;
      vi.advanceTimersByTime(1_000);
      expect(frames.length - afterStart).toBe(1);
      expect(frames.at(-1)).toMatch(/^\x1b\[1A\x1b\[2K\r[^\r]*\x1b\[1B\r$/);

      const beforeSettle = frames.length;
      row.ok(1_000);
      expect(frames.length - beforeSettle).toBe(1);
      expect(frames.at(-1)).toMatch(/^\x1b\[1A\x1b\[2K\r[^\r]*\n$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the real row timer while a modal owns the terminal', () => {
    vi.useFakeTimers();
    try {
      const { display, output } = makeTtyDisplay();
      const row = display.toolRow('clarify', { question: 'topic?' });
      row.pause();
      const pausedOutput = output();
      vi.advanceTimersByTime(5_000);
      expect(output()).toBe(pausedOutput);

      row.resume();
      const resumedOutput = output();
      vi.advanceTimersByTime(1_000);
      expect(output().length).toBeGreaterThan(resumedOutput.length);
      row.dismiss();
      const settledOutput = output();
      vi.advanceTimersByTime(5_000);
      expect(output()).toBe(settledOutput);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles completed and cancelled clarification rows by removing them', () => {
    const display = makeDisplay();
    const completed = makeRow();
    const cancelled = makeRow();
    vi.spyOn(display, 'toolRow')
      .mockReturnValueOnce(completed)
      .mockReturnValueOnce(cancelled);
    const callbacks = new CliCallbacks({ display, resolveToolInteraction: resolveBuiltInInteraction });

    callbacks.onToolCall(call('q1', 'clarify'), 'before');
    callbacks.onToolCall(call('q1', 'clarify'), 'after', result('q1', 'clarify', { status: 'answered' }));
    callbacks.onToolCall(call('q2', 'clarify'), 'before');
    callbacks.onToolCall(call('q2', 'clarify'), 'after', result('q2', 'clarify', { status: 'cancelled' }));

    expect(completed.dismiss).toHaveBeenCalledTimes(1);
    expect(cancelled.dismiss).toHaveBeenCalledTimes(1);
    expect(completed.ok).not.toHaveBeenCalled();
    expect(cancelled.cancel).not.toHaveBeenCalled();
    expect(callbacks.activeActivityCount()).toBe(0);
  });

  it('dismisses a plugin-shaped exclusive interaction without a name exception', () => {
    const display = makeDisplay();
    const row = makeRow();
    vi.spyOn(display, 'toolRow').mockReturnValue(row);
    const callbacks = new CliCallbacks({
      display,
      resolveToolInteraction: (name: string) => name === 'plugin_prompt'
        ? { mode: 'exclusive_modal', decision: 'future_plugin_decision', cancellation: 'cancelled' }
        : undefined,
    } as never);

    callbacks.onToolCall(call('plugin-1', 'plugin_prompt'), 'before');
    callbacks.onToolCall(
      call('plugin-1', 'plugin_prompt'),
      'after',
      result('plugin-1', 'plugin_prompt', { status: 'cancelled' }),
    );

    expect(row.dismiss).toHaveBeenCalledTimes(1);
    expect(row.cancel).not.toHaveBeenCalled();
    expect(callbacks.activeActivityCount()).toBe(0);
    expect(callbacks.activityModalPauseDepth()).toBe(0);
  });

  it('runs one approval prompt while its activity row is paused', async () => {
    const display = makeDisplay();
    const row = makeRow();
    vi.spyOn(display, 'toolRow').mockReturnValue(row);
    const select = vi.fn(async () => 'allow');
    const prompts: PromptApi = {
      select,
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => ''),
    };
    const callbacks = new CliCallbacks({
      display,
      promptModule: prompts,
      resolveToolInteraction: resolveBuiltInInteraction,
    });
    callbacks.onToolCall(call('a1', 'plan_approval'), 'before');

    await expect(callbacks.promptApproval({
      toolName: 'file_write', category: 'write', args: { path: 'report.md' },
    })).resolves.toBe('allow');
    callbacks.onToolCall(call('a1', 'plan_approval'), 'after', result('a1', 'plan_approval', { status: 'approved' }));

    expect(select).toHaveBeenCalledTimes(1);
    expect(row.pause).toHaveBeenCalledTimes(1);
    expect(row.resume).toHaveBeenCalledTimes(1);
    expect(row.dismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    { decision: 'deny' as const, resumes: false },
    { decision: 'interrupted' as const, resumes: false },
    { decision: 'allow' as const, resumes: true },
  ])('does not restore an old provider frame after approval result $decision', async ({ decision, resumes }) => {
    const display = makeDisplay();
    const providerRow = makeTurnRow();
    const toolRow = makeRow();
    vi.spyOn(display, 'liveActivityRow').mockReturnValue(providerRow);
    vi.spyOn(display, 'toolRow').mockReturnValue(toolRow);
    const prompts: PromptApi = {
      select: decision === 'interrupted'
        ? vi.fn(async () => { throw new Error('SIGINT'); })
        : vi.fn(async () => decision),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => ''),
    };
    const callbacks = new CliCallbacks({ display, promptModule: prompts });

    callbacks.onProviderRequestStart('provider');
    callbacks.onToolCall(call('approval-shell', 'shell_exec'), 'before');
    await expect(callbacks.promptApproval({
      toolName: 'shell_exec', category: 'execute', args: { command: 'echo guarded' },
    })).resolves.toBe(decision);

    expect(providerRow.stop).toHaveBeenCalledTimes(1);
    expect(providerRow.resume).not.toHaveBeenCalled();
    expect(toolRow.resume).toHaveBeenCalledTimes(resumes ? 1 : 0);
    expect(callbacks.activityTimerCount()).toBe(resumes ? 1 : 0);

    callbacks.onToolCall(call('approval-shell', 'shell_exec'), 'after', {
      id: 'approval-shell', name: 'shell_exec', result: null,
      ...(decision === 'allow' ? {} : { error: decision }),
      activityTiming: {
        dispatchStartedAt: 0, dispatchEndedAt: 1, executionAttempts: [],
        terminalClassification: decision === 'interrupted' ? 'cancelled' : decision === 'deny' ? 'denied' : 'completed',
      },
    });
    expect(callbacks.activityTimerCount()).toBe(0);
  });

  it('settles completed file work and ignores duplicate terminal callbacks', () => {
    const display = makeDisplay();
    const row = makeRow();
    vi.spyOn(display, 'toolRow').mockReturnValue(row);
    const callbacks = new CliCallbacks({ display });
    const fileCall = call('f1', 'file_operations');
    const done = result('f1', 'file_operations', { status: 'ok' });

    callbacks.onToolCall(fileCall, 'before');
    callbacks.onToolCall(fileCall, 'before');
    callbacks.onToolCall(fileCall, 'after', done);
    callbacks.onToolCall(fileCall, 'after', done);

    expect(display.toolRow).toHaveBeenCalledTimes(1);
    expect(row.ok).toHaveBeenCalledTimes(1);
    expect(callbacks.activeActivityCount()).toBe(0);
  });

  it('sweeps orphaned rows at turn completion and stale callbacks cannot revive them', () => {
    const display = makeDisplay();
    const oldRow = makeRow();
    const nextRow = makeRow();
    vi.spyOn(display, 'toolRow')
      .mockReturnValueOnce(oldRow)
      .mockReturnValueOnce(nextRow);
    const callbacks = new CliCallbacks({ display });

    callbacks.onToolCall(call('old', 'file_operations'), 'before');
    callbacks.completeActivityTurn();
    callbacks.onToolCall(call('old', 'file_operations'), 'after', result('old', 'file_operations', {}));
    callbacks.onToolCall(call('next', 'file_operations'), 'before');

    expect(oldRow.dismiss).toHaveBeenCalledTimes(1);
    expect(oldRow.ok).not.toHaveBeenCalled();
    expect(display.toolRow).toHaveBeenCalledTimes(2);
    expect(callbacks.activeActivityCount()).toBe(1);
    callbacks.completeActivityTurn();
    expect(nextRow.dismiss).toHaveBeenCalledTimes(1);
    expect(callbacks.activityTimerCount()).toBe(0);
  });
});
