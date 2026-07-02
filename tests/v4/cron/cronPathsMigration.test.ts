/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 — cron-root unification + one-time legacy migration.
 *
 * defaultCronPaths' fallback previously hardcoded `~/.aiden`, which had
 * drifted from the product-wide platform root (resolveAidenRoot) — cron
 * jobs lived in a different directory than every other Aiden artifact on
 * Windows/macOS. Covers:
 *
 *   - fresh install (no legacy)      → platform root, nothing migrated
 *   - legacy present, dest absent    → state + cron-logs copied ONCE,
 *                                      one stderr migration line
 *   - both present                   → platform wins, never overwritten
 *   - legacy root == platform root   → no-op (Linux legacy-preferred)
 *   - AIDEN_HOME set                 → root is AIDEN_HOME, NO migration
 *   - homeOverride                   → wins over everything, NO migration
 *
 * All fs side effects are confined to temp dirs via the explicit
 * platformRoot/legacyRoot test seams — the suite never touches the real
 * home dir or platform root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  defaultCronPaths,
  maybeMigrateLegacyCronState,
} from '../../../core/v4/cron/cronState';
import { resolveAidenRoot } from '../../../core/v4/paths';

let tmp: string;
let legacyRoot: string;
let platformRoot: string;
const SAVED_AIDEN_HOME = process.env.AIDEN_HOME;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cron-mig-'));
  legacyRoot = path.join(tmp, 'legacy-home', '.aiden');
  platformRoot = path.join(tmp, 'platform', 'aiden');
  delete process.env.AIDEN_HOME;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (SAVED_AIDEN_HOME === undefined) delete process.env.AIDEN_HOME;
  else process.env.AIDEN_HOME = SAVED_AIDEN_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedLegacy(): Promise<string> {
  await fs.mkdir(legacyRoot, { recursive: true });
  const content = JSON.stringify({ schemaVersion: 2, updatedAt: 'x', jobs: [{ id: 'legacy-job' }] });
  await fs.writeFile(path.join(legacyRoot, 'cron_jobs.json'), content, 'utf8');
  await fs.mkdir(path.join(legacyRoot, 'cron-logs'), { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'cron-logs', 'job1.log'), 'log line\n', 'utf8');
  return content;
}

describe('defaultCronPaths — root selection', () => {
  it('fresh install (no legacy): resolves under the platform root, nothing created', () => {
    const p = defaultCronPaths(undefined, { platformRoot, legacyRoot });
    expect(p.stateFile).toBe(path.join(platformRoot, 'cron_jobs.json'));
    expect(p.lockFile).toBe(path.join(platformRoot, 'cron_jobs.json.lock'));
    expect(p.logsDir).toBe(path.join(platformRoot, 'cron-logs'));
    // No migration fired — neither dir was created.
    expect(existsSync(platformRoot)).toBe(false);
  });

  it('production default (no seams): platform root IS resolveAidenRoot()', () => {
    // Equality against the one resolver — the unification contract. Use a
    // temp AIDEN_HOME so the real machine root (and any real legacy state)
    // is never involved.
    process.env.AIDEN_HOME = path.join(tmp, 'env-home');
    const p = defaultCronPaths();
    expect(p.stateFile).toBe(path.join(resolveAidenRoot(), 'cron_jobs.json'));
  });

  it('AIDEN_HOME set: root is AIDEN_HOME directly and NO migration runs even with legacy present', async () => {
    await seedLegacy();
    const envHome = path.join(tmp, 'env-home');
    process.env.AIDEN_HOME = envHome;
    const p = defaultCronPaths(undefined, { platformRoot, legacyRoot });
    expect(p.stateFile).toBe(path.join(path.resolve(envHome), 'cron_jobs.json'));
    // Migration skipped: nothing landed in the platform root.
    expect(existsSync(path.join(platformRoot, 'cron_jobs.json'))).toBe(false);
  });

  it('homeOverride wins over AIDEN_HOME and platform root, NO migration', async () => {
    await seedLegacy();
    process.env.AIDEN_HOME = path.join(tmp, 'env-home');
    const over = path.join(tmp, 'override');
    const p = defaultCronPaths(over, { platformRoot, legacyRoot });
    expect(p.stateFile).toBe(path.join(over, 'cron_jobs.json'));
    expect(existsSync(path.join(platformRoot, 'cron_jobs.json'))).toBe(false);
  });
});

describe('maybeMigrateLegacyCronState — one-time legacy copy', () => {
  it('legacy present, dest absent: copies state + cron-logs and logs ONE stderr line', async () => {
    const legacyContent = await seedLegacy();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    maybeMigrateLegacyCronState(platformRoot, legacyRoot);

    const dest = path.join(platformRoot, 'cron_jobs.json');
    expect(existsSync(dest)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe(legacyContent);
    expect(await fs.readFile(path.join(platformRoot, 'cron-logs', 'job1.log'), 'utf8')).toBe('log line\n');
    // Legacy left in place — copy, not move.
    expect(existsSync(path.join(legacyRoot, 'cron_jobs.json'))).toBe(true);
    const migLines = errSpy.mock.calls.map((c) => String(c[0])).filter((s) => /migrated cron state/.test(s));
    expect(migLines.length).toBe(1);
  });

  it('runs once: a second invocation is a no-op (dest exists) and logs nothing', async () => {
    await seedLegacy();
    maybeMigrateLegacyCronState(platformRoot, legacyRoot);
    // Mutate the dest to prove the second run doesn't touch it.
    const dest = path.join(platformRoot, 'cron_jobs.json');
    await fs.writeFile(dest, '{"schemaVersion":2,"updatedAt":"y","jobs":[]}', 'utf8');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    maybeMigrateLegacyCronState(platformRoot, legacyRoot);

    expect(await fs.readFile(dest, 'utf8')).toBe('{"schemaVersion":2,"updatedAt":"y","jobs":[]}');
    expect(errSpy.mock.calls.filter((c) => /migrated cron state/.test(String(c[0]))).length).toBe(0);
  });

  it('both present: platform root wins, legacy never overwrites it', async () => {
    await seedLegacy();
    await fs.mkdir(platformRoot, { recursive: true });
    const platformContent = '{"schemaVersion":2,"updatedAt":"p","jobs":[{"id":"platform-job"}]}';
    await fs.writeFile(path.join(platformRoot, 'cron_jobs.json'), platformContent, 'utf8');

    maybeMigrateLegacyCronState(platformRoot, legacyRoot);

    expect(await fs.readFile(path.join(platformRoot, 'cron_jobs.json'), 'utf8')).toBe(platformContent);
    // Logs weren't copied either — the state check gates the whole migration.
    expect(existsSync(path.join(platformRoot, 'cron-logs'))).toBe(false);
  });

  it('legacy root IS the platform root: no-op, no throw (Linux legacy-preferred installs)', async () => {
    await seedLegacy();
    expect(() => maybeMigrateLegacyCronState(legacyRoot, legacyRoot)).not.toThrow();
  });

  it('fresh install (no legacy state file): no-op, nothing created', () => {
    maybeMigrateLegacyCronState(platformRoot, legacyRoot);
    expect(existsSync(platformRoot)).toBe(false);
  });
});
