/**
 * v4.5 Phase 6 — `aiden cron` top-level CLI tests.
 *
 * Distinct from `cronCommand.test.ts` (which covers the legacy
 * slash-command surface). This file targets the new
 * `runCronSubcommand` export added in Phase 6.
 *
 * Covers add/list/show/remove/enable/disable. The `run` subcommand
 * is covered indirectly via cronManager's own tests; we just smoke
 * that runCronSubcommand wires through correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCronSubcommand } from '../../../cli/v4/commands/cron';
import {
  __resetForTests as cmReset,
  setCronPathsForTests,
  loadJobs,
} from '../../../core/v4/cron/cronManager';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(async () => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-cli-cron2-'));
  prev = {
    AIDEN_HOME:  process.env.AIDEN_HOME,
    HOME:        process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.AIDEN_HOME  = aidenHome;
  process.env.HOME        = aidenHome;
  process.env.USERPROFILE = aidenHome;
  // Reset cronManager state BEFORE applying test paths so the cache
  // doesn't carry rows over from previous tests.
  cmReset();
  setCronPathsForTests({
    stateFile: path.join(aidenHome, 'cron_jobs.json'),
    lockFile:  path.join(aidenHome, 'cron_jobs.json.lock'),
    logsDir:   path.join(aidenHome, 'cron-logs'),
  });
  // Reload from the (empty) state file — clears the sync cache.
  await loadJobs();
});
afterEach(() => {
  cmReset();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function out(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => { lines.push(s); } };
}

describe('runCronSubcommand — add', () => {
  it('add writes a CronJobV2 row + reports the assigned id', async () => {
    const o = out(); const e = out();
    const code = await runCronSubcommand(
      'add', [],
      { label: 'morning-brief', schedule: '0 9 * * *', command: 'echo hi' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/cron added:/);
    const raw = JSON.parse(fs.readFileSync(path.join(aidenHome, 'cron_jobs.json'), 'utf-8'));
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0].description).toBe('morning-brief');
  });

  it('v4.12.1 REGRESSION: tolerates a Commander Command as argv (its .name is a METHOD, not the label)', async () => {
    // The real CLI wiring passed the raw Command object, whose `.name`
    // is a function — `a.name ?? a.label` short-circuited to it and
    // `aiden cron add` always failed "label is required". Both layers
    // are fixed (caller passes .opts(); handler ignores non-strings);
    // this pins the handler-side defense.
    const o = out(); const e = out();
    const commandLike = {
      name:     () => 'cron',          // Commander method, NOT an option
      label:    'from-commander',
      schedule: 'every 1h',
      command:  'echo hi',
    };
    const code = await runCronSubcommand(
      'add', [], commandLike as never,
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(aidenHome, 'cron_jobs.json'), 'utf-8'));
    expect(raw.jobs.map((j: { description: string }) => j.description)).toContain('from-commander');
  });

  it('rejects when --label missing', async () => {
    const o = out(); const e = out();
    const code = await runCronSubcommand('add', [], { schedule: '0 9 * * *', command: 'echo' }, { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/label is required/i);
  });

  it('rejects when --schedule missing', async () => {
    const o = out(); const e = out();
    const code = await runCronSubcommand('add', [], { label: 'x', command: 'echo' }, { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/schedule is required/i);
  });

  it('rejects when --command missing', async () => {
    const o = out(); const e = out();
    const code = await runCronSubcommand('add', [], { label: 'x', schedule: '0 9 * * *' }, { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/command is required/i);
  });

  it('rejects invalid --misfire-policy', async () => {
    const o = out(); const e = out();
    const code = await runCronSubcommand(
      'add', [],
      { label: 'x', schedule: '0 9 * * *', command: 'echo', misfirePolicy: 'wat' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/invalid --misfire-policy/i);
  });
});

describe('runCronSubcommand — CLI mutations persist BEFORE the handler resolves (v4.12.1)', () => {
  // The sync cronManager mutators persist in a fire-and-forget background
  // IIFE — fine in a long-lived REPL, but a one-shot CLI process exits
  // right after the handler returns, killing the write (`cron remove`
  // printed success while the job survived on disk). The handlers now
  // await the *Async variants; the disk must reflect the mutation the
  // moment runCronSubcommand resolves — asserted here with an immediate
  // synchronous read, NO polling.
  function diskJobs(): Array<{ id: string; enabled: boolean }> {
    return JSON.parse(fs.readFileSync(path.join(aidenHome, 'cron_jobs.json'), 'utf-8')).jobs;
  }

  it('remove: job is gone from disk immediately on resolve', async () => {
    const oa = out();
    await runCronSubcommand('add', [], { label: 'gone', schedule: 'every 1m', command: 'echo' }, { writeOut: oa.write });
    const id = oa.lines.join('').match(/cron added:\s+(\S+)/)![1];
    expect(await runCronSubcommand('remove', [id], {}, { writeOut: out().write })).toBe(0);
    expect(diskJobs().find((j) => j.id === id)).toBeUndefined();
  });

  it('disable/enable: enabled flag flips on disk immediately on resolve', async () => {
    const oa = out();
    await runCronSubcommand('add', [], { label: 'flip', schedule: 'every 1m', command: 'echo' }, { writeOut: oa.write });
    const id = oa.lines.join('').match(/cron added:\s+(\S+)/)![1];
    expect(await runCronSubcommand('disable', [id], {}, { writeOut: out().write })).toBe(0);
    expect(diskJobs().find((j) => j.id === id)?.enabled).toBe(false);
    expect(await runCronSubcommand('enable', [id], {}, { writeOut: out().write })).toBe(0);
    expect(diskJobs().find((j) => j.id === id)?.enabled).toBe(true);
  });
});

describe('runCronSubcommand — list/show/enable/disable/remove', () => {
  it('list shows the added job + remove deletes it', async () => {
    const oa = out();
    await runCronSubcommand(
      'add', [],
      { label: 'job1', schedule: 'every 5m', command: 'echo' },
      { writeOut: oa.write },
    );
    const ol = out();
    await runCronSubcommand('list', [], {}, { writeOut: ol.write });
    expect(ol.lines.join('')).toMatch(/job1/);
    expect(ol.lines.join('')).toMatch(/1 job/);

    const m = oa.lines.join('').match(/cron added:\s+(\S+)\s+\(/);
    expect(m).not.toBeNull();
    const id = m![1];

    const orem = out();
    const code = await runCronSubcommand('remove', [id], {}, { writeOut: orem.write });
    expect(code).toBe(0);
    expect(orem.lines.join('')).toMatch(/cron removed/);
  });

  it('show prints jsonView + sqlView', async () => {
    const oa = out();
    await runCronSubcommand('add', [], { label: 'jshow', schedule: 'every 1m', command: 'echo' }, { writeOut: oa.write });
    const id = oa.lines.join('').match(/cron added:\s+(\S+)/)![1];
    const os2 = out();
    const code = await runCronSubcommand('show', [id], {}, { writeOut: os2.write });
    expect(code).toBe(0);
    const parsed = JSON.parse(os2.lines.join(''));
    expect(parsed.jsonView.description).toBe('jshow');
    expect(parsed).toHaveProperty('sqlView');
  });

  it('disable/enable updates the JSON state', async () => {
    const oa = out();
    await runCronSubcommand('add', [], { label: 'jen', schedule: 'every 1m', command: 'echo' }, { writeOut: oa.write });
    const id = oa.lines.join('').match(/cron added:\s+(\S+)/)![1];
    const od = out();
    expect(await runCronSubcommand('disable', [id], {}, { writeOut: od.write })).toBe(0);
    const oe = out();
    expect(await runCronSubcommand('enable', [id], {}, { writeOut: oe.write })).toBe(0);
    expect(od.lines.join('')).toMatch(/cron disabled/);
    expect(oe.lines.join('')).toMatch(/cron enabled/);
  });

  it('returns 1 when remove targets a missing id', async () => {
    const e = out();
    const code = await runCronSubcommand('remove', ['nonexistent-id'], {}, { writeErr: e.write });
    expect(code).toBe(1);
    expect(e.lines.join('')).toMatch(/not found/);
  });
});

describe('runCronSubcommand — unknown action', () => {
  it('returns 2 + lists valid actions', async () => {
    const e = out();
    const code = await runCronSubcommand('garbage', [], {}, { writeErr: e.write });
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/add.*list.*show.*remove/);
  });
});
