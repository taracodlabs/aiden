import { describe, expect, it, vi } from 'vitest';
import { ActivityRegistry } from '../../../cli/v4/activityRegistry';
import type { ToolRowHandle } from '../../../cli/v4/display';

function handle(): ToolRowHandle {
  return {
    ok: vi.fn(), fail: vi.fn(), degraded: vi.fn(), retry: vi.fn(), blocked: vi.fn(),
    emptyRetry: vi.fn(), emptyFail: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), isActive: vi.fn(() => true),
  };
}

describe('ActivityRegistry', () => {
  it('settles duplicate before/after callbacks idempotently', () => {
    const row = handle();
    const create = vi.fn(() => row);
    const registry = new ActivityRegistry(create, () => 50);
    expect(registry.start('c1', 'file_operations', {})).toBe(true);
    expect(registry.start('c1', 'file_operations', {})).toBe(false);
    expect(registry.settle('c1', { state: 'completed' })).toBe(true);
    expect(registry.settle('c1', { state: 'failed' })).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(row.ok).toHaveBeenCalledTimes(1);
    expect(row.fail).not.toHaveBeenCalled();
    expect(registry.timerCount()).toBe(0);
  });

  it('pauses repainting for a modal and redraws once afterward', async () => {
    const row = handle();
    const order: string[] = [];
    row.resume.mockImplementation(() => { order.push('activity'); });
    const registry = new ActivityRegistry(() => row);
    registry.start('c1', 'clarify', {});
    await registry.runModal(async () => undefined, {
      beforeActivityResume: () => { order.push('footer'); },
    });
    expect(row.pause).toHaveBeenCalledTimes(1);
    expect(row.resume).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['footer', 'activity']);
  });

  it('turn completion dismisses orphaned rows and empties timers', () => {
    const first = handle();
    const second = handle();
    const rows = [first, second];
    const registry = new ActivityRegistry(() => rows.shift()!);
    registry.start('old', 'clarify', {});
    registry.start('file', 'file_operations', {});
    registry.sweep();
    expect(first.dismiss).toHaveBeenCalledTimes(1);
    expect(second.dismiss).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);
    expect(registry.timerCount()).toBe(0);
    expect(registry.start('old', 'clarify', {})).toBe(false);
  });

  it('completed interactive activity can disappear while file work settles', () => {
    const clarify = handle();
    const file = handle();
    const rows = [clarify, file];
    const registry = new ActivityRegistry(() => rows.shift()!, () => 100);
    registry.start('q', 'clarify', {});
    registry.settle('q', { state: 'completed', dismiss: true });
    registry.start('f', 'file_operations', {});
    registry.settle('f', { state: 'completed' });
    expect(clarify.dismiss).toHaveBeenCalledTimes(1);
    expect(file.ok).toHaveBeenCalledTimes(1);
  });

  it('uses execution attempts instead of lifecycle time for a completed row', () => {
    let now = 0;
    const row = handle();
    const registry = new ActivityRegistry(() => row, () => now);
    registry.start('timed', 'shell_exec', {});
    now = 8_000;
    (registry as unknown as { observe(id: string, update: unknown): void }).observe('timed', {
      phase: 'awaiting_approval', at: 0,
    });
    now = 14_000;
    registry.settle('timed', {
      state: 'completed',
      timing: {
        dispatchStartedAt: 0,
        dispatchEndedAt: 14_000,
        approvalStartedAt: 0,
        approvalEndedAt: 8_000,
        executionAttempts: [{ attempt: 1, startedAt: 8_000, endedAt: 14_000, terminalResult: 'completed' }],
        terminalClassification: 'completed',
      },
    } as never);

    expect(row.ok).toHaveBeenCalledWith(6_000, 0, expect.objectContaining({ approvalWaitMs: 8_000 }));
  });

  it('does not let modal wait advance the running phase clock', async () => {
    let now = 0;
    let snapshot: (() => { phase: string; phaseElapsedMs: number }) | undefined;
    const row = handle();
    const registry = new ActivityRegistry(((_name, _args, read) => {
      snapshot = read;
      return row;
    }) as never, () => now);
    registry.start('modal', 'shell_exec', {});
    (registry as unknown as { observe(id: string, update: unknown): void }).observe('modal', {
      phase: 'running', at: now, attempt: 1,
    });
    now = 1_000;
    await registry.runModal(async () => { now = 9_000; });

    expect(snapshot?.().phase).toBe('running');
    expect(snapshot?.().phaseElapsedMs).toBe(1_000);
  });
});
