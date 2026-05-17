/**
 * v4.5 Phase 6 — `aiden runs` CLI tests.
 *
 * Covers list / show / interrupt / stats. Tests use AIDEN_HOME
 * override so each case gets a fresh daemon db at a temp path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRunsSubcommand } from '../../../cli/v4/commands/runs';
import {
  openDaemonDb,
  daemonDbPath,
  createRunStore,
} from '../../../core/v4/daemon';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-cli-runs-'));
  prev = { AIDEN_HOME: process.env.AIDEN_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
});
afterEach(() => {
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

function seedRuns(): { db: ReturnType<typeof openDaemonDb>; runStore: ReturnType<typeof createRunStore>; ids: number[] } {
  const db = openDaemonDb(daemonDbPath(aidenHome));
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-runs', 1, 'h', Date.now(), Date.now(), '4.5.0');
  const runStore = createRunStore({ db });
  const ids: number[] = [];
  ids.push(runStore.create({ sessionId: 'trigger:file:wat-1:abc', instanceId: 'inst-runs', status: 'running' }));
  ids.push(runStore.create({ sessionId: 'trigger:webhook:wh-1:def', instanceId: 'inst-runs', status: 'running' }));
  runStore.setStatus(ids[0], 'completed', { finishReason: 'stop' });
  runStore.setStatus(ids[1], 'failed', { finishReason: 'tool_loop' });
  runStore.emitEvent(ids[0], 'dispatcher:invoked', { source: 'file', triggerId: 'wat-1' });
  return { db, runStore, ids };
}

describe('runRunsSubcommand — list', () => {
  it('lists recent runs with status + sessionId columns', async () => {
    seedRuns();
    const o = out();
    const code = await runRunsSubcommand('list', [], {}, { writeOut: o.write });
    expect(code).toBe(0);
    const text = o.lines.join('');
    expect(text).toMatch(/runId/);
    expect(text).toMatch(/completed/);
    expect(text).toMatch(/failed/);
    expect(text).toMatch(/2 runs shown/);
  });

  it('filters by --status', async () => {
    seedRuns();
    const o = out();
    await runRunsSubcommand('list', [], { status: 'completed' }, { writeOut: o.write });
    const text = o.lines.join('');
    expect(text).toMatch(/completed/);
    expect(text).not.toMatch(/failed/);
  });

  it('--trigger filters by sessionId prefix', async () => {
    seedRuns();
    const o = out();
    await runRunsSubcommand('list', [], { trigger: 'trigger:webhook:' }, { writeOut: o.write });
    const text = o.lines.join('');
    expect(text).toMatch(/1 run/);
    expect(text).toMatch(/failed/);
  });
});

describe('runRunsSubcommand — show', () => {
  it('returns JSON with run + events', async () => {
    const { ids } = seedRuns();
    const o = out();
    const code = await runRunsSubcommand('show', [String(ids[0])], {}, { writeOut: o.write });
    expect(code).toBe(0);
    const parsed = JSON.parse(o.lines.join(''));
    expect(parsed.run.id).toBe(ids[0]);
    expect(parsed.events).toBeInstanceOf(Array);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.events[0].kind).toBe('dispatcher:invoked');
  });

  it('returns 1 for unknown runId', async () => {
    seedRuns();
    const e = out();
    const code = await runRunsSubcommand('show', ['999999'], {}, { writeErr: e.write });
    expect(code).toBe(1);
  });

  it('returns 2 for non-numeric runId', async () => {
    seedRuns();
    const e = out();
    const code = await runRunsSubcommand('show', ['lol'], {}, { writeErr: e.write });
    expect(code).toBe(2);
  });
});

describe('runRunsSubcommand — interrupt', () => {
  it('writes a marker file at ~/.aiden/daemon/interrupt/<runId>.req', async () => {
    seedRuns();
    const o = out();
    const code = await runRunsSubcommand('interrupt', ['42'], {}, { writeOut: o.write });
    expect(code).toBe(0);
    const markerPath = path.join(aidenHome, 'daemon', 'interrupt', '42.req');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(marker.runId).toBe(42);
    expect(marker.requestedAt).toBeGreaterThan(0);
  });

  it('rejects non-numeric runId', async () => {
    seedRuns();
    const e = out();
    const code = await runRunsSubcommand('interrupt', ['nope'], {}, { writeErr: e.write });
    expect(code).toBe(2);
  });
});

describe('runRunsSubcommand — stats', () => {
  it('prints status counts + duration aggregate', async () => {
    seedRuns();
    const o = out();
    const code = await runRunsSubcommand('stats', [], {}, { writeOut: o.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/Run status counts/);
    expect(o.lines.join('')).toMatch(/completed/);
    expect(o.lines.join('')).toMatch(/failed/);
  });
});
