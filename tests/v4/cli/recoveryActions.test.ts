import { describe, expect, it } from 'vitest';

import { recoveryActionsForOutcome } from '../../../cli/v4/recoveryActions';
import type { TaskOutcomePresentation } from '../../../core/v4/taskOutcomePresentation';

function outcome(kind: TaskOutcomePresentation['kind']): TaskOutcomePresentation {
  return {
    kind,
    severity: 'info',
    label: kind,
    evidenceCount: 0,
    hasRequiredEvidenceGap: false,
    executionStarted: false,
    inspectable: false,
    prominent: false,
    requiredCompletedCount: 0,
    requiredDeniedCount: 0,
    requiredFailedCount: 0,
    requiredSkippedCount: 0,
    requiredUnresolvedCount: 0,
    optionalDeniedCount: 0,
  };
}

describe('recovery actions', () => {
  it('preserves a denial without suggesting another approval', () => {
    const actions = recoveryActionsForOutcome(outcome('denied'));
    expect(actions.map((action) => action.command)).not.toContain('/approve');
    expect(actions[0]).toMatchObject({ source: 'approval', safeToSuggest: true });
  });

  it('distinguishes cancellation and timeout without claiming retry safety', () => {
    expect(recoveryActionsForOutcome(outcome('cancelled'))[0]).toMatchObject({ command: '/status', source: 'task' });
    const timeout = recoveryActionsForOutcome(outcome('timed_out'));
    expect(timeout[0]).toMatchObject({ command: '/status', source: 'task' });
    expect(timeout.map((action) => action.label).join(' ')).not.toMatch(/safe to retry/i);
  });

  it('keeps partial and failed work inspectable through a registered status command', () => {
    for (const kind of ['partial', 'failed', 'unverified_required'] as const) {
      expect(recoveryActionsForOutcome(outcome(kind))[0]?.command).toBe('/status');
    }
  });
});
