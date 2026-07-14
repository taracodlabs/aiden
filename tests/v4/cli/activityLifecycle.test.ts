import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CliCallbacks, type PromptApi } from '../../../cli/v4/callbacks';
import { Display, type ToolRowHandle } from '../../../cli/v4/display';
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

describe('central CLI activity lifecycle', () => {
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
    const callbacks = new CliCallbacks({ display });

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
    const callbacks = new CliCallbacks({ display, promptModule: prompts });
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
