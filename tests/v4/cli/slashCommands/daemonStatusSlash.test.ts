/**
 * v4.5 Phase 8a — /daemon status slash command tests.
 *
 * Read-only smoke tests covering: disabled-daemon output, running-
 * daemon output (with triggers + recent run + bus stats), unknown
 * subarg prints usage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonStatus } from '../../../../cli/v4/commands/daemonStatus';
import {
  daemonDbPath,
  openDaemonDb,
} from '../../../../core/v4/daemon';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-p8a-ds-'));
  prev = {
    AIDEN_HOME:        process.env.AIDEN_HOME,
    HOME:              process.env.HOME,
    USERPROFILE:       process.env.USERPROFILE,
    AIDEN_DAEMON_DAILY_BUDGET: process.env.AIDEN_DAEMON_DAILY_BUDGET,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  delete process.env.AIDEN_DAEMON_DAILY_BUDGET;
});
afterEach(() => {
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function mkCtx(args: string[]): SlashCommandContext & { _lines: string[]; _errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    args,
    rawArgs: args.join(' '),
    display: {
      write: (m: string) => { lines.push(m); },
      info: (m: string) => { lines.push(m); },
      dim:  (m: string) => { lines.push(m); },
      success: (m: string) => { lines.push(m); },
      warn: (m: string) => { lines.push(m); },
      printError: (m: string) => { errs.push(m); },
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
    _lines: lines,
    _errs: errs,
  } as SlashCommandContext & { _lines: string[]; _errs: string[] };
}

describe('/daemon status — disabled state', () => {
  it('prints disabled message when no daemon.db exists', async () => {
    const ctx = mkCtx(['status']);
    await daemonStatus.handler(ctx);
    const out = ctx._lines.join('');
    expect(out).toMatch(/Daemon: disabled/);
    expect(out).toMatch(/aiden daemon install/);
  });
});

describe('/daemon status — running daemon', () => {
  function seed(): { triggerId: string; runId: number } {
    // Pre-create the db + tables with the migrations runner.
    // Then mark a daemon_instance + write a runtime.lock pointing
    // at the current PID so liveness check passes.
    const db = openDaemonDb(daemonDbPath(aidenHome));
    runMigrations(db);
    const now = Date.now();
    const myPid = process.pid;
    db.prepare(`INSERT INTO daemon_instances
      (instance_id, pid, hostname, started_at, last_heartbeat, version)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inst-p8a-status', myPid, 'h', now - 60_000, now, '4.5.0');
    const triggerId = 'tr-1';
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, 'file', 'w', '{}', 1, NULL, 0, ?, ?)`)
      .run(triggerId, now, now);
    // Insert a run.
    const runRes = db.prepare(`INSERT INTO runs
      (session_id, instance_id, status, finish_reason, started_at, completed_at, resume_pending)
      VALUES (?, ?, 'completed', 'stop', ?, ?, 0)`).run('trigger:file:tr-1:abc', 'inst-p8a-status', now - 5000, now);
    // Insert a trigger_event.
    db.prepare(`INSERT INTO trigger_events
      (source, source_key, idempotency_key, payload_json, status, attempts, created_at, updated_at)
      VALUES ('file', ?, ?, '{}', 'done', 1, ?, ?)`).run(triggerId, 'idem', now, now);

    // Write runtime.lock referencing the current PID so the liveness
    // probe passes (we're pretending we're the daemon).
    const lockPath = path.join(aidenHome, 'daemon', 'runtime.lock');
    fs.writeFileSync(lockPath, `inst-p8a-status\n${myPid}\n4200\n`);
    return { triggerId, runId: Number(runRes.lastInsertRowid) };
  }

  it('shows running + port + uptime + trigger counts + recent runs + bus', async () => {
    seed();
    const ctx = mkCtx(['status']);
    await daemonStatus.handler(ctx);
    const out = ctx._lines.join('');
    expect(out).toMatch(/Daemon: running/);
    expect(out).toMatch(/port 4200/);
    expect(out).toMatch(/Triggers: 1 file/);
    expect(out).toMatch(/Recent runs/);
    expect(out).toMatch(/Bus: 0 pending · 0 claimed/);
  });

  it('omits Daily budget line when AIDEN_DAEMON_DAILY_BUDGET unset', async () => {
    seed();
    const ctx = mkCtx(['status']);
    await daemonStatus.handler(ctx);
    const out = ctx._lines.join('');
    expect(out).not.toMatch(/Daily budget/);
  });

  it('includes Daily budget line when AIDEN_DAEMON_DAILY_BUDGET set', async () => {
    process.env.AIDEN_DAEMON_DAILY_BUDGET = '50000';
    seed();
    const ctx = mkCtx(['status']);
    await daemonStatus.handler(ctx);
    const out = ctx._lines.join('');
    expect(out).toMatch(/Daily budget: 0 \/ 50000 tokens/);
  });
});

describe('/daemon — unknown subarg', () => {
  it('prints usage hint pointing at the top-level CLI', async () => {
    const ctx = mkCtx(['install']);
    await daemonStatus.handler(ctx);
    const errs = ctx._errs.join('');
    expect(errs).toMatch(/Usage: \/daemon status/);
    expect(errs).toMatch(/aiden daemon install/);
  });
});
