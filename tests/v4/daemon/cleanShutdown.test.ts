/**
 * v4.5 Phase 1 — cleanShutdown + crash detection tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  touchCleanShutdownMarker,
  isCleanShutdown,
  consumeCleanShutdownMarker,
  evaluateBootState,
} from '../../../core/v4/daemon/cleanShutdown';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

let db: Database.Database;
let tmpDir: string;
let markerPath: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-clean-'));
  markerPath = path.join(tmpDir, '.clean_shutdown');
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('marker file helpers', () => {
  it('touch + isCleanShutdown + consume round-trip', () => {
    expect(isCleanShutdown(markerPath)).toBe(false);
    touchCleanShutdownMarker(markerPath);
    expect(isCleanShutdown(markerPath)).toBe(true);
    expect(consumeCleanShutdownMarker(markerPath)).toBe(true);
    expect(isCleanShutdown(markerPath)).toBe(false);
    expect(consumeCleanShutdownMarker(markerPath)).toBe(false);
  });
});

describe('evaluateBootState', () => {
  it('marker present → cleanShutdown:true', () => {
    touchCleanShutdownMarker(markerPath);
    const r = evaluateBootState({ db, markerPath, instanceId: 'new' });
    expect(r.cleanShutdown).toBe(true);
    expect(r.suspendActiveSessions).toBe(false);
    expect(r.crashDetected).toBe(false);
    // Marker consumed.
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('no marker, no prior instances → dirty boot but no crash detected', () => {
    const r = evaluateBootState({ db, markerPath, instanceId: 'new' });
    expect(r.cleanShutdown).toBe(false);
    expect(r.crashDetected).toBe(false);
  });

  it('no marker + stale prior instance → crash detected', () => {
    // Insert the BOOTING instance first (production flow: instance tracker
    // writes its row before evaluateBootState runs so crash_reports
    // FK can resolve).
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('new', process.pid, 'test', Date.now(), Date.now(), 'test');
    // Insert a prior instance whose heartbeat is older than the cutoff.
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('crashed', 99999, 'test', Date.now() - 60_000, Date.now() - 60_000, 'test');
    // And an active run for that instance.
    db.prepare(
      `INSERT INTO runs
         (session_id, instance_id, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    ).run('sess-A', 'crashed', Date.now() - 30_000);
    const r = evaluateBootState({ db, markerPath, instanceId: 'new' });
    expect(r.crashDetected).toBe(true);
    expect(r.cleanShutdown).toBe(false);
    expect(r.suspendActiveSessions).toBe(true);
    // crash_reports row written.
    const cr = db.prepare('SELECT * FROM crash_reports').all() as Array<{ instance_id: string; affected_sessions: string }>;
    expect(cr.length).toBe(1);
    expect(cr[0].instance_id).toBe('new');
    expect(JSON.parse(cr[0].affected_sessions)).toEqual(['sess-A']);
    // crashed instance marked.
    const inst = db.prepare('SELECT shutdown_reason, shutdown_at FROM daemon_instances WHERE instance_id = ?').get('crashed') as { shutdown_reason: string; shutdown_at: number };
    expect(inst.shutdown_reason).toBe('crash');
    expect(inst.shutdown_at).toBeGreaterThan(0);
    // run flipped to interrupted with resume_pending=1.
    const run = db.prepare("SELECT status, resume_pending, resume_reason FROM runs WHERE session_id = 'sess-A'").get() as { status: string; resume_pending: number; resume_reason: string };
    expect(run.status).toBe('interrupted');
    expect(run.resume_pending).toBe(1);
    expect(run.resume_reason).toBe('crash_recovery');
  });

  it('does not touch the booting instance row', () => {
    // Newly-inserted current instance with a fresh heartbeat — should
    // NOT show up as crashed.
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('new', process.pid, 'test', Date.now(), Date.now(), 'test');
    const r = evaluateBootState({ db, markerPath, instanceId: 'new' });
    expect(r.crashDetected).toBe(false);
  });

  it('leaves Job-managed Attempts for the lease recovery authority', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('new', ?, 'test', ?, ?, 'test')`,
    ).run(process.pid, now, now);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('crashed', 99999, 'test', ?, ?, 'test')`,
    ).run(now - 60_000, now - 60_000);
    const engine = createJobEngine({ db });
    const admitted = engine.submitJob({
      entryPoint: 'daemon', source: 'test', sessionId: 'durable-session',
      instanceId: 'crashed', idempotencyNamespace: 'durable-test',
      idempotencyKey: 'durable-job', requestFingerprint: 'durable-fingerprint',
      goal: 'recover through lease authority',
    });
    db.prepare("UPDATE runs SET status = 'running' WHERE attempt_id = ?").run(admitted.attemptId);

    expect(evaluateBootState({ db, markerPath, instanceId: 'new' }).crashDetected).toBe(true);
    expect(engine.getAttempt(admitted.attemptId)?.status).toBe('running');
    expect(engine.getJob(admitted.jobId)?.status).toBe('queued');
  });
});
