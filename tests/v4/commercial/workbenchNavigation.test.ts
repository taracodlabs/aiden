import { describe, expect, it } from 'vitest';

import {
  applyWorkbenchDestination,
  applyWorkbenchSelection,
  parseWorkbenchDestination,
} from '../../../dashboard-next/lib/workbenchNavigation';

describe('Workbench product deep links', () => {
  it('opens exact readiness and Apps destinations while preserving run identity', () => {
    const base = 'http://127.0.0.1:4280/?jobId=job-1&attemptId=attempt-1&runId=7';
    const readiness = applyWorkbenchDestination(base, { settings: 'runtime' });
    expect(readiness).toContain('jobId=job-1');
    expect(readiness).toContain('settings=runtime');
    expect(parseWorkbenchDestination(new URL(readiness).search)).toEqual({ settings: 'runtime' });

    const apps = applyWorkbenchDestination(readiness, { view: 'apps' });
    expect(apps).toContain('jobId=job-1');
    expect(apps).not.toContain('settings=');
    expect(parseWorkbenchDestination(new URL(apps).search)).toEqual({ view: 'apps' });
  });

  it('ignores unknown destinations and clears only Workbench navigation keys', () => {
    expect(parseWorkbenchDestination('?view=unknown&settings=unsafe')).toEqual({});
    const cleared = applyWorkbenchDestination(
      'http://127.0.0.1:4280/?jobId=job-1&view=apps&settings=runtime',
      {},
    );
    expect(cleared).toContain('jobId=job-1');
    expect(cleared).not.toContain('view=');
    expect(cleared).not.toContain('settings=');
  });

  it('preserves an explicit Apps or Settings destination while runtime identity reconciles', () => {
    const apps = applyWorkbenchSelection(
      'http://127.0.0.1:4280/?view=apps',
      '?session=session-1&job=job-1&attempt=attempt-1&run=7',
      true,
    );
    expect(new URL(apps).searchParams.get('view')).toBe('apps');
    expect(new URL(apps).searchParams.get('job')).toBe('job-1');

    const readiness = applyWorkbenchSelection(
      'http://127.0.0.1:4280/?settings=runtime',
      '?session=session-1',
      true,
    );
    expect(new URL(readiness).searchParams.get('settings')).toBe('runtime');
    expect(new URL(readiness).searchParams.get('session')).toBe('session-1');

    const explicitChat = applyWorkbenchSelection(apps, '?session=session-2', false);
    expect(new URL(explicitChat).searchParams.has('view')).toBe(false);
    expect(new URL(explicitChat).searchParams.get('session')).toBe('session-2');
  });
});
