/**
 * v4.5 Phase 6 — `aiden trigger logs` and `aiden trigger runs` tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTriggerSubcommand } from '../../../cli/v4/commands/trigger';
import {
  daemonDbPath,
  openDaemonDb,
  createRunStore,
} from '../../../core/v4/daemon';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-trig-logs-'));
  prev = { AIDEN_HOME: process.env.AIDEN_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.AIDEN_HOME  = aidenHome;
  process.env.HOME        = aidenHome;
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

function seedTrigger(): { id: string; runId: number } {
  const db = openDaemonDb(daemonDbPath(aidenHome));
  db.prepare(`INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
              VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.5.0');
  const triggerId = 'wat-test-1';
  db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
              VALUES (?, 'file', ?, '{}', 1, NULL, 0, ?, ?)`)
    .run(triggerId, 'mywatcher', Date.now(), Date.now());
  const runStore = createRunStore({ db });
  const sessionId = `trigger:file:${triggerId}:abc123`;
  const runId = runStore.create({ sessionId, instanceId: 'inst-1', status: 'running' });
  runStore.emitEvent(runId, 'dispatcher:invoked', { source: 'file', triggerId });
  runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
  return { id: triggerId, runId };
}

describe('runTriggerSubcommand — logs', () => {
  it('prints recent run events for a known trigger', async () => {
    const { id } = seedTrigger();
    const o = out();
    const code = await runTriggerSubcommand('logs', [id], {}, { writeOut: o.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/dispatcher:invoked/);
    expect(o.lines.join('')).toMatch(/Last 1 event/);
  });

  it('reports no events when trigger has none', async () => {
    const db = openDaemonDb(daemonDbPath(aidenHome));
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES ('empty-trig', 'file', 'empty', '{}', 1, NULL, 0, ?, ?)`)
      .run(Date.now(), Date.now());
    const o = out();
    const code = await runTriggerSubcommand('logs', ['empty-trig'], {}, { writeOut: o.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/No run events/);
  });

  it('returns 1 when trigger id unknown', async () => {
    const e = out();
    const code = await runTriggerSubcommand('logs', ['ghost-id'], {}, { writeErr: e.write });
    expect(code).toBe(1);
  });
});

describe('runTriggerSubcommand — runs', () => {
  it('lists runs that originated from this trigger', async () => {
    const { id, runId } = seedTrigger();
    const o = out();
    const code = await runTriggerSubcommand('runs', [id], {}, { writeOut: o.write });
    expect(code).toBe(0);
    const text = o.lines.join('');
    expect(text).toMatch(new RegExp(`${runId}\\s+completed`));
    expect(text).toMatch(/1 run for trigger/);
  });
});
