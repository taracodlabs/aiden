/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 — cronManager lazy cache self-hydration.
 *
 * The bug: the sync API (listJobs/getJob/createJob/pauseJob/resumeJob/
 * deleteJob) read an in-memory cache that only loadJobs()/async calls
 * populated — and NO production entry point called either first. So
 * `aiden cron list` printed "No cron jobs." with valid jobs on disk,
 * pause/resume/delete no-op'd with "not found", and createJob minted a
 * colliding id whose persistence was then silently dropped.
 *
 * The fix: every sync accessor self-hydrates from disk on first touch —
 * idempotent per process, cache-only (no timer arming, no disk mutation).
 *
 * Covers: the exact regression (fresh process-state + disk file → list
 * sees jobs), write safety (create on top of existing jobs appends with
 * a fresh id — never clobbers or drops), mutation-by-id from cold cache,
 * hydration idempotence, async-path guard satisfaction, and the
 * non-destructive corrupt-file fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  listJobs,
  getJob,
  createJob,
  pauseJob,
  resumeJob,
  deleteJob,
  listJobsAsync,
  awaitPendingSaves,
  setCronPathsForTests,
  __resetForTests,
  __testPaths,
} from '../../../core/v4/cron/cronManager';

let tmp: string;

/** Two well-formed on-disk jobs, ids 1 + 2. */
function seedState(): string {
  const job = (id: string, description: string) => ({
    id, description,
    schedule: 'every 1h', kind: 'interval', intervalMs: 3_600_000,
    action: `say hi ${id}`, enabled: true, state: 'scheduled',
    pausedAt: null, pausedReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastError: null, lastDeliveryError: null, runCount: 0,
  });
  return JSON.stringify({
    schemaVersion: 2,
    updatedAt: '2026-07-01T00:00:00.000Z',
    jobs: [job('1', 'first job'), job('2', 'second job')],
  });
}

async function seedDisk(): Promise<void> {
  await fs.writeFile(path.join(tmp, 'cron_jobs.json'), seedState(), 'utf8');
}

/** Poll until the on-disk state satisfies `pred` (sync mutators persist
 *  in a background IIFE — no await surface). */
async function waitForDisk(
  pred: (jobs: Array<{ id: string; description: string; enabled: boolean }>) => boolean,
  // Generous: the sync mutators persist via a background withLock IIFE,
  // and under full-suite parallel-worker contention the lock acquisition
  // alone can take seconds. 15s sits inside the CI-mode 20s testTimeout.
  timeoutMs = 15_000,
): Promise<Array<{ id: string; description: string; enabled: boolean }>> {
  const stateFile = path.join(tmp, 'cron_jobs.json');
  const started = Date.now();
  for (;;) {
    // Drain the atomic-write queue each iteration: the sync mutators
    // persist in a background `withLock` IIFE, so once that write is
    // queued this collapses the poll-vs-persist race deterministically
    // (removes the under-contention flake) rather than relying on the
    // 25ms poll happening to land after the rename.
    try { await awaitPendingSaves(); } catch { /* best-effort drain */ }
    try {
      const jobs = JSON.parse(await fs.readFile(stateFile, 'utf8')).jobs;
      if (pred(jobs)) return jobs;
    } catch { /* mid-rename — retry */ }
    if (Date.now() - started > timeoutMs) throw new Error('waitForDisk: condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cron-lazy-'));
  // Order matters: __resetForTests re-points _paths at the default, so
  // the test paths must be applied AFTER the reset. Both now clear the
  // cache + lazy-hydration guard — each test starts truly cold.
  __resetForTests();
  setCronPathsForTests(__testPaths(tmp));
});

