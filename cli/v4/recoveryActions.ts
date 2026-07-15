import type { TaskOutcomePresentation } from '../../core/v4/taskOutcomePresentation';

export type RecoveryActionSource = 'provider' | 'model' | 'approval' | 'task' | 'tool' | 'queue' | 'system';

/** A contextual, non-persistent next step derived from structured turn state. */
export interface RecoveryAction {
  readonly id: string;
  readonly label: string;
  readonly command?: string;
  readonly instruction?: string;
  readonly priority: number;
  readonly source: RecoveryActionSource;
  readonly safeToSuggest: boolean;
  readonly dedupeKey: string;
}

const statusAction = (id: string, label: string, source: RecoveryActionSource): RecoveryAction => Object.freeze({
  id,
  label,
  command: '/status',
  priority: 10,
  source,
  safeToSuggest: true,
  dedupeKey: id,
});

/** Maps finalized outcome facts to one conservative next action. */
export function recoveryActionsForOutcome(outcome: TaskOutcomePresentation): readonly RecoveryAction[] {
  switch (outcome.kind) {
    case 'denied':
      return [Object.freeze({
        id: 'approval:denied',
        label: 'The action was not run. Adjust the request if you want a different approach.',
        instruction: 'Adjust the request if you want a different approach.',
        priority: 10,
        source: 'approval',
        safeToSuggest: true,
        dedupeKey: 'approval:denied',
      })];
    case 'cancelled':
      return [statusAction('task:cancelled', 'Interrupted. Use /status to inspect the current state.', 'task')];
    case 'timed_out':
      return [statusAction('task:timed-out', 'Timed out. Use /status to inspect the current state before continuing.', 'task')];
    case 'partial':
      return [statusAction('task:partial', 'Some required work remains. Use /status to inspect the current state.', 'task')];
    case 'failed':
    case 'unverified_required':
      return [statusAction('task:failed', 'Use /status to inspect what completed and what did not.', 'tool')];
    default:
      return [];
  }
}
