import { describe, expect, it, vi } from 'vitest';

import { createWorkbenchExecutionHost } from '../../../core/v4/workbench/executionHost';

describe('Workbench execution host', () => {
  const jobControlAuthority = () => ({
    runtime: { attach: vi.fn(), cancel: vi.fn(), isAttached: vi.fn() },
  }) as never;

  it('starts the existing durable dispatcher with the real runner and bounded concurrency', async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const reclaimExpired = vi.fn(() => ({ reclaimed: 2 }));
    const createRunner = vi.fn(() => ({ invoke: vi.fn() }));
    const sharedJobControlAuthority = jobControlAuthority();
    const artifactStore = { create: vi.fn(), get: vi.fn(), listRecent: vi.fn() } as never;
    const createDispatcher = vi.fn(() => ({
      start, stop, inflight: () => [], stats: () => ({ claimed: 0, succeeded: 0, failed: 0, deadLetter: 0, deliverOnly: 0, misconfigured: 0 }),
      installRunner: vi.fn(), runnerKind: () => 'real' as const, _pumpOnce: vi.fn(),
    }));
    const host = createWorkbenchExecutionHost({
      db: {} as never,
      triggerBus: { reclaimExpired, stats: () => ({ pending: 3, claimed: 0, running: 0, deadLetter: 0, oldestPendingMs: 80 }) } as never,
      runStore: { get: vi.fn() } as never,
      jobEngine: { listJobs: () => [], getAttempt: vi.fn(), cancelJob: vi.fn() } as never,
      taskStore: {} as never,
      artifactStore,
      jobControlAuthority: sharedJobControlAuthority,
      instanceId: 'workbench_1',
      agentBuilder: vi.fn() as never,
      persistedDefault: { provider: 'custom_openai', model: 'custom-default' },
      workerCount: 4,
      createRunner,
      createDispatcher,
    });

    expect(host.start()).toMatchObject({ reclaimed: 2, workerCount: 4 });
    expect(reclaimExpired).toHaveBeenCalledOnce();
    expect(createRunner).toHaveBeenCalledOnce();
    expect(createRunner).toHaveBeenCalledWith(expect.objectContaining({
      artifactStore,
      jobControlAuthority: sharedJobControlAuthority,
    }));
    expect(createDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      workerCount: 4, ownerId: 'workbench_1', instanceId: 'workbench_1', initialRunnerKind: 'real',
    }));
    expect(start).toHaveBeenCalledOnce();
    expect(host.snapshot()).toMatchObject({ available: true, workerCount: 4, pending: 3, runner: 'real' });
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('starts and stops idempotently without creating a second scheduler', async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const createDispatcher = vi.fn(() => ({
      start, stop, inflight: () => [], stats: () => ({ claimed: 0, succeeded: 0, failed: 0, deadLetter: 0, deliverOnly: 0, misconfigured: 0 }),
      installRunner: vi.fn(), runnerKind: () => 'real' as const, _pumpOnce: vi.fn(),
    }));
    const host = createWorkbenchExecutionHost({
      db: {} as never, triggerBus: { reclaimExpired: () => ({ reclaimed: 0 }), stats: () => ({ pending: 0, claimed: 0, running: 0, deadLetter: 0, oldestPendingMs: null }) } as never,
      runStore: { get: vi.fn() } as never,
      jobEngine: { listJobs: () => [], getAttempt: vi.fn(), cancelJob: vi.fn() } as never,
      jobControlAuthority: jobControlAuthority(),
      instanceId: 'workbench_1', agentBuilder: vi.fn() as never,
      persistedDefault: { provider: 'p', model: 'm' },
      createRunner: () => ({ invoke: vi.fn() }) as never, createDispatcher,
    });
    host.start(); host.start();
    await host.stop(); await host.stop();
    expect(createDispatcher).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('preserves only restart-safe Automation approvals when the Workbench host shuts down', async () => {
    const stop = vi.fn(async () => undefined);
    const cancelPendingForJob = vi.fn(() => []);
    const host = createWorkbenchExecutionHost({
      db: {} as never,
      triggerBus: { reclaimExpired: () => ({ reclaimed: 0 }), stats: () => ({ pending: 0, claimed: 0, running: 0, deadLetter: 0, oldestPendingMs: null }) } as never,
      runStore: { get: vi.fn() } as never,
      jobEngine: {
        listJobs: vi.fn(({ terminal }: { terminal?: boolean } = {}) => terminal === false
          ? [
              { id: 'job_waiting', activeAttemptId: 'attempt_waiting' },
              { id: 'job_running', activeAttemptId: 'attempt_running' },
            ]
          : []),
        getAttempt: vi.fn((attemptId: string) => attemptId === 'attempt_waiting'
          ? { id: attemptId, generation: 3 }
          : { id: attemptId, generation: 1 }),
        cancelJob: vi.fn(),
      } as never,
      approvalAuthority: { cancelPendingForJob } as never,
      automationApprovalContinuations: {
        hasPendingForAttempt: vi.fn((jobId: string) => jobId === 'job_waiting'),
      } as never,
      jobControlAuthority: jobControlAuthority(),
      taskStore: {} as never,
      instanceId: 'workbench_shutdown', agentBuilder: vi.fn() as never,
      persistedDefault: { provider: 'p', model: 'm' },
      createRunner: () => ({ invoke: vi.fn() }) as never,
      createDispatcher: () => ({
        start: vi.fn(), stop, inflight: () => [], stats: () => ({ claimed: 0, succeeded: 0, failed: 0, deadLetter: 0, deliverOnly: 0, misconfigured: 0 }),
        installRunner: vi.fn(), runnerKind: () => 'real' as const, _pumpOnce: vi.fn(),
      }),
    });

    host.start();
    await host.stop();
    expect(cancelPendingForJob).toHaveBeenCalledTimes(1);
    expect(cancelPendingForJob).toHaveBeenCalledWith('job_running', 'Workbench execution host shutdown');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('runs and owns the durable recovery sweep for standalone Workbench restarts', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => undefined);
    const recoverySweep = vi.fn(() => ({
      expired: 0, retried: 0, needsUser: 0, deadLettered: 0, enqueued: 0, reconciled: 0,
    }));
    const host = createWorkbenchExecutionHost({
      db: {} as never,
      triggerBus: { reclaimExpired: () => ({ reclaimed: 0 }), stats: () => ({ pending: 0, claimed: 0, running: 0, deadLetter: 0, oldestPendingMs: null }) } as never,
      runStore: { get: vi.fn() } as never,
      jobEngine: { listJobs: () => [], getAttempt: vi.fn(), cancelJob: vi.fn() } as never,
      jobControlAuthority: jobControlAuthority(),
      taskStore: {} as never,
      instanceId: 'workbench_2',
      agentBuilder: vi.fn() as never,
      persistedDefault: { provider: 'p', model: 'm' },
      createRunner: () => ({ invoke: vi.fn() }) as never,
      createDispatcher: () => ({
        start: vi.fn(), stop, inflight: () => [], stats: () => ({ claimed: 0, succeeded: 0, failed: 0, deadLetter: 0, deliverOnly: 0, misconfigured: 0 }),
        installRunner: vi.fn(), runnerKind: () => 'real' as const, _pumpOnce: vi.fn(),
      }),
      recoverySweep,
    });

    host.start();
    expect(recoverySweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recoverySweep).toHaveBeenCalledTimes(2);
    await host.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverySweep).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
