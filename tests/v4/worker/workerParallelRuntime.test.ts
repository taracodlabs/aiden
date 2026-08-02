/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createDispatcher, makeRunner } from '../../../core/v4/daemon/dispatcher';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import {
  admitParallelWorkers,
  createParallelWorkerFixture,
  type ParallelWorkerFixture,
} from './workerParallelFixture';

describe('bounded parallel read-only Worker delivery', () => {
  let fixture: ParallelWorkerFixture | undefined;
  afterEach(async () => fixture?.close());

  for (const count of [2, 4]) {
    it(`delivers ${count} canonical child Jobs concurrently through the existing dispatcher`, async () => {
      fixture = await createParallelWorkerFixture();
      const admitted = admitParallelWorkers(fixture, { count });
      let active = 0;
      let peak = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let processing!: Promise<Array<number | null>>;
      const entered = new Promise<void>((resolve) => {
        const dispatcher = createDispatcher({
          triggerBus: fixture!.triggerBus,
          runStore: createRunStore({ db: fixture!.db }),
          db: fixture!.db,
          jobEngine: fixture!.engine,
          ownerId: 'worker-instance',
          instanceId: 'worker-instance',
          workerCount: count,
          runnerFactory: () => makeRunner(async (input) => {
            active += 1;
            peak = Math.max(peak, active);
            if (active === count) resolve();
            await barrier;
            active -= 1;
            return { runId: input.admission!.runId, finishReason: 'stop' };
          }),
        });
        processing = Promise.all(Array.from({ length: count }, () => dispatcher._pumpOnce()));
      });
      await entered;
      expect(peak).toBe(count);
      expect(admitted.admissions).toHaveLength(count);
      for (const item of admitted.admissions) {
        expect(fixture.engine.resources.authorize({
          jobId: item.admission.child.jobId,
          kind: 'tool',
          value: 'shell_exec',
        })).toBe(false);
        expect(fixture.engine.resources.getWorkerProviderConcurrencyForMember(item.memberId))
          .toMatchObject({ state: 'reserved', providerId: 'custom_openai' });
      }
      release();
      await processing;
      expect(fixture.triggerBus.stats().pending).toBe(0);
    });
  }
});
