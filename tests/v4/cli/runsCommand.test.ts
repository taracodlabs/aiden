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
    // v4.8.0 Slice 3 — count moved from a trailing "N runs shown"
    // line into the framed table's title-border totalCount field.
    expect(text).toMatch(/\b2 runs\b/);
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

// ── v4.6 Phase 2Q-B — children filter + badge ────────────────────────────

/**
 * Seed one top-level parent run with 3 children: 2 completed, 1 failed.
 * Returns the parent run id so tests can assert.
 */
function seedParentWithChildren(): { db: ReturnType<typeof openDaemonDb>; parentId: number } {
  const db = openDaemonDb(daemonDbPath(aidenHome));
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-2qb', 1, 'h', Date.now(), Date.now(), '4.6.0');
  const runStore = createRunStore({ db });
  // Top-level parent (no spawned_from_*).
  const parentId = runStore.create({
    sessionId:  'repl-parent-2qb',
    instanceId: 'inst-2qb',
    status:     'running',
  });
  // Three children linked to parent.
  const c1 = runStore.create({
    sessionId:            'child-1',
    instanceId:           'inst-2qb',
    status:               'running',
    spawnedFromRunId:     parentId,
    spawnedFromSessionId: 'repl-parent-2qb',
  });
  const c2 = runStore.create({
    sessionId:            'child-2',
    instanceId:           'inst-2qb',
    status:               'running',
    spawnedFromRunId:     parentId,
    spawnedFromSessionId: 'repl-parent-2qb',
  });
  const c3 = runStore.create({
    sessionId:            'child-3',
    instanceId:           'inst-2qb',
    status:               'running',
    spawnedFromRunId:     parentId,
    spawnedFromSessionId: 'repl-parent-2qb',
  });
  runStore.setStatus(parentId, 'completed', { finishReason: 'stop' });
  runStore.setStatus(c1, 'completed', { finishReason: 'completed' });
  runStore.setStatus(c2, 'completed', { finishReason: 'completed' });
  runStore.setStatus(c3, 'failed',    { finishReason: 'error' });
  return { db, parentId };
}

describe('runRunsSubcommand — list (v4.6 Phase 2Q-B child filter + badge)', () => {
  it('default list hides children — only the top-level parent appears', async () => {
    seedParentWithChildren();
    const o = out();
    const code = await runRunsSubcommand('list', [], {}, { writeOut: o.write });
    expect(code).toBe(0);
    const text = o.lines.join('');
    // Exactly one row (the parent); the 3 children are filtered at SQL.
    expect(text).toMatch(/\b1 run\b/);
    // The parent's session id appears; child sessionIds do not.
    expect(text).toMatch(/repl-parent-2qb/);
    expect(text).not.toMatch(/child-1/);
    expect(text).not.toMatch(/child-2/);
    expect(text).not.toMatch(/child-3/);
  });

  it('default list renders child-count badge with completed count', async () => {
    seedParentWithChildren();
    const o = out();
    await runRunsSubcommand('list', [], {}, { writeOut: o.write });
    const text = o.lines.join('');
    // 3 children total, 2 completed.
    expect(text).toMatch(/\(3 children, 2 OK\)/);
  });

  it('--include-children flips the filter — children appear inline', async () => {
    seedParentWithChildren();
    const o = out();
    const code = await runRunsSubcommand('list', [], { includeChildren: true }, { writeOut: o.write });
    expect(code).toBe(0);
    const text = o.lines.join('');
    // 4 rows total: 1 parent + 3 children.
    expect(text).toMatch(/\b4 runs\b/);
    expect(text).toMatch(/child-1/);
    expect(text).toMatch(/child-2/);
    expect(text).toMatch(/child-3/);
    expect(text).toMatch(/repl-parent-2qb/);
    // No badges in flat view (children are inline rows already).
    expect(text).not.toMatch(/\(3 children/);
  });

  it('top-level row with no children shows no badge', async () => {
    seedRuns();  // two top-level rows, no children
    const o = out();
    await runRunsSubcommand('list', [], {}, { writeOut: o.write });
    const text = o.lines.join('');
    // v4.8.0 Slice 3 — count moved from a trailing "N runs shown"
    // line into the framed table's title-border totalCount field.
    expect(text).toMatch(/\b2 runs\b/);
    // Neither row gets a "(N children)" suffix.
    expect(text).not.toMatch(/\(\d+ child/);
  });

  it('singular noun when child_count === 1', async () => {
    const db = openDaemonDb(daemonDbPath(aidenHome));
    db.prepare(`INSERT INTO daemon_instances
      (instance_id, pid, hostname, started_at, last_heartbeat, version)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inst-2qb-s', 1, 'h', Date.now(), Date.now(), '4.6.0');
    const runStore = createRunStore({ db });
    const pid = runStore.create({ sessionId: 'p-singular', instanceId: 'inst-2qb-s', status: 'running' });
    runStore.create({
      sessionId: 'only-child', instanceId: 'inst-2qb-s', status: 'completed',
      spawnedFromRunId: pid, spawnedFromSessionId: 'p-singular',
    });
    runStore.setStatus(pid, 'completed', { finishReason: 'stop' });
    runStore.setStatus(2,   'completed', { finishReason: 'completed' });
    const o = out();
    await runRunsSubcommand('list', [], {}, { writeOut: o.write });
    const text = o.lines.join('');
    expect(text).toMatch(/\(1 child, 1 OK\)/);
    expect(text).not.toMatch(/1 children/);
  });
});

describe('runStore.countChildren (v4.6 Phase 2Q-B)', () => {
  it('returns { total, completed } for a parent with mixed-status children', () => {
    const { db, parentId } = seedParentWithChildren();
    const runStore = createRunStore({ db });
    const counts = runStore.countChildren(parentId);
    expect(counts.total).toBe(3);
    expect(counts.completed).toBe(2);
  });

  it('returns zeros when no children link back', () => {
    const db = openDaemonDb(daemonDbPath(aidenHome));
    db.prepare(`INSERT INTO daemon_instances
      (instance_id, pid, hostname, started_at, last_heartbeat, version)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inst-2qb-z', 1, 'h', Date.now(), Date.now(), '4.6.0');
    const runStore = createRunStore({ db });
    const id = runStore.create({ sessionId: 'lonely', instanceId: 'inst-2qb-z' });
    const counts = runStore.countChildren(id);
    expect(counts.total).toBe(0);
    expect(counts.completed).toBe(0);
  });
});
