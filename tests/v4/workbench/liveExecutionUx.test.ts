/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  chooseLiveExecutionSurface,
  liveExecutionAutoOpenKey,
  liveExecutionLayout,
  shouldAutoOpenLiveExecution,
  type LiveExecutionSelection,
} from '../../../dashboard-next/lib/liveExecutionUx';

const surfaces = [
  { surfaceId: 'terminal_1', kind: 'terminal', status: 'live', updatedAt: 2 },
  { surfaceId: 'browser_1', kind: 'browser', status: 'live', updatedAt: 3 },
  { surfaceId: 'changes_1', kind: 'changes', status: 'waiting', updatedAt: 4 },
] as const;

describe('Live Execution selection', () => {
  it('A1 opens a meaningful active surface when none is selected', () => {
    expect(chooseLiveExecutionSurface(surfaces, { selectedSurfaceId: null, pinnedSurfaceId: null, autoFollow: true }, 'browser_1').selectedSurfaceId).toBe('browser_1');
  });

  it('A2-A4 preserves manual selection and pinning across routine focus hints', () => {
    const manual: LiveExecutionSelection = { selectedSurfaceId: 'terminal_1', pinnedSurfaceId: null, autoFollow: false };
    expect(chooseLiveExecutionSurface(surfaces, manual, 'browser_1')).toEqual(manual);
    const pinned = { selectedSurfaceId: 'terminal_1', pinnedSurfaceId: 'terminal_1', autoFollow: true };
    expect(chooseLiveExecutionSurface(surfaces, pinned, 'browser_1')).toEqual(pinned);
  });

  it('A5 reports attention on another surface without stealing a pinned view', () => {
    const result = chooseLiveExecutionSurface(surfaces, {
      selectedSurfaceId: 'terminal_1', pinnedSurfaceId: 'terminal_1', autoFollow: true,
    }, 'browser_1', 'browser_1');
    expect(result).toMatchObject({ selectedSurfaceId: 'terminal_1', attentionSurfaceId: 'browser_1' });
  });

  it('A6 falls back deterministically when the selected surface disappears', () => {
    expect(chooseLiveExecutionSurface(surfaces.slice(1), {
      selectedSurfaceId: 'terminal_1', pinnedSurfaceId: null, autoFollow: true,
    }, 'changes_1').selectedSurfaceId).toBe('changes_1');
  });

  it('A7 keeps a manually collapsed surface closed until meaningful execution changes', () => {
    const identity = { jobId: 'job_1', attemptId: 'attempt_1', generation: 2, runId: 9 };
    const dismissedKey = liveExecutionAutoOpenKey(identity, 'terminal_1');

    expect(shouldAutoOpenLiveExecution(identity, false, 'terminal_1', dismissedKey)).toBe(false);
    expect(shouldAutoOpenLiveExecution(identity, false, 'browser_1', dismissedKey)).toBe(true);
    expect(shouldAutoOpenLiveExecution(identity, true, 'browser_1', dismissedKey)).toBe(false);
  });
});

describe('Live Execution responsive layout', () => {
  it.each([[1920, 'split'], [1366, 'split'], [900, 'drawer'], [480, 'sheet']] as const)(
    'R maps %ipx to %s without squeezing three columns',
    (width, mode) => expect(liveExecutionLayout(width).mode).toBe(mode),
  );
});