afterEach(async () => {
  await awaitPendingSaves();
  __resetForTests();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('lazy hydration — read paths (the aiden cron list regression)', () => {
  it('REGRESSION: cold sync listJobs() sees jobs already on disk (no loadJobs / async call first)', async () => {
    await seedDisk();
    const jobs = listJobs();
    expect(jobs.map((j) => j.id)).toEqual(['1', '2']);
    expect(jobs[0].description).toBe('first job');
  });

  it('cold getJob(id) resolves a disk job', async () => {
    await seedDisk();
    expect(getJob('2')?.description).toBe('second job');
  });

  it('missing state file → empty list, nothing created on disk', () => {
    expect(listJobs()).toEqual([]);
    expect(existsSync(path.join(tmp, 'cron_jobs.json'))).toBe(false);
  });

  it('corrupt state file → empty list, file left IN PLACE (sync path never bak-renames)', async () => {
    await fs.writeFile(path.join(tmp, 'cron_jobs.json'), '{definitely not json', 'utf8');
    expect(listJobs()).toEqual([]);
    // Non-destructive: the corrupt file was not renamed aside.
    expect(readdirSync(tmp)).toEqual(['cron_jobs.json']);
  });

  it('legacy v1 bare-array file hydrates through the same migration the async reader uses', async () => {
    const v1 = [{
      id: '7', description: 'v1 job', schedule: 'every 1h', kind: 'interval',
      intervalMs: 3_600_000, action: 'say hi', enabled: true, state: 'scheduled',
      createdAt: '2026-07-01T00:00:00.000Z', runCount: 0,
    }];
    await fs.writeFile(path.join(tmp, 'cron_jobs.json'), JSON.stringify(v1), 'utf8');
    expect(listJobs().map((j) => j.id)).toEqual(['7']);
  });
});

describe('lazy hydration — write safety (never clobber, never collide)', () => {
  it('WRITE SAFETY: cold createJob on top of 2 disk jobs mints id 3 and appends — originals preserved', async () => {
    await seedDisk();
    const job = createJob('third job', 'every 2h', 'say hi 3');
    // Id minted AFTER hydration — no collision with on-disk 1/2.
    expect(job.id).toBe('3');
    const onDisk = await waitForDisk((jobs) => jobs.length === 3);
    expect(onDisk.map((j) => j.id).sort()).toEqual(['1', '2', '3']);
    expect(onDisk.find((j) => j.id === '1')?.description).toBe('first job');
    expect(onDisk.find((j) => j.id === '3')?.description).toBe('third job');
  }, 30_000);

  it('cold pauseJob/resumeJob find the disk job (no false "not found") and persist', async () => {
    await seedDisk();
    expect(pauseJob('1', 'testing')).toBe(true);
    let onDisk = await waitForDisk((jobs) => jobs.some((j) => j.id === '1' && j.enabled === false));
    expect(onDisk.length).toBe(2);                      // nothing clobbered
    expect(resumeJob('1')).toBe(true);
    onDisk = await waitForDisk((jobs) => jobs.some((j) => j.id === '1' && j.enabled === true));
    expect(onDisk.length).toBe(2);
  }, 30_000);

  it('cold deleteJob removes exactly the target job from disk', async () => {
    await seedDisk();
    expect(deleteJob('1')).toBe(true);
    const onDisk = await waitForDisk((jobs) => jobs.length === 1);
    expect(onDisk[0].id).toBe('2');
  }, 30_000);
});

describe('lazy hydration — idempotence + interplay with async paths', () => {
  it('double hydration is a no-op: repeated sync reads are stable and cheap', async () => {
    await seedDisk();
    const a = listJobs();
    const b = listJobs();
    expect(b).toEqual(a);
    // Documented semantics: the lazy read is once-per-process; an external
    // disk change does NOT appear in subsequent sync reads (use the async
    // API for freshness). This pins the "no re-read every call" contract.
    await fs.writeFile(
      path.join(tmp, 'cron_jobs.json'),
      JSON.stringify({ schemaVersion: 2, updatedAt: 'x', jobs: [] }),
      'utf8',
    );
    expect(listJobs().map((j) => j.id)).toEqual(['1', '2']);
  });

  it('an async call satisfies the guard — the lazy read never overwrites fresher async state', async () => {
    await seedDisk();
    const fresh = await listJobsAsync();               // hydrates + marks
    expect(fresh.map((j) => j.id)).toEqual(['1', '2']);
    expect(listJobs().map((j) => j.id)).toEqual(['1', '2']);  // no second disk read
  });
});
