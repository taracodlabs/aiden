import { describe, expect, it } from 'vitest';

import {
  applyUpdateFailure,
  clearUpdateFailure,
  isUpdateFailureBackedOff,
} from '../../../../core/v4/update/failureBackoff';

const base = { ts: 1, latest: '4.16.0', installed: '4.15.1' };

describe('update failure backoff', () => {
  it('defers the same failed version for a bounded interval', () => {
    const failed = applyUpdateFailure(base, '4.16.0', 1_000);
    expect(failed.failedVersion).toBe('4.16.0');
    expect(failed.failureCount).toBe(1);
    expect(failed.retryAfter).toBeGreaterThan(1_000);
    expect(isUpdateFailureBackedOff(failed, '4.16.0', 1_001)).toBe(true);
    expect(isUpdateFailureBackedOff(failed, '4.16.0', failed.retryAfter!)).toBe(false);
  });

  it('never suppresses a newer version because an older update failed', () => {
    const failed = applyUpdateFailure(base, '4.16.0', 1_000);
    expect(isUpdateFailureBackedOff(failed, '4.16.1', 1_001)).toBe(false);
  });

  it('caps repeated failures and clears only failure state on success', () => {
    let state = base;
    for (let i = 0; i < 20; i += 1) {
      state = applyUpdateFailure(state, '4.16.0', 1_000 + i);
    }
    expect(state.retryAfter! - 1_019).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    const cleared = clearUpdateFailure({ ...state, skippedVersion: '4.15.9' });
    expect(cleared.failedVersion).toBeUndefined();
    expect(cleared.retryAfter).toBeUndefined();
    expect(cleared.skippedVersion).toBe('4.15.9');
  });
});
