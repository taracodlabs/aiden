import { describe, expect, it } from 'vitest';

import {
  directWorkbenchPrompt,
  resolveDispatcherSessionId,
} from '../../../core/v4/daemon/dispatcher';

const event = (overrides: Record<string, unknown> = {}) => ({
  source: 'manual' as const,
  sourceKey: 'workbench-web',
  idempotencyKey: 'event-key',
  payload: {
    body: { prompt: 'Read package.json and report the version', source: 'workbench-web' },
    sessionId: 'session_exact',
    durable_job: { job_id: 'job_1', attempt_id: 'attempt_1', run_id: 7 },
  },
  ...overrides,
});

describe('Workbench dispatcher input', () => {
  it('sends the exact user prompt instead of a trigger payload dump', () => {
    const value = directWorkbenchPrompt(event());
    expect(value).toBe('Read package.json and report the version');
    expect(value).not.toContain('durable_job');
  });

  it('preserves the Workbench session identity for durable run events', () => {
    expect(resolveDispatcherSessionId(event())).toBe('session_exact');
  });

  it('does not reinterpret other manual trigger payloads as Workbench prompts', () => {
    const other = event({ sourceKey: 'manual-client' });
    expect(directWorkbenchPrompt(other)).toBeNull();
    expect(resolveDispatcherSessionId(other)).toMatch(/^trigger:manual:manual-client:/);
  });
});
