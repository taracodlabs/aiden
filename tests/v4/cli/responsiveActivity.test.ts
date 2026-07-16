import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ActivityRegistry } from '../../../cli/v4/activityRegistry';
import { Display, type LiveActivityRowHandle, type ToolRowHandle } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function makeOutput(columns: number) {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = true;
  out.columns = columns;
  return { out, chunks };
}

function noOpToolRow(): ToolRowHandle {
  return {
    refresh: vi.fn(), ok: vi.fn(), fail: vi.fn(), degraded: vi.fn(), retry: vi.fn(),
    blocked: vi.fn(), emptyRetry: vi.fn(), emptyFail: vi.fn(), cancel: vi.fn(),
    dismiss: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn(() => true),
  };
}

describe('responsive registry-owned turn activity', () => {
  it('projects distinct provider animation frames from consecutive registry ticks', () => {
    vi.useFakeTimers();
    try {
      const { out, chunks } = makeOutput(120);
      const display = new Display({
        stdout: out as unknown as NodeJS.WriteStream,
        skin: new SkinEngine({ forceMono: true }),
      });
      const registry = new ActivityRegistry(
        () => noOpToolRow(),
        Date.now,
        (verb) => display.liveActivityRow(verb),
      );
      registry.startTurnActivity('calling provider');
      const afterStart = chunks.length;
      vi.advanceTimersByTime(250);
      vi.advanceTimersByTime(250);
      const wideFrames = chunks.slice(afterStart).map(stripAnsi);
      expect(wideFrames).toHaveLength(2);
      expect(wideFrames[0]).not.toBe(wideFrames[1]);
      expect(wideFrames.every((frame) => frame.replace(/\r|\n/g, '').length <= 118)).toBe(true);

      out.columns = 44;
      registry.invalidateLayout();
      const beforeNarrow = chunks.length;
      vi.advanceTimersByTime(250);
      vi.advanceTimersByTime(250);
      const narrowFrames = chunks.slice(beforeNarrow).map(stripAnsi);
      expect(narrowFrames).toHaveLength(2);
      expect(narrowFrames[0]).not.toBe(narrowFrames[1]);
      expect(narrowFrames.every((frame) => frame.replace(/\r|\n/g, '').length <= 42)).toBe(true);

      registry.pauseForModal();
      const pausedCount = chunks.length;
      vi.advanceTimersByTime(1_000);
      expect(chunks).toHaveLength(pausedCount);
      registry.resumeAfterModal();
      registry.settleTurnActivity();
      const settledCount = chunks.length;
      vi.advanceTimersByTime(1_000);
      expect(chunks).toHaveLength(settledCount);
      expect(registry.timerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one registry timer and settles it idempotently', () => {
    vi.useFakeTimers();
    const row: LiveActivityRowHandle = {
      refresh: vi.fn(), setVerb: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      stop: vi.fn(), invalidateLayout: vi.fn(), isActive: vi.fn(() => true),
    };
    const registry = new ActivityRegistry(() => noOpToolRow(), Date.now, () => row);
    expect(registry.startTurnActivity('thinking')).toBe(true);
    expect(registry.timerCount()).toBe(1);
    registry.setTurnPhase('calling provider');
    expect(row.setVerb).toHaveBeenCalledWith('calling provider');
    vi.advanceTimersByTime(750);
    expect(row.refresh).toHaveBeenCalledTimes(3);
    expect(registry.settleTurnActivity()).toBe(true);
    expect(registry.settleTurnActivity()).toBe(false);
    expect(registry.timerCount()).toBe(0);
    const refreshes = vi.mocked(row.refresh).mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(row.refresh).toHaveBeenCalledTimes(refreshes);
    vi.useRealTimers();
  });

  it('clamps the complete provider row at 120, 44, and 100 columns', () => {
    const { out, chunks } = makeOutput(120);
    const display = new Display({
      stdout: out as unknown as NodeJS.WriteStream,
      skin: new SkinEngine({ forceMono: true }),
    });
    display.setBusyHint('Enter → queue · /busy to change · Ctrl+C stop');
    const row = display.liveActivityRow('calling provider');
    const assertLatestFrameFits = (width: number): void => {
      const frames = chunks.flatMap((chunk) => stripAnsi(chunk).split('\n'))
        .filter((line) => line.includes('provider'));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)!.length).toBeLessThanOrEqual(width - 2);
    };
    assertLatestFrameFits(120);
    out.columns = 44;
    row.refresh();
    assertLatestFrameFits(44);
    out.columns = 100;
    row.refresh();
    assertLatestFrameFits(100);
    row.stop();
  });

  it('pauses the single timer and redraws once across a modal', async () => {
    vi.useFakeTimers();
    const row: LiveActivityRowHandle = {
      refresh: vi.fn(), setVerb: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      stop: vi.fn(), invalidateLayout: vi.fn(), isActive: vi.fn(() => true),
    };
    const registry = new ActivityRegistry(() => noOpToolRow(), Date.now, () => row);
    registry.startTurnActivity('calling provider');
    await registry.runModal(async () => {
      expect(registry.timerCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
    });
    expect(row.pause).toHaveBeenCalledTimes(1);
    expect(row.resume).toHaveBeenCalledTimes(1);
    expect(registry.timerCount()).toBe(1);
    registry.sweep();
    vi.useRealTimers();
  });

  it('does not repaint a cancelled activity when the final modal pause releases', async () => {
    vi.useFakeTimers();
    try {
      const turnRow: LiveActivityRowHandle = {
        refresh: vi.fn(), setVerb: vi.fn(), pause: vi.fn(), resume: vi.fn(),
        stop: vi.fn(), invalidateLayout: vi.fn(), isActive: vi.fn(() => true),
      };
      const toolRow = noOpToolRow();
      const registry = new ActivityRegistry(() => toolRow, Date.now, () => turnRow);
      registry.startTurnActivity('calling provider');
      registry.start('approval-call', 'shell_exec', { command: 'echo blocked' });

      await registry.runModal(
        async () => 'interrupted' as const,
        { resumeActivityWhen: (decision) => decision !== 'interrupted' },
      );

      expect(turnRow.resume).not.toHaveBeenCalled();
      expect(toolRow.resume).not.toHaveBeenCalled();
      expect(registry.timerCount()).toBe(0);
      expect(registry.modalPauseDepth()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(turnRow.refresh).not.toHaveBeenCalled();
      expect(toolRow.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cancellation suppression through nested modal release', async () => {
    const row = noOpToolRow();
    const registry = new ActivityRegistry(() => row);
    registry.start('nested-approval', 'shell_exec', {});

    registry.pauseForModal();
    await registry.runModal(
      async () => 'interrupted' as const,
      { resumeActivityWhen: () => false },
    );
    expect(registry.modalPauseDepth()).toBe(1);
    expect(row.resume).not.toHaveBeenCalled();

    registry.resumeAfterModal();
    expect(row.resume).not.toHaveBeenCalled();
    expect(registry.timerCount()).toBe(0);
  });

  it('recalculates tool-row width on every repaint', () => {
    const { out, chunks } = makeOutput(120);
    const display = new Display({
      stdout: out as unknown as NodeJS.WriteStream,
      skin: new SkinEngine({ forceMono: true }),
    });
    const row = display.toolRow('shell_exec', {
      command: 'a deliberately long command preview that must never retain stale geometry after resize',
    }, undefined, { externalTicker: true });
    for (const width of [44, 90]) {
      out.columns = width;
      row.refresh?.();
      const latest = stripAnsi(chunks.at(-1) ?? '').split('\n').filter(Boolean).at(-1) ?? '';
      expect(latest.length).toBeLessThanOrEqual(width - 2);
    }
    row.ok(1_500);
  });

  it('keeps the footer bounded and restores richer content after widening', () => {
    const { out } = makeOutput(44);
    const display = new Display({
      stdout: out as unknown as NodeJS.WriteStream,
      skin: new SkinEngine({ forceMono: true }),
    });
    const args = {
      provider: 'provider', model: 'recognizable-model', ctxUsed: 2_000,
      ctxMax: 8_000, elapsedMs: 2_500, sessionMs: 20_000, state: 'ok' as const,
    };
    const narrow = stripAnsi(display.statusFooter(args));
    expect(narrow.length).toBeLessThanOrEqual(42);
    expect(narrow).toContain('recognizable-model');
    out.columns = 120;
    const wide = stripAnsi(display.statusFooter(args));
    expect(wide.length).toBeLessThanOrEqual(118);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(wide).toContain('25%');
  });
});
