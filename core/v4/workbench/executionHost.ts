/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { Db } from '../daemon/db/connection';
import type { JobEngine } from '../daemon/jobEngine';
import type { RunStore } from '../daemon/runStore';
import type { TaskStore } from '../daemon/taskStore';
import type { TriggerBus } from '../daemon/triggerBus';
import {
  createDispatcher as createDurableDispatcher,
  createRealAgentRunner,
  type AgentBuilder,
  type Dispatcher,
} from '../daemon/dispatcher';
import { sweepDurableJobRecovery } from '../daemon/jobRecoverySweep';
import { reconcileWorkbenchQueue } from './queueReconciliation';

export interface WorkbenchExecutionSnapshot {
  available: boolean;
  runner: 'real' | 'unavailable';
  workerCount: number;
  pending: number;
  claimed: number;
  inflight: number;
  oldestPendingMs: number | null;
  processed: number;
}

export interface WorkbenchExecutionHost {
  start(): { reclaimed: number; orphaned: number; terminalTriggersRemoved: number; workerCount: number };
  stop(timeoutMs?: number): Promise<void>;
  snapshot(): WorkbenchExecutionSnapshot;
}

export interface CreateWorkbenchExecutionHostOptions {
  db: Db;
  triggerBus: TriggerBus;
  runStore: RunStore;
  jobEngine: JobEngine;
  taskStore: TaskStore;
  instanceId: string;
  agentBuilder: AgentBuilder;
  persistedDefault: { provider: string; model: string };
  workerCount?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  createRunner?: typeof createRealAgentRunner;
  createDispatcher?: typeof createDurableDispatcher;
  recoverySweep?: typeof sweepDurableJobRecovery;
}

/**
 * Hosts the existing TriggerBus dispatcher for the standalone Workbench. This
 * is an entry-point adapter only: JobEngine and the dispatcher retain all
 * lifecycle and scheduling authority.
 */
export function createWorkbenchExecutionHost(
  options: CreateWorkbenchExecutionHostOptions,
): WorkbenchExecutionHost {
  const workerCount = Math.max(1, Math.min(8, options.workerCount ?? 4));
  const makeRunner = options.createRunner ?? createRealAgentRunner;
  const makeDispatcher = options.createDispatcher ?? createDurableDispatcher;
  const runRecoverySweep = options.recoverySweep ?? sweepDurableJobRecovery;
  let dispatcher: Dispatcher | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopped = false;

  return {
    start() {
      if (started) return { reclaimed: 0, orphaned: 0, terminalTriggersRemoved: 0, workerCount };
      if (stopped) throw new Error('Workbench execution host cannot restart after shutdown');
      const reconciliation = reconcileWorkbenchQueue({
        jobs: options.jobEngine,
        runs: options.runStore,
        triggers: options.triggerBus,
      });
      const runner = makeRunner({
        db: options.db,
        runStore: options.runStore,
        jobEngine: options.jobEngine,
        taskStore: options.taskStore,
        agentBuilder: options.agentBuilder,
        persistedDefault: options.persistedDefault,
        log: options.log,
      });
      dispatcher = makeDispatcher({
        triggerBus: options.triggerBus,
        runStore: options.runStore,
        jobEngine: options.jobEngine,
        db: options.db,
        ownerId: options.instanceId,
        instanceId: options.instanceId,
        workerCount,
        runnerFactory: () => runner,
        initialRunnerKind: 'real',
        log: options.log,
      });
      dispatcher.start();
      const recover = (): void => {
        try {
          runRecoverySweep({
            jobEngine: options.jobEngine,
            triggerBus: options.triggerBus,
            instanceId: options.instanceId,
            producer: 'workbench-recovery',
          });
        } catch (error) {
          options.log?.('warn', `Workbench recovery sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      recover();
      recoveryTimer = setInterval(recover, 30_000);
      if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
      started = true;
      return { ...reconciliation, workerCount };
    },
    async stop(timeoutMs) {
      if (stopped) return;
      stopped = true;
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = null;
      if (dispatcher) await dispatcher.stop(timeoutMs);
    },
    snapshot() {
      const queue = options.triggerBus.stats();
      const stats = dispatcher?.stats();
      return {
        available: started && !stopped,
        runner: started && !stopped ? 'real' : 'unavailable',
        workerCount,
        pending: queue.pending,
        claimed: queue.claimed,
        inflight: dispatcher?.inflight().length ?? 0,
        oldestPendingMs: queue.oldestPendingMs,
        processed: stats?.claimed ?? 0,
      };
    },
  };
}
